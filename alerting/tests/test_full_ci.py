"""Full CI ingest behavior through the scheduled-command runtime seam."""

import io
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import Message
from typing import Any

import pytest

from alerting.commands import ScheduledCommand
from alerting.full_ci import (
    INITIAL_LOOKBACK,
    BuildkiteFullCISource,
    BuildkiteRestClient,
    FullCIJobOutcome,
    FullCIReconciliationHandler,
    FullCIRun,
)
from alerting.memory import (
    FixedClock,
    InMemoryAutomationExecutionStore,
    InMemoryFullCIStore,
    InMemoryOutboxStore,
    RecordingSlackPort,
)
from alerting.runtime import AlertingRuntime, ProcessStatus

START = datetime(2026, 8, 27, 6, 0, tzinfo=timezone.utc)


class FixtureFullCISource:
    def __init__(self, runs: list[FullCIRun]) -> None:
        self.runs = runs
        self.calls: list[tuple[datetime | None, frozenset[str], datetime]] = []

    def fetch_runs(
        self,
        *,
        start_time: datetime | None,
        processed_build_ids: frozenset[str],
        up_to: datetime,
    ) -> list[FullCIRun]:
        self.calls.append((start_time, processed_build_ids, up_to))
        return [
            run
            for run in self.runs
            if run.build_id not in processed_build_ids
            and (start_time is None or run.scheduled_at >= start_time)
            and run.scheduled_at <= up_to
        ]


class RecordingBuildkite:
    def __init__(
        self,
        builds: list[dict[str, Any]],
        jobs: dict[int, list[dict[str, Any]]],
    ) -> None:
        self.builds = builds
        self.jobs = jobs
        self.calls: list[tuple[datetime | None, datetime]] = []

    def list_builds(
        self, *, start_time: datetime | None, up_to: datetime
    ) -> list[dict[str, Any]]:
        self.calls.append((start_time, up_to))
        return self.builds

    def list_jobs(self, build_number: int) -> list[dict[str, Any]]:
        return self.jobs[build_number]

    def get_build(self, build_number: int) -> dict[str, Any]:
        raise RuntimeError("reconciliation tests do not fetch full builds")


def make_full_ci_run(build_number: int, scheduled_at: datetime) -> FullCIRun:
    return FullCIRun(
        build_id=f"build-{build_number}",
        build_number=build_number,
        scheduled_at=scheduled_at,
        commit_sha=f"commit-{build_number}",
        message="Full CI run - nightly",
        state="passed",
        jobs=(
            FullCIJobOutcome(name="GPU correctness", state="passed", soft_failed=False),
        ),
    )


def make_runtime(
    source: FixtureFullCISource,
) -> tuple[
    AlertingRuntime,
    InMemoryAutomationExecutionStore,
    InMemoryFullCIStore,
]:
    clock = FixedClock(START)
    executions = InMemoryAutomationExecutionStore()
    outbox = InMemoryOutboxStore()
    full_ci = InMemoryFullCIStore(executions=executions)
    runtime = AlertingRuntime(
        executions=executions,
        outbox=outbox,
        slack=RecordingSlackPort(),
        clock=clock,
        handlers={
            "full_ci_reconcile": FullCIReconciliationHandler(
                source=source, store=full_ci, clock=clock
            )
        },
    )
    return runtime, executions, full_ci


def test_missed_runs_are_ingested_in_order_with_one_comparison_each() -> None:
    baseline = make_full_ci_run(100, START - timedelta(days=1))
    first_missed = make_full_ci_run(101, START - timedelta(hours=12))
    second_missed = make_full_ci_run(102, START - timedelta(hours=1))
    source = FixtureFullCISource([second_missed, baseline, first_missed])
    runtime, _, full_ci = make_runtime(source)

    baseline_tick = ScheduledCommand(
        command_type="full_ci_reconcile", target_time=baseline.scheduled_at
    )
    assert runtime.process_command(baseline_tick).status is ProcessStatus.COMPLETED

    catch_up = ScheduledCommand(command_type="full_ci_reconcile", target_time=START)
    assert runtime.process_command(catch_up).status is ProcessStatus.COMPLETED

    assert [stored.build_number for stored in full_ci.runs()] == [100, 101, 102]
    assert full_ci.job_outcomes("build-101") == list(first_missed.jobs)
    assert full_ci.job_outcomes("build-102") == list(second_missed.jobs)
    assert [
        (comparison.previous_build_id, comparison.current_build_id)
        for comparison in full_ci.comparisons()
    ] == [("build-100", "build-101"), ("build-101", "build-102")]
    assert source.calls == [
        (
            baseline.scheduled_at - INITIAL_LOOKBACK,
            frozenset(),
            baseline.scheduled_at,
        ),
        (baseline.scheduled_at, frozenset({baseline.build_id}), START),
    ]


def test_duplicate_and_overlapping_ticks_create_no_duplicate_comparisons() -> None:
    baseline = make_full_ci_run(100, START - timedelta(days=1))
    current = make_full_ci_run(101, START - timedelta(hours=1))
    source = FixtureFullCISource([current, baseline, current])
    runtime, executions, full_ci = make_runtime(source)

    first = ScheduledCommand(command_type="full_ci_reconcile", target_time=START)
    overlap = ScheduledCommand(
        command_type="full_ci_reconcile", target_time=START + timedelta(minutes=1)
    )

    assert runtime.process_command(first).status is ProcessStatus.COMPLETED
    assert (
        runtime.process_command(first).status is ProcessStatus.SKIPPED_ALREADY_COMPLETED
    )
    assert runtime.process_command(overlap).status is ProcessStatus.COMPLETED

    assert [stored.build_id for stored in full_ci.runs()] == [
        "build-100",
        "build-101",
    ]
    assert len(full_ci.comparisons()) == 1
    comparison = full_ci.comparisons()[0]
    assert (comparison.previous_build_id, comparison.current_build_id) == (
        "build-100",
        "build-101",
    )
    assert executions.count() == 2


def test_late_visible_run_repairs_chronological_comparison_chain() -> None:
    baseline = make_full_ci_run(100, START - timedelta(days=1))
    late = make_full_ci_run(101, START - timedelta(hours=12))
    latest = make_full_ci_run(102, START - timedelta(hours=1))
    source = FixtureFullCISource([baseline, latest])
    runtime, _, full_ci = make_runtime(source)

    assert (
        runtime.process_command(
            ScheduledCommand(command_type="full_ci_reconcile", target_time=START)
        ).status
        is ProcessStatus.COMPLETED
    )

    source.runs.append(late)
    assert (
        runtime.process_command(
            ScheduledCommand(
                command_type="full_ci_reconcile",
                target_time=START + timedelta(minutes=1),
            )
        ).status
        is ProcessStatus.COMPLETED
    )

    assert [stored.build_number for stored in full_ci.runs()] == [100, 101, 102]
    assert [
        (comparison.previous_build_id, comparison.current_build_id)
        for comparison in full_ci.comparisons()
    ] == [("build-100", "build-101"), ("build-101", "build-102")]


def test_buildkite_source_maps_only_eligible_full_ci_runs_and_named_jobs() -> None:
    after = START - timedelta(days=1)
    buildkite = RecordingBuildkite(
        builds=[
            {
                "id": "build-101",
                "number": 101,
                "scheduled_at": "2026-08-27T05:00:00Z",
                "commit": "abc123",
                "message": "Full CI run - daily",
                "state": "failed",
            },
            {
                "id": "build-irrelevant",
                "number": 99,
                "scheduled_at": "2026-08-27T04:00:00Z",
                "commit": "def456",
                "message": "regular pull request",
                "state": "passed",
            },
            {
                "id": "build-processed",
                "number": 100,
                "scheduled_at": "2026-08-27T04:30:00Z",
                "commit": "processed",
                "message": "Full CI run - nightly",
                "state": "passed",
            },
        ],
        jobs={
            101: [
                {"name": None, "state": "passed", "soft_failed": False},
                {
                    "name": "GPU correctness",
                    "state": "failed",
                    "soft_failed": False,
                },
                {
                    "name": "Optional check",
                    "state": "failed",
                    "soft_failed": True,
                },
            ]
        },
    )

    rows = BuildkiteFullCISource(buildkite).fetch_runs(
        start_time=after,
        processed_build_ids=frozenset({"build-processed"}),
        up_to=START,
    )

    assert buildkite.calls == [(after, START)]
    assert rows == [
        FullCIRun(
            build_id="build-101",
            build_number=101,
            scheduled_at=datetime(2026, 8, 27, 5, 0, tzinfo=timezone.utc),
            commit_sha="abc123",
            message="Full CI run - daily",
            state="failed",
            jobs=(
                FullCIJobOutcome(
                    name="GPU correctness", state="failed", soft_failed=False
                ),
                FullCIJobOutcome(
                    name="Optional check", state="failed", soft_failed=True
                ),
            ),
        )
    ]


def _http_error(url: str, status: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url, status, "error", Message(), io.BytesIO(b"transient")
    )


def test_buildkite_client_retries_transient_http_errors(monkeypatch: Any) -> None:
    attempts = 0

    def fake_urlopen(request: Any, timeout: int = 0) -> Any:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise _http_error(request.full_url, 429)
        return io.BytesIO(b"[]")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    client = BuildkiteRestClient(token="token")

    assert client.list_builds(start_time=None, up_to=START) == []
    assert attempts == 3


def test_buildkite_client_does_not_retry_permanent_http_errors(
    monkeypatch: Any,
) -> None:
    attempts = 0

    def fake_urlopen(request: Any, timeout: int = 0) -> Any:
        nonlocal attempts
        attempts += 1
        raise _http_error(request.full_url, 400)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    client = BuildkiteRestClient(token="token")

    with pytest.raises(RuntimeError, match="HTTP 400"):
        client.list_builds(start_time=None, up_to=START)
    assert attempts == 1
