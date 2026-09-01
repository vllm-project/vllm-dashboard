"""Apply per-path shadow, live, or disabled state from durable S3 controls."""

from __future__ import annotations

import argparse
import os
import subprocess
from collections.abc import Sequence
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from alerting.ports import AlertPath, DeliveryMode


class ControlMode(StrEnum):
    SHADOW = "shadow"
    LIVE = "live"
    DISABLED = "disabled"


class AlertControl(Protocol):
    def read(self, alert_path: AlertPath) -> ControlMode | None: ...

    def write(self, alert_path: AlertPath, mode: ControlMode) -> None: ...


class UnitControl(Protocol):
    def enable(self, timer: str) -> None: ...

    def disable(self, timer: str) -> None: ...

    def stop(self, service: str) -> None: ...


_UNITS = {
    AlertPath.FAST_CI: (("alerting-fast-ci.timer", "alerting-fast-ci.service"),),
    AlertPath.FULL_CI: (("alerting-full-ci.timer", "alerting-full-ci.service"),),
    # The analysis sidecar follows the Main CI control: disabling the path
    # stops both its lifecycle reconciliation and its AI analysis. The hourly
    # backstop sweep follows the same control.
    AlertPath.MAIN_CI: (
        ("alerting-main-ci.timer", "alerting-main-ci.service"),
        ("alerting-main-ci-analysis.timer", "alerting-main-ci-analysis.service"),
        ("alerting-main-ci-backstop.timer", "alerting-main-ci-backstop.service"),
    ),
}
_MODE_FILES = {
    AlertPath.FAST_CI: "fast-ci.mode",
    AlertPath.FULL_CI: "full-ci.mode",
    AlertPath.MAIN_CI: "main-ci.mode",
}


def _write_mode(path: Path, mode: DeliveryMode) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(f"ALERTING_DELIVERY_MODE={mode.value}\n")
    temporary.chmod(0o644)
    os.replace(temporary, path)


def reconcile_controls(
    *,
    controls: AlertControl,
    units: UnitControl,
    mode_dir: Path = Path("/run/alerting"),
) -> None:
    for alert_path in AlertPath:
        mode = controls.read(alert_path)
        if mode is None:
            mode = ControlMode.SHADOW
            controls.write(alert_path, mode)

        delivery_mode = (
            DeliveryMode.LIVE if mode is ControlMode.LIVE else DeliveryMode.SHADOW
        )
        _write_mode(mode_dir / _MODE_FILES[alert_path], delivery_mode)
        for timer, service in _UNITS[alert_path]:
            if mode is ControlMode.DISABLED:
                units.disable(timer)
                units.stop(service)
            else:
                units.enable(timer)


class S3AlertControl:
    def __init__(self, *, bucket: str, client: Any | None = None) -> None:
        if client is None:
            import boto3  # type: ignore[import-not-found,import-untyped]

            client = boto3.client("s3")
        self._bucket = bucket
        self._client = client

    @staticmethod
    def _key(alert_path: AlertPath) -> str:
        return f"control/{alert_path.value}.mode"

    def read(self, alert_path: AlertPath) -> ControlMode | None:
        try:
            response = self._client.get_object(
                Bucket=self._bucket,
                Key=self._key(alert_path),
            )
        except Exception as exc:
            details = getattr(exc, "response", {})
            code = (
                details.get("Error", {}).get("Code")
                if isinstance(details, dict)
                else None
            )
            if code in {"NoSuchKey", "404"}:
                return None
            raise
        value = response["Body"].read().decode().strip()
        return ControlMode(value)

    def write(self, alert_path: AlertPath, mode: ControlMode) -> None:
        self._client.put_object(
            Bucket=self._bucket,
            Key=self._key(alert_path),
            Body=f"{mode.value}\n".encode(),
            ContentType="text/plain",
        )


class SystemdUnits:
    @staticmethod
    def _run(*arguments: str) -> None:
        subprocess.run(["systemctl", *arguments], check=True)

    def enable(self, timer: str) -> None:
        self._run("enable", "--now", timer)

    def disable(self, timer: str) -> None:
        self._run("disable", "--now", timer)

    def stop(self, service: str) -> None:
        self._run("stop", service)


def main(arguments: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Apply S3 alert-path controls")
    parser.add_argument("--bucket", required=True)
    args = parser.parse_args(arguments)
    reconcile_controls(
        controls=S3AlertControl(bucket=args.bucket),
        units=SystemdUnits(),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
