"""Main-branch CI job alert lifecycle reconciliation.

Every hard terminal failure opens (or refreshes) one alert keyed by the
Buildkite step key. Only a positively observed pass of that same logical job
in the same or a newer main build resolves it. Older builds that finish late
cannot overwrite a newer outcome.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Protocol

from alerting.commands import ScheduledCommand
from alerting.ports import Clock
from alerting.runtime import HandlerCompletion

INITIAL_LOOKBACK = timedelta(days=1)
SAFETY_OVERLAP = timedelta(minutes=30)
# The hourly backstop reconciles every main build finished in this window
# (plus active builds), so failures the two-minute poller's per-job window
# missed entirely still open alerts within an hour.
SWEEP_LOOKBACK = timedelta(hours=48)
FAILURE_STATES = frozenset({"failed", "failing", "broken", "timed_out"})
TRACKED_STATES = FAILURE_STATES | {"passed"}


@dataclass(frozen=True)
class MainCIJobObservation:
    """One hard terminal outcome from a command job on the main branch."""

    job_key: str
    job_id: str
    job_name: str
    job_url: str
    state: str
    finished_at: datetime
    build_id: str
    build_number: int
    build_url: str
    commit_sha: str

    def __post_init__(self) -> None:
        if self.finished_at.tzinfo is None:
            raise ValueError("finished_at must be timezone-aware")
        if self.state not in TRACKED_STATES:
            raise ValueError(f"untracked Main CI job state: {self.state}")

    @property
    def failed(self) -> bool:
        return self.state in FAILURE_STATES

    @property
    def order(self) -> tuple[int, datetime, str]:
        """Newer builds win even when an older build finishes later."""
        return (self.build_number, self.finished_at, self.job_id)


@dataclass(frozen=True)
class MainCIOpenAlertRef:
    """An open alert's job identity and the build where it last failed."""

    job_key: str
    build_number: int


@dataclass(frozen=True)
class MainCILatestBuildRef:
    """The newest finished main build the sweep can resolve alerts against."""

    build_number: int


@dataclass(frozen=True)
class MainCIJobAlert:
    """One open-or-resolved failure episode for a logical main CI job."""

    alert_id: int
    job_key: str
    job_name: str
    opened_at: datetime
    first_failure: MainCIJobObservation
    last_failure: MainCIJobObservation
    failure_count: int
    resolved_at: datetime | None = None
    resolution: MainCIJobObservation | None = None

    @property
    def status(self) -> str:
        return "resolved" if self.resolved_at is not None else "open"


def ordered_unique_observations(
    observations: list[MainCIJobObservation],
) -> list[MainCIJobObservation]:
    seen: set[str] = set()
    ordered: list[MainCIJobObservation] = []
    for observation in sorted(observations, key=lambda item: item.order):
        if observation.job_id in seen:
            continue
        seen.add(observation.job_id)
        ordered.append(observation)
    return ordered


class MainCIBuildkitePort(Protocol):
    def list_job_builds(
        self, *, observed_from: datetime, up_to: datetime
    ) -> list[dict[str, Any]]: ...


def _parse_datetime(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Buildkite finished_at must be timezone-aware")
    return parsed


def build_job_observations(build: dict[str, Any]) -> list[MainCIJobObservation]:
    """Map one build's embedded jobs into tracked terminal outcomes.

    Retried-out executions can come back from the Buildkite API without
    ``step_key``. Jobs that do carry one first contribute a per-build
    name → step-key map, and same-named executions missing the key inherit
    it, so every execution of a step shares the alert's job key.
    """
    jobs = build.get("jobs")
    if not isinstance(jobs, list):
        return []
    name_to_step_key: dict[str, str] = {}
    for job in jobs:
        if not isinstance(job, dict):
            continue
        name = str(job.get("name") or "").strip()
        step_key = str(job.get("step_key") or "").strip()
        if name and step_key and name not in name_to_step_key:
            name_to_step_key[name] = step_key
    build_id = str(build["id"])
    build_number = int(build["number"])
    build_url = str(build.get("web_url") or "")
    commit_sha = str(build.get("commit") or "")
    observations: list[MainCIJobObservation] = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        name = str(job.get("name") or "").strip()
        state = str(job.get("state") or "")
        finished_value = job.get("finished_at")
        if (
            not name
            or job.get("type") != "script"
            or bool(job.get("soft_failed"))
            or state not in TRACKED_STATES
            or finished_value is None
        ):
            continue
        finished_at = _parse_datetime(finished_value)
        job_id = str(job["id"])
        step_key = str(job.get("step_key") or "").strip() or name_to_step_key.get(
            name, ""
        )
        # Matrix expansions share a configured step key. Include the
        # rendered job name so one matrix cell cannot resolve another.
        job_key = f"step:{step_key}|name:{name}" if step_key else f"name:{name}"
        observations.append(
            MainCIJobObservation(
                job_key=job_key,
                job_id=job_id,
                job_name=name,
                job_url=str(job.get("web_url") or f"{build_url}#{job_id}"),
                state=state,
                finished_at=finished_at,
                build_id=build_id,
                build_number=build_number,
                build_url=build_url,
                commit_sha=commit_sha,
            )
        )
    return observations


class BuildkiteMainCISource:
    """Map recently active or finished main builds into terminal outcomes."""

    def __init__(self, buildkite: MainCIBuildkitePort) -> None:
        self._buildkite = buildkite

    def fetch_observations(
        self, *, start_time: datetime, end_time: datetime
    ) -> list[MainCIJobObservation]:
        builds = self._buildkite.list_job_builds(
            observed_from=start_time,
            up_to=end_time,
        )
        candidates = [
            observation
            for build in builds
            for observation in build_job_observations(build)
        ]
        observations = [
            observation
            for observation in candidates
            if start_time <= observation.finished_at <= end_time
        ]
        # Resolution lookahead: a retry pass can finish before the scan
        # window (a worker gap hides it while it is observable, and the
        # window then moves past its finished_at). When a job key's newest
        # in-window outcome is a failure but a fetched build holds a newer
        # passing execution of the same key, include that pass even though
        # it is outside the window. The commit-time order guard still
        # prevents this older-looking data from overwriting newer outcomes.
        newest_candidate: dict[str, MainCIJobObservation] = {}
        for observation in candidates:
            current = newest_candidate.get(observation.job_key)
            if current is None or observation.order > current.order:
                newest_candidate[observation.job_key] = observation
        newest_in_window: dict[str, MainCIJobObservation] = {}
        for observation in observations:
            current = newest_in_window.get(observation.job_key)
            if current is None or observation.order > current.order:
                newest_in_window[observation.job_key] = observation
        for job_key, in_window in newest_in_window.items():
            candidate = newest_candidate[job_key]
            if (
                in_window.failed
                and not candidate.failed
                and candidate.order > in_window.order
            ):
                observations.append(candidate)
        return ordered_unique_observations(observations)


class MainCISource(Protocol):
    def fetch_observations(
        self, *, start_time: datetime, end_time: datetime
    ) -> list[MainCIJobObservation]: ...


class MainCIStore(Protocol):
    def main_ci_scan_cursor(self) -> datetime | None: ...

    def commit_main_ci_scan(
        self,
        *,
        command: ScheduledCommand,
        observations: list[MainCIJobObservation],
        scanned_through: datetime,
        now: datetime,
    ) -> None:
        """Atomically reconcile outcomes, advance the cursor, and complete."""
        ...


class MainCIBackstopBuildPort(Protocol):
    def list_job_builds(
        self, *, observed_from: datetime, up_to: datetime
    ) -> list[dict[str, Any]]: ...

    def get_build(
        self, build_number: int, *, include_retried_jobs: bool
    ) -> dict[str, Any]: ...


class MainCIBackstopStore(MainCIStore, Protocol):
    def open_main_ci_alert_builds(self) -> list[MainCIOpenAlertRef]: ...

    def latest_finished_main_ci_build(self) -> MainCILatestBuildRef | None: ...


class MainCIBackstopHandler:
    """Hourly full sweep of recent main builds plus open-alert builds.

    Two parts per run:

    1. Wide sweep: every active main build and every main build finished in
       the last ``SWEEP_LOOKBACK`` hours is reconciled with no per-job
       finished_at window, so a failure the poller missed entirely (a job
       that failed long before its build finished, hidden by the per-job
       scan window) still opens an alert within an hour. The
       ``(build_number, finished_at, job_id)`` order guard in
       ``commit_main_ci_scan`` keeps newer data authoritative and makes
       reprocessing the same builds idempotent.
    2. Targeted re-check: each open alert's last-failure build is fetched
       directly, so a retry pass on a build older than the wide window
       still resolves its alert. The newest finished main build is fetched
       too: a fix merged after the failure makes the job pass there, and
       that newer pass resolves the alert even when the job's pass fell
       outside the sweep window (or the job no longer runs at all, in
       which case nothing changes and the alert stays open).

    The sweep never advances the poller's scan cursor: it only re-checks
    data, and moving the cursor could make the poller skip failures that
    fell into a gap.
    """

    def __init__(
        self,
        *,
        builds: MainCIBackstopBuildPort,
        store: MainCIBackstopStore,
        clock: Clock,
    ) -> None:
        self._builds = builds
        self._store = store
        self._clock = clock

    def __call__(self, command: ScheduledCommand) -> HandlerCompletion:
        sweep_builds = self._builds.list_job_builds(
            observed_from=command.target_time - SWEEP_LOOKBACK,
            up_to=command.target_time,
        )
        observations = [
            observation
            for build in sweep_builds
            for observation in build_job_observations(build)
        ]
        refs = self._store.open_main_ci_alert_builds()
        job_keys_by_build: dict[int, set[str]] = {}
        for ref in refs:
            job_keys_by_build.setdefault(ref.build_number, set()).add(ref.job_key)
        latest = self._store.latest_finished_main_ci_build()
        if latest is not None:
            for ref in refs:
                job_keys_by_build.setdefault(latest.build_number, set()).add(
                    ref.job_key
                )
        for build_number in sorted(job_keys_by_build):
            build = self._builds.get_build(
                build_number, include_retried_jobs=True
            )
            candidates = build_job_observations(build)
            for job_key in job_keys_by_build[build_number]:
                executions = [
                    candidate
                    for candidate in candidates
                    if candidate.job_key == job_key
                ]
                if executions:
                    observations.append(
                        max(executions, key=lambda item: item.order)
                    )
        # The sweep only re-checks known state; it must not advance the
        # poller's scan cursor, or a poller outage covered by the sweep would
        # skip failures that fell into the gap.
        cursor = self._store.main_ci_scan_cursor()
        self._store.commit_main_ci_scan(
            command=command,
            observations=observations,
            scanned_through=cursor if cursor is not None else command.target_time,
            now=self._clock.now(),
        )
        return HandlerCompletion.TRANSACTIONAL


class MainCIReconciliationHandler:
    """Poll a cursor window and reconcile exact job alert lifecycles."""

    def __init__(
        self, *, source: MainCISource, store: MainCIStore, clock: Clock
    ) -> None:
        self._source = source
        self._store = store
        self._clock = clock

    def __call__(self, command: ScheduledCommand) -> HandlerCompletion:
        cursor = self._store.main_ci_scan_cursor()
        if cursor is None:
            start_time = command.target_time - INITIAL_LOOKBACK
        elif command.target_time >= cursor:
            start_time = cursor - SAFETY_OVERLAP
        else:
            start_time = command.target_time - SAFETY_OVERLAP
        observations = self._source.fetch_observations(
            start_time=start_time,
            end_time=command.target_time,
        )
        self._store.commit_main_ci_scan(
            command=command,
            observations=observations,
            scanned_through=command.target_time,
            now=self._clock.now(),
        )
        return HandlerCompletion.TRANSACTIONAL
