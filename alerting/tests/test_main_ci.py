"""Main CI failed-job alert lifecycle through the scheduled-command seam."""

from datetime import datetime, timedelta, timezone
from typing import Any

from alerting.commands import ScheduledCommand
from alerting.full_ci import BuildkiteRestClient
from alerting.main_ci import (
    INITIAL_LOOKBACK,
    SAFETY_OVERLAP,
    SWEEP_LOOKBACK,
    BuildkiteMainCISource,
    MainCIBackstopHandler,
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
        if query.get("state") == "finished":
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
    # Buildkite requires array syntax for the multi-state filter; repeated
    # scalar state= params make the active query return zero builds.
    assert "state" not in client.queries[0]
    assert client.queries[0]["state[]"] == [
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
        assert query["include_retried_jobs"] == "true"
        assert "exclude_jobs" not in query


class RecordingUrlClient(BuildkiteRestClient):
    def __init__(self) -> None:
        super().__init__(token="not-used")
        self.urls: list[str] = []

    def _get_json(self, url: str) -> Any:
        self.urls.append(url)
        return []


def test_buildkite_client_serializes_state_filter_as_array_params() -> None:
    client = RecordingUrlClient()

    client.list_job_builds(observed_from=START - timedelta(minutes=30), up_to=START)

    assert len(client.urls) == 2
    active_url, finished_url = client.urls
    # urlencode percent-encodes the brackets; Buildkite decodes them back to
    # state[]=... before parsing the query.
    assert "state%5B%5D=creating" in active_url
    assert "state%5B%5D=running" in active_url
    assert "state=creating" not in active_url
    assert "state=finished" in finished_url


def buildkite_job(
    *,
    job_id: str,
    state: str,
    finished_at: datetime | None,
    name: str = "GPU correctness",
    step_key: str | None = "gpu-test",
) -> dict[str, Any]:
    job: dict[str, Any] = {
        "id": job_id,
        "name": name,
        "type": "script",
        "state": state,
        "soft_failed": False,
        "finished_at": (
            finished_at.isoformat().replace("+00:00", "Z") if finished_at else None
        ),
    }
    if step_key is not None:
        job["step_key"] = step_key
    return job


def buildkite_build(number: int, jobs: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": f"build-{number}",
        "number": number,
        "web_url": f"https://buildkite.com/vllm/ci/builds/{number}",
        "commit": f"commit-{number}",
        "jobs": jobs,
    }


def source_runtime_for(
    buildkite: RecordingBuildkite,
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
                source=BuildkiteMainCISource(buildkite),
                store=store,
                clock=clock,
            )
        },
    )
    return runtime, store, clock


def test_retry_pass_inside_window_resolves_original_failure() -> None:
    failure = buildkite_job(
        job_id="orig", state="failed", finished_at=START - timedelta(hours=3)
    )
    buildkite = RecordingBuildkite([buildkite_build(300, [failure])])
    runtime, store, _ = source_runtime_for(buildkite)
    key = "step:gpu-test|name:GPU correctness"

    reconcile(runtime, START - timedelta(hours=2, minutes=55))
    assert [(alert.status, alert.failure_count) for alert in store.alerts()] == [
        ("open", 1)
    ]
    # Advance the cursor so the original failure falls outside the window.
    reconcile(runtime, START - timedelta(hours=2, minutes=20))

    buildkite.builds[0]["jobs"].append(
        buildkite_job(
            job_id="retry", state="passed", finished_at=START - timedelta(minutes=5)
        )
    )
    reconcile(runtime, START)

    assert [(alert.status, alert.failure_count) for alert in store.alerts()] == [
        ("resolved", 1)
    ]
    resolution = store.alerts()[0].resolution
    assert resolution is not None
    assert resolution.job_id == "retry"
    state = store.state(key)
    assert state is not None
    assert state.job_id == "retry"


def test_retry_pass_outside_window_still_resolves_when_build_is_fetched() -> None:
    original = buildkite_job(
        job_id="orig", state="failed", finished_at=START - timedelta(hours=3)
    )
    buildkite = RecordingBuildkite([buildkite_build(300, [original])])
    runtime, store, _ = source_runtime_for(buildkite)

    reconcile(runtime, START - timedelta(hours=2, minutes=55))
    assert [alert.status for alert in store.alerts()] == ["open"]
    # The build drops out of the fetched set while the retry passes, so the
    # pass's finished_at ends up behind the scan window.
    buildkite.builds = []
    reconcile(runtime, START - timedelta(hours=1))

    buildkite.builds = [
        buildkite_build(
            300,
            [
                original,
                buildkite_job(
                    job_id="retry",
                    state="passed",
                    finished_at=START - timedelta(hours=2, minutes=45),
                ),
            ],
        ),
        # An older build's late failure must not win over the newer pass.
        buildkite_build(
            299,
            [
                buildkite_job(
                    job_id="old",
                    state="failed",
                    finished_at=START + timedelta(minutes=10),
                )
            ],
        ),
    ]
    reconcile(runtime, START + timedelta(minutes=30))

    assert [alert.status for alert in store.alerts()] == ["resolved"]
    resolution = store.alerts()[0].resolution
    assert resolution is not None
    assert resolution.job_id == "retry"


def test_retry_execution_without_step_key_resolves_original_alert() -> None:
    buildkite = RecordingBuildkite(
        [
            buildkite_build(
                300,
                [
                    buildkite_job(
                        job_id="orig",
                        state="failed",
                        finished_at=START - timedelta(hours=3),
                    )
                ],
            )
        ]
    )
    runtime, store, _ = source_runtime_for(buildkite)

    reconcile(runtime, START - timedelta(hours=2, minutes=55))
    assert [alert.status for alert in store.alerts()] == ["open"]

    buildkite.builds[0]["jobs"].append(
        buildkite_job(
            job_id="retry",
            state="passed",
            finished_at=START - timedelta(minutes=5),
            step_key=None,
        )
    )
    reconcile(runtime, START)

    assert [alert.status for alert in store.alerts()] == ["resolved"]
    resolution = store.alerts()[0].resolution
    assert resolution is not None
    assert resolution.job_id == "retry"
    # The retried execution inherits the step key instead of opening a
    # parallel "name:..." identity.
    assert store.state("step:gpu-test|name:GPU correctness") is not None
    assert store.state("name:GPU correctness") is None


def test_newer_failure_wins_over_older_pass() -> None:
    source = FixtureSource()
    runtime, store, _ = runtime_for(source)
    source.observations = [
        observation(build_number=101, state="failed", minutes=1, job_id="newer")
    ]
    reconcile(runtime, START + timedelta(minutes=2))
    assert [alert.status for alert in store.alerts()] == ["open"]

    # An older build's pass finishing late must not resolve the newer failure.
    source.observations.append(
        observation(build_number=100, state="passed", minutes=3, job_id="older")
    )
    reconcile(runtime, START + timedelta(minutes=4))

    assert [alert.status for alert in store.alerts()] == ["open"]
    state = store.state("step:gpu-test|name:GPU correctness")
    assert state is not None
    assert state.job_id == "newer"


class FixtureBuilds:
    def __init__(self, builds: dict[int, dict[str, Any]]) -> None:
        self.builds = builds
        self.calls: list[tuple[int, bool]] = []
        self.sweep_builds: list[dict[str, Any]] = []
        self.sweep_calls: list[tuple[datetime, datetime]] = []

    def list_job_builds(
        self, *, observed_from: datetime, up_to: datetime
    ) -> list[dict[str, Any]]:
        self.sweep_calls.append((observed_from, up_to))
        return self.sweep_builds

    def get_build(
        self, build_number: int, *, include_retried_jobs: bool
    ) -> dict[str, Any]:
        self.calls.append((build_number, include_retried_jobs))
        return self.builds[build_number]


def combined_runtime_for(
    source: FixtureSource, builds: FixtureBuilds
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
                source=source, store=store, clock=clock
            ),
            "main_ci_backstop": MainCIBackstopHandler(
                builds=builds, store=store, clock=clock
            ),
        },
    )
    return runtime, store, clock


def backstop(runtime: AlertingRuntime, target: datetime) -> None:
    result = runtime.process_command(
        ScheduledCommand(command_type="main_ci_backstop", target_time=target)
    )
    assert result.status is ProcessStatus.COMPLETED


def open_alert(runtime: AlertingRuntime, source: FixtureSource) -> None:
    source.observations = [
        observation(
            build_number=300, state="failed", minutes=-180, job_id="orig"
        )
    ]
    reconcile(runtime, START - timedelta(hours=2, minutes=55))


def test_backstop_resolves_open_alert_whose_retried_job_now_passes() -> None:
    source = FixtureSource()
    builds = FixtureBuilds({})
    runtime, store, _ = combined_runtime_for(source, builds)
    open_alert(runtime, source)
    assert [alert.status for alert in store.alerts()] == ["open"]
    cursor = store.main_ci_scan_cursor()

    builds.builds[300] = buildkite_build(
        300,
        [
            buildkite_job(
                job_id="orig", state="failed", finished_at=START - timedelta(hours=3)
            ),
            buildkite_job(
                job_id="retry",
                state="passed",
                finished_at=START - timedelta(hours=1),
            ),
        ],
    )
    backstop(runtime, START + timedelta(hours=2))

    alert = store.alerts()[0]
    assert alert.status == "resolved"
    assert alert.resolution is not None
    assert alert.resolution.job_id == "retry"
    assert builds.calls == [(300, True)]
    # The sweep must not advance the poller's scan cursor.
    assert store.main_ci_scan_cursor() == cursor


def test_backstop_leaves_still_failing_alert_open() -> None:
    source = FixtureSource()
    builds = FixtureBuilds({})
    runtime, store, _ = combined_runtime_for(source, builds)
    open_alert(runtime, source)

    builds.builds[300] = buildkite_build(
        300,
        [
            buildkite_job(
                job_id="orig", state="failed", finished_at=START - timedelta(hours=3)
            )
        ],
    )
    backstop(runtime, START + timedelta(hours=2))

    assert [(alert.status, alert.failure_count) for alert in store.alerts()] == [
        ("open", 1)
    ]


def test_backstop_ignores_resolved_alerts() -> None:
    source = FixtureSource()
    builds = FixtureBuilds({})
    runtime, store, _ = combined_runtime_for(source, builds)
    open_alert(runtime, source)
    source.observations.append(
        observation(build_number=300, state="passed", minutes=-170, job_id="retry")
    )
    reconcile(runtime, START - timedelta(hours=2, minutes=45))
    assert [alert.status for alert in store.alerts()] == ["resolved"]

    backstop(runtime, START + timedelta(hours=2))

    assert builds.calls == []
    alert = store.alerts()[0]
    assert alert.status == "resolved"
    assert alert.resolution is not None
    assert alert.resolution.job_id == "retry"


def test_sweep_opens_alert_for_failure_the_poller_window_missed() -> None:
    # The build finished recently, but its job failed five hours earlier —
    # outside any thirty-minute window the poller would have scanned.
    source = FixtureSource()
    builds = FixtureBuilds({})
    runtime, store, _ = combined_runtime_for(source, builds)
    builds.sweep_builds = [
        buildkite_build(
            400,
            [
                buildkite_job(
                    job_id="slow-failure",
                    state="failed",
                    finished_at=START - timedelta(hours=5),
                )
            ],
        )
    ]

    backstop(runtime, START)

    assert [(alert.status, alert.failure_count) for alert in store.alerts()] == [
        ("open", 1)
    ]
    assert store.alerts()[0].last_failure.job_id == "slow-failure"
    assert builds.sweep_calls == [(START - SWEEP_LOOKBACK, START)]
    # Nothing was open when the sweep started, so no targeted re-check ran.
    assert builds.calls == []


def test_sweep_does_not_reopen_when_a_newer_pass_exists() -> None:
    source = FixtureSource()
    builds = FixtureBuilds({})
    runtime, store, _ = combined_runtime_for(source, builds)
    open_alert(runtime, source)
    source.observations.append(
        observation(build_number=300, state="passed", minutes=-170, job_id="retry")
    )
    reconcile(runtime, START - timedelta(hours=2, minutes=45))
    assert [alert.status for alert in store.alerts()] == ["resolved"]

    # The sweep re-feeds the older failure; the order guard must drop it.
    builds.sweep_builds = [
        buildkite_build(
            300,
            [
                buildkite_job(
                    job_id="orig",
                    state="failed",
                    finished_at=START - timedelta(hours=3),
                ),
                buildkite_job(
                    job_id="retry",
                    state="passed",
                    finished_at=START - timedelta(hours=2, minutes=50),
                ),
            ],
        )
    ]
    backstop(runtime, START)

    assert [(alert.status, alert.failure_count) for alert in store.alerts()] == [
        ("resolved", 1)
    ]
    resolution = store.alerts()[0].resolution
    assert resolution is not None
    assert resolution.job_id == "retry"


def test_sweep_is_idempotent_across_reruns() -> None:
    source = FixtureSource()
    builds = FixtureBuilds({})
    runtime, store, _ = combined_runtime_for(source, builds)
    build = buildkite_build(
        400,
        [
            buildkite_job(
                job_id="slow-failure",
                state="failed",
                finished_at=START - timedelta(hours=5),
            )
        ],
    )
    builds.sweep_builds = [build]
    builds.builds[400] = build

    backstop(runtime, START)
    backstop(runtime, START + timedelta(hours=1))

    assert [(alert.status, alert.failure_count) for alert in store.alerts()] == [
        ("open", 1)
    ]
