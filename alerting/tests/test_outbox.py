"""Tests for the notification outbox and dispatch through the runtime seam.

Assertions target delivery state (pending, delivered, retrying, dead-lettered),
not retry internals.
"""

from datetime import datetime, timezone
from typing import Any, Mapping

import pytest

from alerting.memory import (
    FixedClock,
    InMemoryAutomationExecutionStore,
    InMemoryOutboxStore,
    RecordingSlackPort,
)
from alerting.ports import (
    AlertPath,
    DeliveryMode,
    DestinationMode,
    NotificationIntent,
    NotificationIntentRecord,
    OutboxStatus,
    SlackPermanentError,
    SlackPort,
    SlackTransientError,
)
from alerting.runtime import AlertingRuntime

START = datetime(2026, 8, 27, 19, 0, tzinfo=timezone.utc)


class SimulatedWorkerCrash(BaseException):
    pass


class AcceptThenCrashSlackPort:
    def __init__(self) -> None:
        self.accepted_delivery_ids: list[str] = []

    def deliver(self, record: NotificationIntentRecord) -> str | None:
        self.accepted_delivery_ids.append(record.delivery_id)
        raise SimulatedWorkerCrash

    def update_message(self, **_kwargs: object) -> None:
        raise SimulatedWorkerCrash


def make_message(
    delivery_id: str = "fast-ci:batch-1",
    *,
    alert_path: AlertPath = AlertPath.FAST_CI,
    delivery_mode: DeliveryMode = DeliveryMode.LIVE,
) -> NotificationIntent:
    return NotificationIntent(
        delivery_id=delivery_id,
        alert_ref="fast_failure_event:12345",
        alert_path=alert_path,
        delivery_mode=delivery_mode,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination="C0ANHBE642Y",
        payload={"text": "8 jobs failed within 30s"},
    )


def make_runtime(
    outbox: InMemoryOutboxStore,
    slack: SlackPort,
    clock: FixedClock,
    *,
    alert_path: AlertPath | None = None,
) -> AlertingRuntime:
    return AlertingRuntime(
        executions=InMemoryAutomationExecutionStore(),
        outbox=outbox,
        slack=slack,
        clock=clock,
        handlers={},
        alert_path=alert_path,
    )


def test_due_pending_record_is_delivered_with_slack_ts() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort(ts="1724900000.001")
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    outbox.enqueue(make_message(), now=clock.now())

    result = runtime.dispatch_due_notifications()

    assert result.delivered == 1
    record = outbox.get_outbox("fast-ci:batch-1")
    assert record is not None
    assert record.status is OutboxStatus.DELIVERED
    assert record.slack_ts == "1724900000.001"
    assert record.attempts == 1
    assert [r.delivery_id for r in slack.deliveries] == ["fast-ci:batch-1"]


def test_shadow_record_is_persisted_but_never_delivered() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    outbox.enqueue(
        make_message(delivery_mode=DeliveryMode.SHADOW),
        now=clock.now(),
    )

    result = runtime.dispatch_due_notifications()

    assert result.delivered == 0
    record = outbox.get_outbox("fast-ci:batch-1")
    assert record is not None
    assert record.status is OutboxStatus.PENDING
    assert record.delivery_mode is DeliveryMode.SHADOW
    assert record.payload == {"text": "8 jobs failed within 30s"}
    assert slack.deliveries == []


def test_dispatch_is_isolated_to_one_alert_path() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    clock = FixedClock(START)
    runtime = make_runtime(
        outbox,
        slack,
        clock,
        alert_path=AlertPath.FAST_CI,
    )
    outbox.enqueue(make_message("fast-ci:1"), now=clock.now())
    outbox.enqueue(
        make_message("full-ci:1", alert_path=AlertPath.FULL_CI),
        now=clock.now(),
    )

    result = runtime.dispatch_due_notifications()

    assert result.delivered == 1
    assert [record.delivery_id for record in slack.deliveries] == ["fast-ci:1"]
    full_ci = outbox.get_outbox("full-ci:1")
    assert full_ci is not None
    assert full_ci.status is OutboxStatus.PENDING


def test_delivered_record_is_never_redelivered() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    outbox.enqueue(make_message(), now=clock.now())

    runtime.dispatch_due_notifications()
    runtime.dispatch_due_notifications()

    assert len(slack.deliveries) == 1


def test_transient_failure_retries_later_and_then_delivers() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    slack.fail_next("fast-ci:batch-1", SlackTransientError("http 503"))
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    outbox.enqueue(make_message(), now=clock.now())

    first = runtime.dispatch_due_notifications()
    assert first.retried == 1
    record = outbox.get_outbox("fast-ci:batch-1")
    assert record is not None
    assert record.status is OutboxStatus.RETRYING
    assert record.next_attempt_at > clock.now()
    assert "http 503" in (record.last_error or "")

    # Not due yet: nothing happens.
    assert runtime.dispatch_due_notifications().delivered == 0

    clock.advance(minutes=90)
    second = runtime.dispatch_due_notifications()
    assert second.delivered == 1
    record = outbox.get_outbox("fast-ci:batch-1")
    assert record is not None
    assert record.status is OutboxStatus.DELIVERED
    assert record.attempts == 2


def test_slack_retry_after_is_honored() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    slack.fail_next(
        "fast-ci:batch-1", SlackTransientError("rate limited", retry_after=120.0)
    )
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    outbox.enqueue(make_message(), now=clock.now())

    runtime.dispatch_due_notifications()

    record = outbox.get_outbox("fast-ci:batch-1")
    assert record is not None
    assert record.status is OutboxStatus.RETRYING
    assert (record.next_attempt_at - START).total_seconds() == pytest.approx(120.0)


def test_permanent_failure_is_dead_lettered_with_diagnostics() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    slack.fail_next("fast-ci:batch-1", SlackPermanentError("invalid_blocks"))
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    outbox.enqueue(make_message(), now=clock.now())

    result = runtime.dispatch_due_notifications()

    assert result.dead_lettered == 1
    record = outbox.get_outbox("fast-ci:batch-1")
    assert record is not None
    assert record.status is OutboxStatus.DEAD_LETTER
    assert "invalid_blocks" in (record.last_error or "")
    # Dead-lettered records are terminal.
    clock.advance(minutes=90)
    assert runtime.dispatch_due_notifications().delivered == 0


def test_exhausted_attempts_dead_letter_the_record() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    outbox.enqueue(make_message(), now=clock.now())

    for _ in range(20):
        slack.fail_next("fast-ci:batch-1", SlackTransientError("http 503"))
        runtime.dispatch_due_notifications()
        record = outbox.get_outbox("fast-ci:batch-1")
        assert record is not None
        if record.status is OutboxStatus.DEAD_LETTER:
            break
        clock.advance(minutes=120)
    else:
        pytest.fail("record was never dead-lettered after repeated transient failures")

    assert len(slack.deliveries) == 0


def test_dispatch_only_touches_due_records() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    outbox.enqueue(make_message("due"), now=clock.now())
    outbox.enqueue(
        make_message("future"),
        now=clock.now(),
        next_attempt_at=clock.advance_preview(minutes=60),
    )

    result = runtime.dispatch_due_notifications()

    assert result.delivered == 1
    future = outbox.get_outbox("future")
    assert future is not None
    assert future.status is OutboxStatus.PENDING


def test_duplicate_enqueue_is_a_noop() -> None:
    outbox = InMemoryOutboxStore()
    clock = FixedClock(START)
    outbox.enqueue(make_message(), now=clock.now())
    first = outbox.get_outbox("fast-ci:batch-1")

    # A retried handler re-enqueuing its deterministic delivery ID must not
    # fail or overwrite the original record.
    duplicate = NotificationIntent(
        delivery_id="fast-ci:batch-1",
        alert_ref="fast_failure_event:12345",
        alert_path=AlertPath.FAST_CI,
        delivery_mode=DeliveryMode.LIVE,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination="C0ANHBE642Y",
        payload={"text": "different payload"},
    )
    outbox.enqueue(duplicate, now=clock.now())

    assert outbox.get_outbox("fast-ci:batch-1") == first


def test_unexpected_delivery_error_retries_and_does_not_strand_the_batch() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    slack.fail_next("first", RuntimeError("connection reset"))
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    outbox.enqueue(make_message("first"), now=clock.now())
    clock.advance(seconds=1)
    outbox.enqueue(make_message("second"), now=clock.now())

    result = runtime.dispatch_due_notifications()

    assert result.retried == 1
    assert result.delivered == 1
    first = outbox.get_outbox("first")
    assert first is not None
    assert first.status is OutboxStatus.RETRYING
    assert "connection reset" in (first.last_error or "")
    second = outbox.get_outbox("second")
    assert second is not None
    assert second.status is OutboxStatus.DELIVERED


def test_slack_retry_after_is_never_shortened() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    slack.fail_next(
        "fast-ci:batch-1", SlackTransientError("rate limited", retry_after=1.7e9)
    )
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    outbox.enqueue(make_message(), now=clock.now())

    runtime.dispatch_due_notifications()

    record = outbox.get_outbox("fast-ci:batch-1")
    assert record is not None
    assert record.status is OutboxStatus.RETRYING
    assert (record.next_attempt_at - START).total_seconds() == pytest.approx(1.7e9)


def test_late_failure_cannot_regress_a_delivered_record() -> None:
    # A dispatcher whose lease expired mid-flight reports its stale outcome
    # after another dispatcher already delivered the record.
    outbox = InMemoryOutboxStore()
    clock = FixedClock(START)
    outbox.enqueue(make_message(), now=clock.now())
    outbox.lease_due(
        now=clock.now(), lease_until=clock.advance_preview(minutes=5), limit=10
    )
    outbox.mark_delivered("fast-ci:batch-1", slack_ts="1.0", now=clock.now())

    outbox.mark_retrying(
        "fast-ci:batch-1",
        error="stale transient error",
        next_attempt_at=clock.advance_preview(minutes=1),
        now=clock.now(),
    )
    outbox.mark_dead_letter("fast-ci:batch-1", error="stale permanent", now=clock.now())

    record = outbox.get_outbox("fast-ci:batch-1")
    assert record is not None
    assert record.status is OutboxStatus.DELIVERED
    assert record.slack_ts == "1.0"


def test_replacement_worker_recovers_expired_lease_with_stable_delivery_id() -> None:
    outbox = InMemoryOutboxStore()
    clock = FixedClock(START)
    crashed_slack = AcceptThenCrashSlackPort()
    first_worker = make_runtime(outbox, crashed_slack, clock)
    outbox.enqueue(make_message(), now=clock.now())

    with pytest.raises(SimulatedWorkerCrash):
        first_worker.dispatch_due_notifications()

    replacement_slack = RecordingSlackPort(ts="1724900000.002")
    replacement = make_runtime(outbox, replacement_slack, clock)
    assert replacement.dispatch_due_notifications().delivered == 0

    clock.advance(minutes=5)
    assert replacement.dispatch_due_notifications().delivered == 1

    record = outbox.get_outbox("fast-ci:batch-1")
    assert record is not None
    assert record.status is OutboxStatus.DELIVERED
    assert record.attempts == 2
    assert crashed_slack.accepted_delivery_ids == [record.delivery_id]
    assert [item.delivery_id for item in replacement_slack.deliveries] == [
        record.delivery_id
    ]


class _RejectingUpdateSlackPort(RecordingSlackPort):
    def update_message(
        self, *, channel: str, ts: str, payload: Mapping[str, Any]
    ) -> None:
        raise SlackPermanentError("message_not_found")


def _infra_pair(outbox: InMemoryOutboxStore, clock: FixedClock) -> None:
    outbox.enqueue(
        make_message(
            "infra:unreporting:abc123:100:open",
            alert_path=AlertPath.INFRA,
        ),
        now=clock.now(),
    )


def test_resolve_record_updates_the_paired_open_message_in_place() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort(ts="1724900000.001")
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    _infra_pair(outbox, clock)
    # The open alert spans multiple lines; Slack strikethrough must wrap
    # each line individually to render.
    open_record = outbox.get_outbox("infra:unreporting:abc123:100:open")
    assert open_record is not None
    open_record.payload["text"] = "Infra alert — host stopped reporting\nNo report for over 10 minutes"
    assert runtime.dispatch_due_notifications().delivered == 1

    outbox.enqueue(
        make_message(
            "infra:unreporting:abc123:100:resolve",
            alert_path=AlertPath.INFRA,
        ),
        now=clock.now(),
    )

    assert runtime.dispatch_due_notifications().delivered == 1

    # No new message: the bot struck through its own open alert instead.
    # Slack appends its own "(edited)" marker; the payload must not add one.
    assert [r.delivery_id for r in slack.deliveries] == [
        "infra:unreporting:abc123:100:open"
    ]
    assert slack.updates == [
        {
            "channel": "C0ANHBE642Y",
            "ts": "1724900000.001",
            "payload": {
                "text": ":white_check_mark: ~Infra alert — host stopped reporting~\n~No report for over 10 minutes~"
            },
        }
    ]
    resolved = outbox.get_outbox("infra:unreporting:abc123:100:resolve")
    assert resolved is not None
    assert resolved.status is OutboxStatus.DELIVERED
    assert resolved.slack_ts == "1724900000.001"


def test_resolve_without_delivered_open_posts_a_new_message() -> None:
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort(ts="1724900000.009")
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    outbox.enqueue(
        make_message(
            "infra:unreporting:abc123:100:resolve",
            alert_path=AlertPath.INFRA,
        ),
        now=clock.now(),
    )

    assert runtime.dispatch_due_notifications().delivered == 1

    assert slack.updates == []
    assert [r.delivery_id for r in slack.deliveries] == [
        "infra:unreporting:abc123:100:resolve"
    ]


def test_resolve_falls_back_to_post_when_the_open_message_is_gone() -> None:
    outbox = InMemoryOutboxStore()
    slack = _RejectingUpdateSlackPort(ts="1724900000.001")
    clock = FixedClock(START)
    runtime = make_runtime(outbox, slack, clock)
    _infra_pair(outbox, clock)
    assert runtime.dispatch_due_notifications().delivered == 1

    outbox.enqueue(
        make_message(
            "infra:unreporting:abc123:100:resolve",
            alert_path=AlertPath.INFRA,
        ),
        now=clock.now(),
    )
    assert runtime.dispatch_due_notifications().delivered == 1

    assert [r.delivery_id for r in slack.deliveries] == [
        "infra:unreporting:abc123:100:open",
        "infra:unreporting:abc123:100:resolve",
    ]
    resolved = outbox.get_outbox("infra:unreporting:abc123:100:resolve")
    assert resolved is not None
    assert resolved.status is OutboxStatus.DELIVERED
