"""Fast CI behavior through the scheduled-command runtime seam."""

import io
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

import pytest

from alerting.commands import ScheduledCommand
from alerting.fast_ci import (
    ClickHouseQueryClient,
    FastCIScanHandler,
    FastCISource,
    FastFailureEvent,
    FastFailureState,
    WarehouseFastCISource,
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


class RecordingWarehouse:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.queries: list[str] = []
        self.params: list[Mapping[str, str] | None] = []

    def query(
        self, sql: str, params: Mapping[str, str] | None = None
    ) -> list[dict[str, Any]]:
        self.queries.append(sql)
        self.params.append(params)
        return self.rows


class UnavailableSlackPort:
    def deliver(self, _record: NotificationIntentRecord) -> str | None:
        raise RuntimeError("slack unavailable")

    def update_message(
        self, *, channel: str, ts: str, payload: Mapping[str, Any]
    ) -> None:
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
    assert (
        "8 jobs failed in 30s or less (main branch, required jobs only) — batch 1/2"
        in records[0].payload["text"]
    )
    assert (
        "2 jobs failed in 30s or less (main branch, required jobs only) — batch 2/2"
        in records[1].payload["text"]
    )
    assert records[0].payload["text"].count(":red_circle:") == 8
    assert records[1].payload["text"].count(":red_circle:") == 2
    assert "GPU &lt;fast&gt; 'test'" in records[0].payload["text"]
    assert "CI #123" in records[0].payload["text"]
    assert "> A failure with whitespace" in records[0].payload["text"]
    assert records[0].payload["blocks"][0]["text"]["text"] == (
        "⚡ FAST CI · 8 jobs failed in 30s or less"
        " (main branch, required jobs only) — batch 1/2"
    )
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
        "10 jobs failed in 30s or less (main branch, required jobs only) "
        "while notifications were unavailable"
    )
    assert recovery.payload["text"].count(":red_circle:") == 10
    assert recovery.payload["blocks"][0]["text"]["text"] == (
        "⚡ FAST CI · 10 jobs failed in 30s or less (main branch, required jobs"
        " only) while notifications were unavailable"
    )
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


def clickhouse_row(**overrides: Any) -> dict[str, Any]:
    """A result row shaped like ClickHouse JSONEachRow output."""
    row: dict[str, Any] = {
        "job_id": "job-1",
        "job_name": "fast test",
        "job_url": "https://buildkite.com/vllm/ci/builds/123#job-1",
        "state": "timed_out",
        "soft_failed": False,
        "duration_secs": "30",
        "finished_at": "2026-08-27T18:59:30.123456Z",
        "build_url": "https://buildkite.com/vllm/ci/builds/123",
        "message": "failed",
        "commit_sha": "abcdef",
        "branch": "main",
        "author": "tester",
        "pr_number": "456",
        "pipeline": "CI",
    }
    row.update(overrides)
    return row


def test_warehouse_source_maps_clickhouse_row_to_fast_failure_event() -> None:
    warehouse = RecordingWarehouse([clickhouse_row()])
    source = WarehouseFastCISource(warehouse)

    rows = source.fetch_failures(
        start_time=START - timedelta(minutes=30), end_time=START
    )

    assert len(warehouse.queries) == 1
    assert rows == [
        FastFailureEvent(
            job_id="job-1",
            job_name="fast test",
            job_url="https://buildkite.com/vllm/ci/builds/123#job-1",
            state=FastFailureState.TIMED_OUT,
            soft_failed=False,
            duration_seconds=30,
            finished_at=datetime(
                2026, 8, 27, 18, 59, 30, 123456, tzinfo=timezone.utc
            ),
            build_url="https://buildkite.com/vllm/ci/builds/123",
            message="failed",
            commit_sha="abcdef",
            branch="main",
            author="tester",
            pr_number="456",
            pipeline="CI",
        )
    ]


def test_warehouse_source_accepts_native_json_bool_int_and_null() -> None:
    warehouse = RecordingWarehouse(
        [clickhouse_row(soft_failed=True, duration_secs=7, pr_number=None)]
    )

    [row] = WarehouseFastCISource(warehouse).fetch_failures(
        start_time=START - timedelta(minutes=30), end_time=START
    )

    assert row.soft_failed is True
    assert row.duration_seconds == 7
    assert row.pr_number is None


def test_warehouse_query_scopes_to_main_branch_required_jobs() -> None:
    warehouse = RecordingWarehouse([])
    source = WarehouseFastCISource(warehouse)

    source.fetch_failures(start_time=START - timedelta(minutes=30), end_time=START)

    assert len(warehouse.queries) == 1
    sql = warehouse.queries[0]
    assert "branch = 'main'" in sql
    assert "j.soft_failed = false" in sql
    assert "buildkite.build_job AS j FINAL" in sql
    assert "NOT j._fivetran_deleted" in sql
    assert "j.build_id IN (SELECT id FROM" in sql
    # Bounds are bound as typed parameters, never interpolated.
    assert "{start_time:DateTime64(6, 'UTC')}" in sql
    assert "2026-08-27" not in sql
    assert warehouse.params == [
        {
            "start_time": "2026-08-27 18:30:00.000000",
            "end_time": "2026-08-27 19:00:00.000000",
        }
    ]


class FakeResponse:
    def __init__(self, body: str) -> None:
        self._body = body.encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None


def _capture_urlopen(
    monkeypatch: pytest.MonkeyPatch, body: str
) -> list[tuple[urllib.request.Request, float]]:
    calls: list[tuple[urllib.request.Request, float]] = []

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> FakeResponse:
        calls.append((request, timeout))
        return FakeResponse(body)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return calls


def test_clickhouse_client_posts_sql_with_settings_and_typed_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _capture_urlopen(
        monkeypatch, '{"job_id":"a","soft_failed":false}\n{"job_id":"b","soft_failed":true}\n'
    )
    client = ClickHouseQueryClient(
        url="https://ch.example:443/", user="reader", password="secret"
    )

    rows = client.query("SELECT 1", {"start_time": "2026-08-27 18:30:00.000000"})

    assert rows == [
        {"job_id": "a", "soft_failed": False},
        {"job_id": "b", "soft_failed": True},
    ]
    [(request, timeout)] = calls
    assert timeout == 110
    assert request.get_method() == "POST"
    assert request.data == b"SELECT 1"
    assert request.get_header("X-clickhouse-user") == "reader"
    assert request.get_header("X-clickhouse-key") == "secret"
    url = urllib.parse.urlsplit(request.full_url)
    assert f"{url.scheme}://{url.netloc}{url.path}" == "https://ch.example:443/"
    query = dict(urllib.parse.parse_qsl(url.query))
    assert query["default_format"] == "JSONEachRow"
    assert query["date_time_output_format"] == "iso"
    assert query["max_execution_time"] == "100"
    assert query["param_start_time"] == "2026-08-27 18:30:00.000000"
    assert "secret" not in request.full_url


def test_clickhouse_client_raises_on_mid_stream_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _capture_urlopen(
        monkeypatch,
        '{"job_id":"a"}\nCode: 159. DB::Exception: Timeout exceeded. (TIMEOUT_EXCEEDED)\n',
    )
    client = ClickHouseQueryClient(url="https://ch.example", user="u", password="p")

    with pytest.raises(RuntimeError, match="mid-stream: Code: 159"):
        client.query("SELECT 1")


def test_clickhouse_client_reports_http_errors_without_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def failing_urlopen(request: urllib.request.Request, timeout: float) -> FakeResponse:
        raise urllib.error.HTTPError(
            request.full_url,
            516,
            "Unauthorized",
            hdrs=None,  # type: ignore[arg-type]
            fp=io.BytesIO(b"Code: 516. DB::Exception: reader: Authentication failed"),
        )

    monkeypatch.setattr(urllib.request, "urlopen", failing_urlopen)
    client = ClickHouseQueryClient(url="https://ch.example", user="reader", password="secret")

    with pytest.raises(RuntimeError, match="HTTP 516: Code: 516") as raised:
        client.query("SELECT 1")
    assert "secret" not in str(raised.value)


def test_leading_job_emoji_stays_outside_the_slack_link_label() -> None:
    named = replace(event("job-1"), job_name=":nvidia: (L4) Distributed 2-Node")
    source = FixtureFastCISource([named])
    runtime, _, outbox, _ = make_runtime(source)

    runtime.process_command(ScheduledCommand(command_type="fast_ci_scan", target_time=START))

    text = outbox.records()[0].payload["text"]
    assert (
        ":red_circle: :nvidia: "
        "<https://buildkite.com/vllm/ci/builds/123#job-1|(L4) Distributed 2-Node>"
    ) in text
    assert "|:nvidia:" not in text


def test_fast_failure_event_has_no_resolution_lifecycle() -> None:
    stored = event("job-1")

    assert not hasattr(stored, "status")
    assert not hasattr(stored, "resolved_at")


def test_alerts_share_one_channel_and_full_ci_keeps_its_own(
    monkeypatch: Any,
) -> None:
    import alerting.fast_ci as fast_ci

    for var in (
        "SLACK_CI_ALERT_CHANNEL",
        "SLACK_CI_NOTIFICATIONS_CHANNEL",
        "SLACK_CHANNEL_ID",
    ):
        monkeypatch.delenv(var, raising=False)
    assert fast_ci.slack_channel() == "C0ANHBE642Y"
    assert fast_ci.full_ci_slack_channel() == "C0ABTNM9L5U"

    # The legacy shared variable now moves Full CI only.
    monkeypatch.setenv("SLACK_CHANNEL_ID", "C0LEGACY")
    assert fast_ci.slack_channel() == "C0ANHBE642Y"
    assert fast_ci.full_ci_slack_channel() == "C0LEGACY"

    monkeypatch.setenv("SLACK_CI_ALERT_CHANNEL", "C0ALERTS")
    monkeypatch.setenv("SLACK_CI_NOTIFICATIONS_CHANNEL", "C0NOTIFY")
    assert fast_ci.slack_channel() == "C0ALERTS"
    assert fast_ci.full_ci_slack_channel() == "C0NOTIFY"


def test_infra_alerts_post_where_the_daily_summary_does(monkeypatch: Any) -> None:
    import alerting.fast_ci as fast_ci

    monkeypatch.setenv("SLACK_CI_ALERT_CHANNEL", "C0ALERTS")
    monkeypatch.delenv("SLACK_CI_INFRA_ALERT_CHANNEL", raising=False)
    assert fast_ci.infra_slack_channel() == "C0ALERTS"

    monkeypatch.setenv("SLACK_CI_INFRA_ALERT_CHANNEL", "C0INFRA")
    assert fast_ci.infra_slack_channel() == "C0INFRA"
    assert fast_ci.slack_channel() == "C0ALERTS"
