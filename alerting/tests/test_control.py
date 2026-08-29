"""S3-backed timer control behavior through its application seam."""

from pathlib import Path

from alerting.control import (
    ControlMode,
    reconcile_controls,
)
from alerting.ports import AlertPath


class MemoryAlertControl:
    def __init__(self, modes: dict[AlertPath, ControlMode | None]) -> None:
        self.modes = modes
        self.writes: list[tuple[AlertPath, ControlMode]] = []

    def read(self, alert_path: AlertPath) -> ControlMode | None:
        return self.modes.get(alert_path)

    def write(self, alert_path: AlertPath, mode: ControlMode) -> None:
        self.modes[alert_path] = mode
        self.writes.append((alert_path, mode))


class RecordingUnits:
    def __init__(self) -> None:
        self.enabled: list[str] = []
        self.disabled: list[str] = []
        self.stopped: list[str] = []

    def enable(self, timer: str) -> None:
        self.enabled.append(timer)

    def disable(self, timer: str) -> None:
        self.disabled.append(timer)

    def stop(self, service: str) -> None:
        self.stopped.append(service)


def test_reconcile_controls_defaults_missing_path_to_shadow_and_disables_one_path(
    tmp_path: Path,
) -> None:
    controls = MemoryAlertControl(
        {
            AlertPath.FAST_CI: None,
            AlertPath.FULL_CI: ControlMode.DISABLED,
            AlertPath.MAIN_CI: ControlMode.DISABLED,
        }
    )
    units = RecordingUnits()

    reconcile_controls(controls=controls, units=units, mode_dir=tmp_path)

    assert controls.writes == [(AlertPath.FAST_CI, ControlMode.SHADOW)]
    assert (tmp_path / "fast-ci.mode").read_text() == (
        "ALERTING_DELIVERY_MODE=shadow\n"
    )
    assert (tmp_path / "full-ci.mode").read_text() == (
        "ALERTING_DELIVERY_MODE=shadow\n"
    )
    assert (tmp_path / "main-ci.mode").read_text() == (
        "ALERTING_DELIVERY_MODE=shadow\n"
    )
    assert units.enabled == ["alerting-fast-ci.timer"]
    assert units.disabled == ["alerting-full-ci.timer", "alerting-main-ci.timer"]
    assert units.stopped == [
        "alerting-full-ci.service",
        "alerting-main-ci.service",
    ]


def test_live_control_enables_only_selected_path(tmp_path: Path) -> None:
    controls = MemoryAlertControl(
        {
            AlertPath.FAST_CI: ControlMode.DISABLED,
            AlertPath.FULL_CI: ControlMode.LIVE,
            AlertPath.MAIN_CI: ControlMode.DISABLED,
        }
    )
    units = RecordingUnits()

    reconcile_controls(controls=controls, units=units, mode_dir=tmp_path)

    assert (tmp_path / "full-ci.mode").read_text() == ("ALERTING_DELIVERY_MODE=live\n")
    assert units.enabled == ["alerting-full-ci.timer"]


def test_main_ci_live_control_enables_its_independent_timer(tmp_path: Path) -> None:
    controls = MemoryAlertControl(
        {
            AlertPath.FAST_CI: ControlMode.DISABLED,
            AlertPath.FULL_CI: ControlMode.DISABLED,
            AlertPath.MAIN_CI: ControlMode.LIVE,
        }
    )
    units = RecordingUnits()

    reconcile_controls(controls=controls, units=units, mode_dir=tmp_path)

    assert (tmp_path / "main-ci.mode").read_text() == (
        "ALERTING_DELIVERY_MODE=live\n"
    )
    assert units.enabled == ["alerting-main-ci.timer"]
