"""Full CI reconciliation command handler and durable record model."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol, cast

from alerting.commands import ScheduledCommand
from alerting.ports import Clock
from alerting.runtime import HandlerCompletion

# First-ever reconciliation has no durable run to anchor a fetch window; two
# days of runs is what an incident responder needs, not the pipeline's history.
INITIAL_LOOKBACK = timedelta(days=2)


@dataclass(frozen=True)
class FullCIJobOutcome:
    """One job outcome, identified across runs by its current job name."""

    name: str
    state: str
    soft_failed: bool


@dataclass(frozen=True)
class FullCIRun:
    """One scheduled Full CI Buildkite build and its observed jobs."""

    build_id: str
    build_number: int
    scheduled_at: datetime
    commit_sha: str
    message: str
    state: str
    jobs: tuple[FullCIJobOutcome, ...]


@dataclass(frozen=True)
class FullCIComparison:
    """A current Full CI run linked to its chronological predecessor."""

    previous_build_id: str
    current_build_id: str


@dataclass(frozen=True)
class FullCIReconciliationState:
    """Durable range and identities used to find every unprocessed run."""

    start_time: datetime | None
    processed_build_ids: frozenset[str]


def ordered_unique_runs(observations: list[FullCIRun]) -> list[FullCIRun]:
    seen: set[str] = set()
    runs: list[FullCIRun] = []
    for run in sorted(
        observations, key=lambda item: (item.scheduled_at, item.build_number)
    ):
        if run.build_id in seen:
            continue
        seen.add(run.build_id)
        runs.append(run)
    return runs


class FullCISource(Protocol):
    def fetch_runs(
        self,
        *,
        start_time: datetime | None,
        processed_build_ids: frozenset[str],
        up_to: datetime,
    ) -> list[FullCIRun]: ...


class BuildkitePort(Protocol):
    def list_builds(
        self, *, start_time: datetime | None, up_to: datetime
    ) -> list[dict[str, Any]]: ...

    def list_jobs(self, build_number: int) -> list[dict[str, Any]]: ...

    def get_build(self, build_number: int) -> dict[str, Any]:
        """The full build JSON, including job IDs for log lookups."""
        ...


def _iso8601(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("Buildkite query bounds must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_datetime(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Buildkite scheduled_at must be timezone-aware")
    return parsed


class BuildkiteRestClient:
    """Read-only Buildkite REST client for Full CI build and job pages."""

    _BUILDS_URL = "https://api.buildkite.com/v2/organizations/vllm/pipelines/ci/builds"

    def __init__(self, *, token: str) -> None:
        self._token = token

    def _get_json(self, url: str) -> Any:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "api.buildkite.com":
            raise RuntimeError("Buildkite pagination returned an untrusted URL")
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Accept": "application/json",
                "User-Agent": "vllm-ci-alerting/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            response_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"GET {parsed.path} failed with HTTP {exc.code}: {response_body[:1000]}"
            ) from exc

    def list_builds(
        self, *, start_time: datetime | None, up_to: datetime
    ) -> list[dict[str, Any]]:
        query: dict[str, str | int | list[str]] = {
            "branch": "main",
            "created_to": _iso8601(up_to),
            "exclude_jobs": "true",
            "per_page": 100,
        }
        if start_time is not None:
            query["created_from"] = _iso8601(start_time)
        return self._list_build_pages(query)

    def _list_build_pages(
        self, query: dict[str, str | int | list[str]]
    ) -> list[dict[str, Any]]:
        builds: list[dict[str, Any]] = []
        page = 1
        while True:
            query["page"] = page
            url = f"{self._BUILDS_URL}?{urllib.parse.urlencode(query, doseq=True)}"
            payload = self._get_json(url)
            if not isinstance(payload, list):
                raise RuntimeError("Buildkite builds response was not a list")
            rows = cast(list[dict[str, Any]], payload)
            builds.extend(rows)
            if len(rows) < 100:
                return builds
            page += 1

    def list_job_builds(
        self, *, observed_from: datetime, up_to: datetime
    ) -> list[dict[str, Any]]:
        """Return active plus recently finished main builds with embedded jobs.

        The two bounded queries avoid re-downloading days of large build
        matrices while still catching jobs from an older build that becomes
        terminal between polling ticks.
        """
        common: dict[str, str | int | list[str]] = {
            "branch": "main",
            "created_from": _iso8601(observed_from - timedelta(days=2)),
            "created_to": _iso8601(up_to),
            "include_retried_jobs": "false",
            "per_page": 100,
        }
        active = self._list_build_pages(
            {
                **common,
                "state": ["creating", "scheduled", "running", "failing", "canceling"],
            }
        )
        finished = self._list_build_pages(
            {
                **common,
                "state": "finished",
                "finished_from": _iso8601(observed_from),
            }
        )
        by_id: dict[str, dict[str, Any]] = {}
        for build in [*active, *finished]:
            by_id[str(build["id"])] = build
        return list(by_id.values())

    def list_jobs(self, build_number: int) -> list[dict[str, Any]]:
        url: str | None = (
            f"{self._BUILDS_URL}/{build_number}/jobs"
            "?per_page=100&include_retried_jobs=false"
        )
        jobs: list[dict[str, Any]] = []
        while url is not None:
            payload = self._get_json(url)
            if not isinstance(payload, dict):
                raise RuntimeError("Buildkite jobs response was not an object")
            items = payload.get("items")
            if not isinstance(items, list):
                raise RuntimeError("Buildkite jobs response omitted items")
            jobs.extend(cast(list[dict[str, Any]], items))
            links = payload.get("links")
            next_url = links.get("next") if isinstance(links, dict) else None
            url = str(next_url) if next_url else None
        return jobs

    def get_build(self, build_number: int) -> dict[str, Any]:
        payload = self._get_json(f"{self._BUILDS_URL}/{build_number}")
        if not isinstance(payload, dict):
            raise RuntimeError("Buildkite build response was not an object")
        return cast(dict[str, Any], payload)


class BuildkiteFullCISource:
    """Find scheduled Full CI builds and map their job-name outcomes."""

    _FULL_CI_MESSAGE = re.compile(r"full ci run - (nightly|daily)", re.IGNORECASE)

    def __init__(self, buildkite: BuildkitePort) -> None:
        self._buildkite = buildkite

    def fetch_runs(
        self,
        *,
        start_time: datetime | None,
        processed_build_ids: frozenset[str],
        up_to: datetime,
    ) -> list[FullCIRun]:
        builds = self._buildkite.list_builds(
            start_time=start_time,
            up_to=up_to,
        )
        runs: list[FullCIRun] = []
        for build in builds:
            message = str(build.get("message") or "").strip()
            if self._FULL_CI_MESSAGE.fullmatch(message) is None:
                continue
            build_id = str(build["id"])
            if build_id in processed_build_ids:
                continue
            scheduled_at = _parse_datetime(build["scheduled_at"])
            if scheduled_at > up_to or (
                start_time is not None and scheduled_at < start_time
            ):
                continue
            build_number = int(build["number"])
            jobs = tuple(
                FullCIJobOutcome(
                    name=str(job["name"]),
                    state=str(job.get("state") or ""),
                    soft_failed=bool(job.get("soft_failed")),
                )
                for job in self._buildkite.list_jobs(build_number)
                if job.get("name") is not None
            )
            runs.append(
                FullCIRun(
                    build_id=build_id,
                    build_number=build_number,
                    scheduled_at=scheduled_at,
                    commit_sha=str(build.get("commit") or ""),
                    message=message,
                    state=str(build.get("state") or ""),
                    jobs=jobs,
                )
            )
        return ordered_unique_runs(runs)


class FullCIStore(Protocol):
    def reconciliation_state(self) -> FullCIReconciliationState: ...

    def commit_reconciliation(
        self,
        *,
        command: ScheduledCommand,
        observations: list[FullCIRun],
        now: datetime,
    ) -> None:
        """Atomically persist new runs, outcomes, comparisons, and completion."""
        ...


class FullCIReconciliationHandler:
    """Ingest every unseen Full CI run through one command target."""

    def __init__(
        self, *, source: FullCISource, store: FullCIStore, clock: Clock
    ) -> None:
        self._source = source
        self._store = store
        self._clock = clock

    def __call__(self, command: ScheduledCommand) -> HandlerCompletion:
        state = self._store.reconciliation_state()
        start_time = state.start_time
        if start_time is None:
            start_time = command.target_time - INITIAL_LOOKBACK
        observations = self._source.fetch_runs(
            start_time=start_time,
            processed_build_ids=state.processed_build_ids,
            up_to=command.target_time,
        )
        self._store.commit_reconciliation(
            command=command,
            observations=observations,
            now=self._clock.now(),
        )
        return HandlerCompletion.TRANSACTIONAL
