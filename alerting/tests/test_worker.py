"""Worker entry-point behavior."""

from datetime import datetime, timezone

import pytest

from alerting import worker
from alerting.commands import ScheduledCommand
from alerting.ports import Clock, DeliveryMode
from alerting.runtime import DispatchResult, ProcessResult, ProcessStatus


class RecordingRuntime:
    def __init__(self) -> None:
        self.commands: list[ScheduledCommand] = []
        self.dispatches = 0

    def process_command(self, command: ScheduledCommand) -> ProcessResult:
        self.commands.append(command)
        return ProcessResult(command.idempotency_key, ProcessStatus.COMPLETED)

    def dispatch_due_notifications(self) -> DispatchResult:
        self.dispatches += 1
        return DispatchResult(delivered=1)


def test_timer_worker_dispatches_notifications_after_reconciliation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = RecordingRuntime()
    observed_modes: list[DeliveryMode] = []

    def recording_runtime(
        consumer: str,
        clock: Clock,
        delivery_mode: DeliveryMode,
    ) -> RecordingRuntime:
        observed_modes.append(delivery_mode)
        return runtime

    monkeypatch.delenv("ALERTING_DELIVERY_MODE", raising=False)
    monkeypatch.setattr(worker, "_runtime", recording_runtime)
    monkeypatch.setattr(
        worker.SystemClock,
        "now",
        lambda self: datetime(2026, 8, 27, 19, 0, tzinfo=timezone.utc),
    )

    assert worker.main(["fast-ci"]) == 0
    assert [command.command_type for command in runtime.commands] == ["fast_ci_scan"]
    assert runtime.dispatches == 1
    assert observed_modes == [DeliveryMode.SHADOW]


def test_timer_worker_uses_explicit_live_delivery_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = RecordingRuntime()
    observed_modes: list[DeliveryMode] = []

    def recording_runtime(
        consumer: str,
        clock: Clock,
        delivery_mode: DeliveryMode,
    ) -> RecordingRuntime:
        observed_modes.append(delivery_mode)
        return runtime

    monkeypatch.setenv("ALERTING_DELIVERY_MODE", "live")
    monkeypatch.setattr(worker, "_runtime", recording_runtime)

    assert worker.main(["full-ci-analyze"]) == 0
    assert observed_modes == [DeliveryMode.LIVE]


def test_main_ci_timer_uses_its_lifecycle_reconciliation_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = RecordingRuntime()
    monkeypatch.setattr(worker, "_runtime", lambda *args: runtime)

    assert worker.main(["main-ci"]) == 0
    assert [command.command_type for command in runtime.commands] == [
        "main_ci_reconcile"
    ]


def test_main_ci_analysis_timer_uses_its_sidecar_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = RecordingRuntime()
    monkeypatch.setattr(worker, "_runtime", lambda *args: runtime)

    assert worker.main(["main-ci-analyze"]) == 0
    assert [command.command_type for command in runtime.commands] == ["main_ci_analyze"]
