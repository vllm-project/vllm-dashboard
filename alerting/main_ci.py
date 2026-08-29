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
        observations: list[MainCIJobObservation] = []
        for build in builds:
            build_id = str(build["id"])
            build_number = int(build["number"])
            build_url = str(build.get("web_url") or "")
            commit_sha = str(build.get("commit") or "")
            jobs = build.get("jobs")
            if not isinstance(jobs, list):
                continue
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
                if finished_at < start_time or finished_at > end_time:
                    continue
                job_id = str(job["id"])
                step_key = str(job.get("step_key") or "").strip()
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
