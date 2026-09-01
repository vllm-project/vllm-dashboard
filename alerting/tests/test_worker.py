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


def test_main_ci_backstop_timer_uses_its_sweep_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = RecordingRuntime()
    monkeypatch.setattr(worker, "_runtime", lambda *args: runtime)

    assert worker.main(["main-ci-backstop"]) == 0
    assert [command.command_type for command in runtime.commands] == [
        "main_ci_backstop"
    ]


def _set_analysis_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://example.invalid/alerting")
    monkeypatch.setenv("BUILDKITE_TOKEN", "bk-token")
    monkeypatch.setenv("GITHUB_TOKEN", "gh-token")
    monkeypatch.setenv("KIMI_API_KEY", "kimi-key")
    monkeypatch.setenv("ALERTING_CHECKPOINT_BUCKET", "checkpoint-bucket")


def _capture_main_ci_analysis_kwargs(
    monkeypatch: pytest.MonkeyPatch,
) -> dict[str, object]:
    captured: dict[str, object] = {}

    def fake_build(**kwargs: object) -> RecordingRuntime:
        captured.update(kwargs)
        return RecordingRuntime()

    monkeypatch.setattr(worker, "build_main_ci_analysis_runtime", fake_build)
    return captured


def _capture_full_ci_analysis_kwargs(
    monkeypatch: pytest.MonkeyPatch,
) -> dict[str, object]:
    captured: dict[str, object] = {}

    def fake_build(**kwargs: object) -> RecordingRuntime:
        captured.update(kwargs)
        return RecordingRuntime()

    monkeypatch.setattr(worker, "build_full_ci_analysis_runtime", fake_build)
    return captured


def test_main_ci_analysis_defaults_to_max_effort_and_longer_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_analysis_environment(monkeypatch)
    for name in (
        "KIMI_MAIN_CI_REASONING_EFFORT",
        "KIMI_MAIN_CI_TIMEOUT_SECONDS",
        "KIMI_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)
    # The shared worker env must not leak into the Main CI analyzer.
    monkeypatch.setenv("KIMI_REASONING_EFFORT", "high")
    captured = _capture_main_ci_analysis_kwargs(monkeypatch)

    worker._runtime("main-ci-analyze", worker.SystemClock(), DeliveryMode.SHADOW)

    assert captured["kimi_reasoning_effort"] == "max"
    assert captured["kimi_timeout_seconds"] == 1200


def test_main_ci_analysis_honors_dedicated_env_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_analysis_environment(monkeypatch)
    monkeypatch.setenv("KIMI_MAIN_CI_REASONING_EFFORT", "low")
    monkeypatch.setenv("KIMI_MAIN_CI_TIMEOUT_SECONDS", "300")
    captured = _capture_main_ci_analysis_kwargs(monkeypatch)

    worker._runtime("main-ci-analyze", worker.SystemClock(), DeliveryMode.SHADOW)

    assert captured["kimi_reasoning_effort"] == "low"
    assert captured["kimi_timeout_seconds"] == 300


def test_full_ci_analysis_still_uses_shared_kimi_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_analysis_environment(monkeypatch)
    monkeypatch.delenv("KIMI_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("KIMI_TIMEOUT_SECONDS", raising=False)
    # Main-CI-specific overrides must not affect the Full CI analyzer.
    monkeypatch.setenv("KIMI_MAIN_CI_REASONING_EFFORT", "low")
    monkeypatch.setenv("KIMI_MAIN_CI_TIMEOUT_SECONDS", "300")
    captured = _capture_full_ci_analysis_kwargs(monkeypatch)

    worker._runtime("full-ci-analyze", worker.SystemClock(), DeliveryMode.SHADOW)

    assert captured["kimi_reasoning_effort"] == "low"
    assert captured["kimi_timeout_seconds"] == 3600

    monkeypatch.setenv("KIMI_REASONING_EFFORT", "high")
    monkeypatch.setenv("KIMI_TIMEOUT_SECONDS", "900")
    captured.clear()

    worker._runtime("full-ci-analyze", worker.SystemClock(), DeliveryMode.SHADOW)

    assert captured["kimi_reasoning_effort"] == "high"
    assert captured["kimi_timeout_seconds"] == 900
