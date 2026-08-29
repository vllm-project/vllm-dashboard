"""Main CI failed-job alert lifecycle through the scheduled-command seam."""

from datetime import datetime, timedelta, timezone
from typing import Any

from alerting.commands import ScheduledCommand
from alerting.full_ci import BuildkiteRestClient
from alerting.main_ci import (
    INITIAL_LOOKBACK,
    SAFETY_OVERLAP,
    BuildkiteMainCISource,
    MainCIJobObservation,
    MainCIReconciliationHandler,
)
from alerting.memory import (
    FixedClock,
    InMemoryAutomationExecutionStore,
    InMemoryMainCIStore,
    InMemoryOutboxStore,
    RecordingSlackPort,
)
from alerting.runtime import AlertingRuntime, ProcessStatus

START = datetime(2026, 8, 29, 10, 0, tzinfo=timezone.utc)


class FixtureSource:
    def __init__(self) -> None:
        self.observations: list[MainCIJobObservation] = []
        self.calls: list[tuple[datetime, datetime]] = []

    def fetch_observations(
        self, *, start_time: datetime, end_time: datetime
    ) -> list[MainCIJobObservation]:
        self.calls.append((start_time, end_time))
        return [
            item
            for item in self.observations
            if start_time <= item.finished_at <= end_time
        ]


class RecordingBuildkite:
    def __init__(self, builds: list[dict[str, Any]]) -> None:
        self.builds = builds
        self.calls: list[tuple[datetime, datetime]] = []

    def list_job_builds(
        self, *, observed_from: datetime, up_to: datetime
    ) -> list[dict[str, Any]]:
        self.calls.append((observed_from, up_to))
        return self.builds


class RecordingRestClient(BuildkiteRestClient):
    def __init__(self) -> None:
        super().__init__(token="not-used")
        self.queries: list[dict[str, str | int | list[str]]] = []

    def _list_build_pages(
        self, query: dict[str, str | int | list[str]]
    ) -> list[dict[str, Any]]:
        self.queries.append(dict(query))
        if query["state"] == "finished":
            return [{"id": "shared"}, {"id": "finished"}]
        return [{"id": "active"}, {"id": "shared"}]


def observation(
    *,
    build_number: int,
    state: str,
    minutes: int,
    job_id: str | None = None,
) -> MainCIJobObservation:
    actual_job_id = job_id or f"job-{build_number}-{state}"
    return MainCIJobObservation(
        job_key="step:gpu-test|name:GPU correctness",
        job_id=actual_job_id,
        job_name="GPU correctness",
        job_url=f"https://buildkite.com/vllm/ci/builds/{build_number}#{actual_job_id}",
        state=state,
        finished_at=START + timedelta(minutes=minutes),
        build_id=f"build-{build_number}",
        build_number=build_number,
        build_url=f"https://buildkite.com/vllm/ci/builds/{build_number}",
        commit_sha=f"commit-{build_number}",
    )


def runtime_for(
    source: FixtureSource,
) -> tuple[AlertingRuntime, InMemoryMainCIStore, FixedClock]:
    clock = FixedClock(START)
    executions = InMemoryAutomationExecutionStore()
    store = InMemoryMainCIStore(executions=executions)
    runtime = AlertingRuntime(
        executions=executions,
        outbox=InMemoryOutboxStore(),
        slack=RecordingSlackPort(),
        clock=clock,
        handlers={
            "main_ci_reconcile": MainCIReconciliationHandler(
                source=source,
                store=store,
                clock=clock,
            )
        },
    )
    return runtime, store, clock


def reconcile(runtime: AlertingRuntime, target: datetime) -> None:
    result = runtime.process_command(
        ScheduledCommand(command_type="main_ci_reconcile", target_time=target)
    )
    assert result.status is ProcessStatus.COMPLETED


def test_failure_episode_updates_resolves_only_on_pass_and_can_reopen() -> None:
    source = FixtureSource()
    runtime, store, _ = runtime_for(source)

    source.observations = [observation(build_number=100, state="failed", minutes=1)]
    reconcile(runtime, START + timedelta(minutes=2))
    assert [(alert.status, alert.failure_count) for alert in store.alerts()] == [
        ("open", 1)
    ]

    source.observations.append(
        observation(build_number=101, state="timed_out", minutes=6)
    )
    reconcile(runtime, START + timedelta(minutes=7))
    assert [(alert.status, alert.failure_count) for alert in store.alerts()] == [
        ("open", 2)
    ]

    source.observations.append(
        observation(build_number=102, state="passed", minutes=11)
    )
    reconcile(runtime, START + timedelta(minutes=12))
    assert [(alert.status, alert.failure_count) for alert in store.alerts()] == [
        ("resolved", 2)
    ]

    source.observations.append(
        observation(build_number=103, state="failed", minutes=16)
    )
    reconcile(runtime, START + timedelta(minutes=17))
    assert [(alert.status, alert.failure_count) for alert in store.alerts()] == [
        ("resolved", 2),
        ("open", 1),
    ]


def test_older_build_finishing_late_cannot_overwrite_newer_outcome() -> None:
    source = FixtureSource()
    runtime, store, _ = runtime_for(source)
    source.observations = [
        observation(build_number=201, state="failed", minutes=2),
        observation(build_number=200, state="passed", minutes=3),
    ]

    reconcile(runtime, START + timedelta(minutes=4))

    assert store.state("step:gpu-test|name:GPU correctness") == source.observations[0]
    assert [(alert.status, alert.failure_count) for alert in store.alerts()] == [
        ("open", 1)
    ]


def test_scan_uses_initial_backfill_then_a_safety_overlap() -> None:
    source = FixtureSource()
    runtime, store, _ = runtime_for(source)
    first_target = START + timedelta(minutes=2)
    second_target = START + timedelta(minutes=7)

    reconcile(runtime, first_target)
    reconcile(runtime, second_target)

    assert source.calls == [
        (first_target - INITIAL_LOOKBACK, first_target),
        (first_target - SAFETY_OVERLAP, second_target),
    ]
    assert store.main_ci_scan_cursor() == second_target


def test_buildkite_source_keeps_hard_terminal_script_jobs_and_matrix_identity() -> None:
    buildkite = RecordingBuildkite(
        [
            {
                "id": "build-300",
                "number": 300,
                "web_url": "https://buildkite.com/vllm/ci/builds/300",
                "commit": "abc123",
                "jobs": [
                    {
                        "id": "matrix-a",
                        "name": "GPU correctness / shard 1",
                        "type": "script",
                        "step_key": "gpu-correctness",
                        "state": "failed",
                        "soft_failed": False,
                        "finished_at": "2026-08-29T09:55:00Z",
                        "web_url": "https://example.test/matrix-a",
                    },
                    {
                        "id": "matrix-b",
                        "name": "GPU correctness / shard 2",
                        "type": "script",
                        "step_key": "gpu-correctness",
                        "state": "passed",
                        "soft_failed": False,
                        "finished_at": "2026-08-29T09:56:00Z",
                        "web_url": "https://example.test/matrix-b",
                    },
                    {
                        "id": "soft",
                        "name": "Optional check",
                        "type": "script",
                        "step_key": "optional",
                        "state": "failed",
                        "soft_failed": True,
                        "finished_at": "2026-08-29T09:57:00Z",
                    },
                    {
                        "id": "waiting",
                        "name": "Still waiting",
                        "type": "script",
                        "step_key": "waiting",
                        "state": "scheduled",
                        "soft_failed": False,
                        "finished_at": None,
                    },
                    {
                        "id": "group",
                        "name": "Group",
                        "type": "group",
                        "state": "failed",
                        "soft_failed": False,
                        "finished_at": "2026-08-29T09:58:00Z",
                    },
                ],
            }
        ]
    )

    rows = BuildkiteMainCISource(buildkite).fetch_observations(
        start_time=START - timedelta(minutes=10),
        end_time=START,
    )

    assert [row.job_id for row in rows] == ["matrix-a", "matrix-b"]
    assert [row.job_key for row in rows] == [
        "step:gpu-correctness|name:GPU correctness / shard 1",
        "step:gpu-correctness|name:GPU correctness / shard 2",
    ]
    assert buildkite.calls == [(START - timedelta(minutes=10), START)]


def test_buildkite_client_unions_active_and_recently_finished_builds() -> None:
    client = RecordingRestClient()
    observed_from = START - timedelta(minutes=30)

    rows = client.list_job_builds(observed_from=observed_from, up_to=START)

    assert {row["id"] for row in rows} == {"active", "shared", "finished"}
    assert client.queries[0]["state"] == [
        "creating",
        "scheduled",
        "running",
        "failing",
        "canceling",
    ]
    assert client.queries[1]["state"] == "finished"
    assert client.queries[1]["finished_from"] == "2026-08-29T09:30:00Z"
    for query in client.queries:
        assert query["branch"] == "main"
        assert query["include_retried_jobs"] == "false"
        assert "exclude_jobs" not in query
