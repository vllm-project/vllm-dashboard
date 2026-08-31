"""Fast CI behavior through the scheduled-command runtime seam."""

from datetime import datetime, timedelta, timezone
from typing import Any

from alerting.commands import ScheduledCommand
from alerting.fast_ci import (
    DatabricksFastCISource,
    FastCIScanHandler,
    FastCISource,
    FastFailureEvent,
    FastFailureState,
)
from alerting.memory import (
    FixedClock,
    InMemoryAutomationExecutionStore,
    InMemoryFastCIStore,
    InMemoryOutboxStore,
    RecordingSlackPort,
)
from alerting.ports import DeliveryMode, AutomationExecutionStatus, NotificationIntentRecord, OutboxStatus
from alerting.runtime import AlertingRuntime, ProcessStatus

START = datetime(2026, 8, 27, 19, 0, tzinfo=timezone.utc)


class FixtureFastCISource:
    def __init__(self, rows: list[FastFailureEvent] | None = None) -> None:
        self.calls: list[tuple[datetime, datetime]] = []
        self.rows = rows or []

    def fetch_failures(
        self, *, start_time: datetime, end_time: datetime
    ) -> list[FastFailureEvent]:
        self.calls.append((start_time, end_time))
        return list(self.rows)


class RecordingDatabricks:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.queries: list[str] = []

    def query(self, sql: str) -> list[dict[str, Any]]:
        self.queries.append(sql)
        return self.rows


class UnavailableSlackPort:
    def deliver(self, _record: NotificationIntentRecord) -> str | None:
        raise RuntimeError("slack unavailable")


def event(job_id: str, *, finished_at: datetime = START) -> FastFailureEvent:
    return FastFailureEvent(
        job_id=job_id,
        job_name="GPU <fast> `test`",
        job_url=f"https://buildkite.com/vllm/ci/builds/123#{job_id}",
        state=FastFailureState.FAILED,
        soft_failed=False,
        duration_seconds=19,
        finished_at=finished_at,
        build_url="https://buildkite.com/vllm/ci/builds/123",
        message="A failure\nwith whitespace",
        commit_sha="abcdef0123456789",
        branch="main",
        author="tester",
        pr_number="456",
        pipeline="CI",
    )


def make_runtime(
    source: FastCISource,
    *,
    slack: RecordingSlackPort | UnavailableSlackPort | None = None,
    clock: FixedClock | None = None,
    delivery_mode: DeliveryMode = DeliveryMode.LIVE,
) -> tuple[
    AlertingRuntime,
    InMemoryAutomationExecutionStore,
    InMemoryOutboxStore,
    InMemoryFastCIStore,
]:
    clock = clock or FixedClock(START)
    executions = InMemoryAutomationExecutionStore()
    outbox = InMemoryOutboxStore()
    fast_ci = InMemoryFastCIStore(executions=executions, outbox=outbox)
    handler = FastCIScanHandler(
        source=source,
        store=fast_ci,
        clock=clock,
        delivery_mode=delivery_mode,
    )
    runtime = AlertingRuntime(
        executions=executions,
        outbox=outbox,
        slack=slack or RecordingSlackPort(),
        clock=clock,
        handlers={"fast_ci_scan": handler},
        stale_notifications=fast_ci,
    )
    return runtime, executions, outbox, fast_ci


def test_empty_scan_advances_cursor_without_enqueuing_notification() -> None:
    source = FixtureFastCISource()
    runtime, _, outbox, fast_ci = make_runtime(source)
    command = ScheduledCommand(command_type="fast_ci_scan", target_time=START)

    result = runtime.process_command(command)

    assert result.status is ProcessStatus.COMPLETED
    assert source.calls == [(START - timedelta(minutes=30), START)]
    assert fast_ci.scan_cursor() == START
    assert fast_ci.events() == []
    assert outbox.count() == 0


def test_more_than_eight_failures_are_persisted_in_existing_slack_batches() -> None:
    source = FixtureFastCISource(
        [
            event(f"job-{index}", finished_at=START + timedelta(seconds=index))
            for index in range(10)
        ]
    )
    runtime, _, outbox, fast_ci = make_runtime(source)

    result = runtime.process_command(
        ScheduledCommand(command_type="fast_ci_scan", target_time=START + timedelta(minutes=1))
    )

    assert result.status is ProcessStatus.COMPLETED
    assert len(fast_ci.events()) == 10
    records = outbox.records()
    assert [record.status for record in records] == [OutboxStatus.PENDING] * 2
    assert "8 jobs failed in 30s or less — batch 1/2" in records[0].payload["text"]
    assert "2 jobs failed in 30s or less — batch 2/2" in records[1].payload["text"]
    assert records[0].payload["text"].count(":red_circle:") == 8
    assert records[1].payload["text"].count(":red_circle:") == 2
    assert "GPU &lt;fast&gt; 'test'" in records[0].payload["text"]
    assert "CI #123" in records[0].payload["text"]
    assert "> A failure with whitespace" in records[0].payload["text"]
    delivery_ids = {record.delivery_id for record in records}
    assert {
        fast_ci.delivery_id_for(stored.job_id) for stored in fast_ci.events()
    } == delivery_ids


def test_stale_batches_become_one_recovery_summary_while_fresh_batch_stays_detailed() -> (
    None
):
    stale_events = [
        event(f"stale-job-{index}", finished_at=START + timedelta(seconds=index))
        for index in range(10)
    ]
    source = FixtureFastCISource(stale_events)
    slack = RecordingSlackPort()
    clock = FixedClock(START)
    runtime, _, outbox, fast_ci = make_runtime(source, slack=slack, clock=clock)

    runtime.process_command(ScheduledCommand(command_type="fast_ci_scan", target_time=START))
    stale_delivery_ids = {record.delivery_id for record in outbox.records()}
    assert len(stale_delivery_ids) == 2

    clock.advance(minutes=31)
    fresh_event = event("fresh-job", finished_at=clock.now())
    source.rows = [*stale_events, fresh_event]
    runtime.process_command(
        ScheduledCommand(command_type="fast_ci_scan", target_time=clock.now())
    )

    result = runtime.dispatch_due_notifications()

    assert result.delivered == 2
    assert len(fast_ci.events()) == 11
    assert len(slack.deliveries) == 2
    recovery = next(
        record
        for record in slack.deliveries
        if "Fast CI recovery summary" in record.payload["text"]
    )
    fresh = next(record for record in slack.deliveries if record is not recovery)
    assert (
        recovery.payload["text"].splitlines()[0]
        == ":rotating_light: *Fast CI recovery summary* — "
        "10 jobs failed in 30s or less while notifications were unavailable"
    )
    assert recovery.payload["text"].count(":red_circle:") == 10
    assert "Fast CI job failure alert" in fresh.payload["text"]
    assert fresh.payload["text"].count(":red_circle:") == 1
    assert all(
        outbox.get_outbox(delivery_id).superseded_by == recovery.delivery_id  # type: ignore[union-attr]
        for delivery_id in stale_delivery_ids
    )
    assert all(
        recovery.delivery_id in fast_ci.delivery_ids_for(item.job_id)
        for item in stale_events
    )
    assert fast_ci.delivery_ids_for(fresh_event.job_id) == (fresh.delivery_id,)


def test_duplicate_commands_windows_and_job_ids_create_one_event_and_outbox_row() -> (
    None
):
    source = FixtureFastCISource([event("job-1"), event("job-1")])
    runtime, _, outbox, fast_ci = make_runtime(source)
    first = ScheduledCommand(command_type="fast_ci_scan", target_time=START)

    assert runtime.process_command(first).status is ProcessStatus.COMPLETED
    assert (
        runtime.process_command(first).status is ProcessStatus.SKIPPED_ALREADY_COMPLETED
    )

    source.rows = [event("job-1"), event("job-2")]
    second = ScheduledCommand(
        command_type="fast_ci_scan", target_time=START + timedelta(minutes=15)
    )
    assert runtime.process_command(second).status is ProcessStatus.COMPLETED

    assert source.calls == [
        (START - timedelta(minutes=30), START),
        (START - timedelta(minutes=15), START + timedelta(minutes=15)),
    ]
    assert [stored.job_id for stored in fast_ci.events()] == ["job-1", "job-2"]
    assert outbox.count() == 2


def test_imported_legacy_job_id_is_not_reposted() -> None:
    source = FixtureFastCISource([event("already-alerted"), event("new-job")])
    runtime, _, outbox, fast_ci = make_runtime(source)
    fast_ci.seed_imported_job_ids({"already-alerted"})

    assert (
        runtime.process_command(
            ScheduledCommand(command_type="fast_ci_scan", target_time=START)
        ).status
        is ProcessStatus.COMPLETED
    )

    assert [stored.job_id for stored in fast_ci.events()] == ["new-job"]
    assert outbox.count() == 1
    assert "new-job" in outbox.records()[0].payload["text"]
    assert "already-alerted" not in outbox.records()[0].payload["text"]


def test_safety_overlap_captures_delayed_ingestion() -> None:
    source = FixtureFastCISource()
    runtime, _, outbox, fast_ci = make_runtime(source)
    first = ScheduledCommand(command_type="fast_ci_scan", target_time=START)
    runtime.process_command(first)

    delayed = event("late-job", finished_at=START - timedelta(minutes=5))
    source.rows = [delayed]
    second = ScheduledCommand(
        command_type="fast_ci_scan", target_time=START + timedelta(minutes=15)
    )
    runtime.process_command(second)

    assert source.calls[-1] == (
        START - timedelta(minutes=15),
        START + timedelta(minutes=15),
    )
    assert fast_ci.events() == [delayed]
    assert outbox.count() == 1


def test_scan_recovers_entire_cursor_range_after_missed_intervals() -> None:
    source = FixtureFastCISource()
    runtime, _, outbox, fast_ci = make_runtime(source)
    runtime.process_command(ScheduledCommand(command_type="fast_ci_scan", target_time=START))

    recovered = event("missed-job", finished_at=START + timedelta(minutes=40))
    source.rows = [recovered]
    catch_up_target = START + timedelta(hours=1)
    result = runtime.process_command(
        ScheduledCommand(command_type="fast_ci_scan", target_time=catch_up_target)
    )

    assert result.status is ProcessStatus.COMPLETED
    assert source.calls[-1] == (START - timedelta(minutes=15), catch_up_target)
    assert fast_ci.events() == [recovered]
    assert fast_ci.scan_cursor() == catch_up_target
    assert outbox.count() == 1


def test_scan_persists_event_and_outbox_while_slack_is_unavailable() -> None:
    source = FixtureFastCISource([event("job-1")])
    runtime, _, outbox, fast_ci = make_runtime(source, slack=UnavailableSlackPort())

    result = runtime.process_command(
        ScheduledCommand(command_type="fast_ci_scan", target_time=START)
    )

    assert result.status is ProcessStatus.COMPLETED
    assert len(fast_ci.events()) == 1
    assert outbox.records()[0].status is OutboxStatus.PENDING


def test_shadow_scan_persists_rendered_output_without_slack_delivery() -> None:
    source = FixtureFastCISource([event("job-1")])
    slack = RecordingSlackPort()
    runtime, _, outbox, _ = make_runtime(
        source,
        slack=slack,
        delivery_mode=DeliveryMode.SHADOW,
    )

    runtime.process_command(ScheduledCommand(command_type="fast_ci_scan", target_time=START))
    result = runtime.dispatch_due_notifications()

    assert result.delivered == 0
    records = outbox.records()
    assert len(records) == 1
    assert records[0].delivery_mode is DeliveryMode.SHADOW
    assert "Fast CI job failure alert" in records[0].payload["text"]
    assert slack.deliveries == []


def test_failed_transaction_cannot_advance_cursor_past_unrecorded_event() -> None:
    source = FixtureFastCISource([event("job-1")])
    runtime, executions, outbox, fast_ci = make_runtime(source)
    command = ScheduledCommand(command_type="fast_ci_scan", target_time=START)
    fast_ci.fail_next_commit()

    result = runtime.process_command(command)

    assert result.status is ProcessStatus.FAILED
    assert fast_ci.scan_cursor() is None
    assert fast_ci.events() == []
    assert outbox.count() == 0
    record = executions.get(command.idempotency_key)
    assert record is not None
    assert record.status is AutomationExecutionStatus.FAILED

    assert runtime.process_command(command).status is ProcessStatus.COMPLETED
    assert fast_ci.scan_cursor() == START
    assert [stored.job_id for stored in fast_ci.events()] == ["job-1"]
    assert outbox.count() == 1


def test_databricks_source_maps_fixture_to_fast_failure_event() -> None:
    finished_at = "2026-08-27T18:59:30Z"
    databricks = RecordingDatabricks(
        [
            {
                "job_id": "job-1",
                "job_name": "fast test",
                "job_url": "https://buildkite.com/vllm/ci/builds/123#job-1",
                "state": "timed_out",
                "soft_failed": "true",
                "duration_secs": "30",
                "finished_at": finished_at,
                "build_url": "https://buildkite.com/vllm/ci/builds/123",
                "message": "failed",
                "commit_sha": "abcdef",
                "branch": "main",
                "author": "tester",
                "pr_number": "456",
                "pipeline": "CI",
            }
        ]
    )
    source = DatabricksFastCISource(databricks)

    rows = source.fetch_failures(
        start_time=START - timedelta(minutes=30), end_time=START
    )

    assert len(databricks.queries) == 1
    assert rows == [
        FastFailureEvent(
            job_id="job-1",
            job_name="fast test",
            job_url="https://buildkite.com/vllm/ci/builds/123#job-1",
            state=FastFailureState.TIMED_OUT,
            soft_failed=True,
            duration_seconds=30,
            finished_at=datetime(2026, 8, 27, 18, 59, 30, tzinfo=timezone.utc),
            build_url="https://buildkite.com/vllm/ci/builds/123",
            message="failed",
            commit_sha="abcdef",
            branch="main",
            author="tester",
            pr_number="456",
            pipeline="CI",
        )
    ]


def test_fast_failure_event_has_no_resolution_lifecycle() -> None:
    stored = event("job-1")

    assert not hasattr(stored, "status")
    assert not hasattr(stored, "resolved_at")


def test_slack_channel_env_override_wins(monkeypatch: Any) -> None:
    import alerting.fast_ci as fast_ci

    monkeypatch.delenv("SLACK_CHANNEL_ID", raising=False)
    assert fast_ci.slack_channel() == fast_ci.ALERTS_SLACK_CHANNEL
    monkeypatch.setenv("SLACK_CHANNEL_ID", "C0NEWCHANNEL")
    assert fast_ci.slack_channel() == "C0NEWCHANNEL"
