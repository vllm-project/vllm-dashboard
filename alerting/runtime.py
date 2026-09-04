"""The runtime seam: idempotent command processing and outbox dispatch."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from math import isfinite
from random import random
from typing import Protocol

from alerting.commands import ScheduledCommand
from alerting.ports import (
    AlertPath,
    ClaimOutcome,
    Clock,
    AutomationExecutionStore,
    DestinationMode,
    NotificationIntentRecord,
    OutboxStatus,
    OutboxStore,
    SlackPermanentError,
    SlackPort,
    SlackTransientError,
)


class HandlerCompletion(Enum):
    """How a handler completed its command execution record."""

    TRANSACTIONAL = "transactional"


CommandHandler = Callable[[ScheduledCommand], HandlerCompletion | None]

DEFAULT_EXECUTION_LEASE = timedelta(minutes=30)
DEFAULT_DISPATCH_LEASE = timedelta(minutes=5)
DEFAULT_MAX_DELIVERY_ATTEMPTS = 10
_BACKOFF_BASE_SECONDS = 60.0
_BACKOFF_CAP_SECONDS = 3600.0


class UnknownCommandTypeError(Exception):
    """No handler is registered for the command's type."""


class ProcessStatus(Enum):
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED_ALREADY_COMPLETED = "skipped_already_completed"
    SKIPPED_IN_PROGRESS = "skipped_in_progress"


@dataclass(frozen=True)
class ProcessResult:
    idempotency_key: str
    status: ProcessStatus
    error: str | None = None


@dataclass(frozen=True)
class DispatchResult:
    delivered: int = 0
    retried: int = 0
    dead_lettered: int = 0


class StaleNotificationConsolidator(Protocol):
    def consolidate_stale_notifications(self, *, now: datetime) -> None: ...


def _backoff_seconds(attempts: int) -> float:
    maximum = min(
        _BACKOFF_CAP_SECONDS, _BACKOFF_BASE_SECONDS * float(2 ** max(0, attempts - 1))
    )
    return maximum / 2.0 + random() * maximum / 2.0


class AlertingRuntime:
    """Processes scheduled commands and dispatches due notifications.

    Consumers register one handler per command type. Most handlers let the
    runtime complete their execution record. A handler with durable effects
    can instead complete it inside the same transaction and return
    `HandlerCompletion.TRANSACTIONAL`.
    """

    def __init__(
        self,
        *,
        executions: AutomationExecutionStore,
        outbox: OutboxStore,
        slack: SlackPort,
        clock: Clock,
        handlers: Mapping[str, CommandHandler],
        execution_lease: timedelta = DEFAULT_EXECUTION_LEASE,
        dispatch_lease: timedelta = DEFAULT_DISPATCH_LEASE,
        max_delivery_attempts: int = DEFAULT_MAX_DELIVERY_ATTEMPTS,
        stale_notifications: StaleNotificationConsolidator | None = None,
        alert_path: AlertPath | None = None,
    ) -> None:
        self._executions = executions
        self._outbox = outbox
        self._slack = slack
        self._clock = clock
        self._handlers = dict(handlers)
        self._execution_lease = execution_lease
        self._dispatch_lease = dispatch_lease
        self._max_delivery_attempts = max_delivery_attempts
        self._stale_notifications = stale_notifications
        self._alert_path = alert_path

    def process_command(self, command: ScheduledCommand) -> ProcessResult:
        handler = self._handlers.get(command.command_type)
        if handler is None:
            raise UnknownCommandTypeError(command.command_type)

        key = command.idempotency_key
        now = self._clock.now()
        outcome = self._executions.claim(
            command, now=now, lease_until=now + self._execution_lease
        )
        if outcome is ClaimOutcome.ALREADY_COMPLETED:
            return ProcessResult(key, ProcessStatus.SKIPPED_ALREADY_COMPLETED)
        if outcome is ClaimOutcome.LEASE_HELD:
            return ProcessResult(key, ProcessStatus.SKIPPED_IN_PROGRESS)

        try:
            completion = handler(command)
        except Exception as exc:  # noqa: BLE001 — a failed handler must be recorded, not crash the tick
            self._executions.fail(key, str(exc), now=self._clock.now())
            return ProcessResult(key, ProcessStatus.FAILED, error=str(exc))
        if completion is not HandlerCompletion.TRANSACTIONAL:
            self._executions.complete(key, now=self._clock.now())
        return ProcessResult(key, ProcessStatus.COMPLETED)

    def _deliver_or_update(self, record: NotificationIntentRecord) -> str | None:
        """A resolve record edits its paired open message in place when possible.

        Infra notifications pair as `<base>:open` / `<base>:resolve`; when the
        open record was delivered via bot token we chat.update that message to
        a ✅-prefixed, struck-through copy of the original alert instead of
        posting a second message. Falls back to a fresh post when the original
        is gone (deleted message, shadow-era open, webhook destination).
        """
        if (
            record.delivery_id.endswith(":resolve")
            and record.destination_mode is DestinationMode.BOT_TOKEN
        ):
            open_record = self._outbox.get_outbox(
                record.delivery_id[: -len(":resolve")] + ":open"
            )
            if (
                open_record is not None
                and open_record.status is OutboxStatus.DELIVERED
                and open_record.slack_ts
            ):
                original = str(open_record.payload.get("text") or "")
                try:
                    self._slack.update_message(
                        channel=open_record.destination,
                        ts=open_record.slack_ts,
                        payload={
                            "text": f":white_check_mark: ~{original}~ (edited)"
                        },
                    )
                except SlackPermanentError:
                    # Original message deleted or channel gone: fresh post.
                    pass
                else:
                    return open_record.slack_ts
        return self._slack.deliver(record)

    def dispatch_due_notifications(self, *, limit: int = 50) -> DispatchResult:
        now = self._clock.now()
        if self._stale_notifications is not None:
            self._stale_notifications.consolidate_stale_notifications(now=now)
        records = self._outbox.lease_due(
            now=now,
            lease_until=now + self._dispatch_lease,
            limit=limit,
            alert_path=self._alert_path,
        )
        delivered = retried = dead_lettered = 0
        for record in records:
            try:
                slack_ts = self._deliver_or_update(record)
            except SlackPermanentError as exc:
                self._outbox.mark_dead_letter(
                    record.delivery_id, error=str(exc), now=self._clock.now()
                )
                dead_lettered += 1
            except Exception as exc:  # noqa: BLE001 — an unexpected error must not strand the rest of the batch
                record_now = self._clock.now()
                if record.attempts >= self._max_delivery_attempts:
                    self._outbox.mark_dead_letter(
                        record.delivery_id,
                        error=f"retries exhausted after {record.attempts} attempts: {exc}",
                        now=record_now,
                    )
                    dead_lettered += 1
                else:
                    retry_after = (
                        exc.retry_after
                        if isinstance(exc, SlackTransientError)
                        else None
                    )
                    delay = (
                        retry_after
                        if retry_after is not None
                        and retry_after >= 0.0
                        and isfinite(retry_after)
                        else _backoff_seconds(record.attempts)
                    )
                    self._outbox.mark_retrying(
                        record.delivery_id,
                        error=str(exc),
                        next_attempt_at=record_now + timedelta(seconds=delay),
                        now=record_now,
                    )
                    retried += 1
            else:
                self._outbox.mark_delivered(
                    record.delivery_id, slack_ts=slack_ts, now=self._clock.now()
                )
                delivered += 1
        return DispatchResult(
            delivered=delivered, retried=retried, dead_lettered=dead_lettered
        )
