"""Non-interactive entry point for timer-driven alerting consumers."""

from __future__ import annotations

import os
import sys
from collections.abc import Sequence
from datetime import datetime, timezone

from alerting.commands import ScheduledCommand
from alerting.ports import Clock, DeliveryMode
from alerting.postgres import (
    build_fast_ci_runtime,
    build_full_ci_analysis_runtime,
    build_full_ci_runtime,
    build_infra_runtime,
    build_main_ci_analysis_runtime,
    build_main_ci_backstop_runtime,
    build_main_ci_runtime,
)
from alerting.runtime import AlertingRuntime, ProcessStatus
from alerting.slack import SlackDeliveryPort


class SystemClock:
    """UTC wall clock used by production workers."""

    def now(self) -> datetime:
        return datetime.now(timezone.utc)


def _required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"required environment variable is missing: {name}")
    return value


def _slack() -> SlackDeliveryPort:
    # Both alert paths post through the bot token; no webhook destinations.
    return SlackDeliveryPort(
        bot_token=os.environ.get("SLACK_BOT_TOKEN"),
        webhook_urls={},
    )


def _delivery_mode() -> DeliveryMode:
    raw = os.environ.get("ALERTING_DELIVERY_MODE", DeliveryMode.SHADOW.value)
    try:
        return DeliveryMode(raw)
    except ValueError as exc:
        raise RuntimeError("ALERTING_DELIVERY_MODE must be 'shadow' or 'live'") from exc


def _runtime(
    consumer: str,
    clock: Clock,
    delivery_mode: DeliveryMode,
) -> AlertingRuntime:
    database_url = _required_environment("DATABASE_URL")
    if consumer == "fast-ci":
        return build_fast_ci_runtime(
            database_url=database_url,
            databricks_host=_required_environment("DATABRICKS_HOST"),
            databricks_token=_required_environment("DATABRICKS_TOKEN"),
            databricks_warehouse_id=_required_environment("DATABRICKS_WAREHOUSE_ID"),
            slack=_slack(),
            clock=clock,
            delivery_mode=delivery_mode,
        )
    if consumer == "full-ci":
        return build_full_ci_runtime(
            database_url=database_url,
            buildkite_token=_required_environment("BUILDKITE_TOKEN"),
            slack=_slack(),
            clock=clock,
            delivery_mode=delivery_mode,
        )
    if consumer == "full-ci-analyze":
        return build_full_ci_analysis_runtime(
            database_url=database_url,
            buildkite_token=_required_environment("BUILDKITE_TOKEN"),
            github_token=_required_environment("GITHUB_TOKEN"),
            checkpoint_bucket=_required_environment("ALERTING_CHECKPOINT_BUCKET"),
            kimi_api_key=_required_environment("KIMI_API_KEY"),
            kimi_base_url=os.environ.get(
                "KIMI_BASE_URL", "https://api2.inferact.dev/v1"
            ),
            kimi_model=os.environ.get("KIMI_MODEL", "moonshotai/Kimi-K3"),
            kimi_timeout_seconds=int(os.environ.get("KIMI_TIMEOUT_SECONDS", "3600")),
            kimi_reasoning_effort=os.environ.get("KIMI_REASONING_EFFORT", "low"),
            # Full CI triage calls can legitimately think for several minutes;
            # the default 300s read timeout killed a 24-minute analysis once.
            kimi_request_timeout_seconds=float(
                os.environ.get("KIMI_REQUEST_TIMEOUT_SECONDS", "900")
            ),
            slack=_slack(),
            clock=clock,
            delivery_mode=delivery_mode,
        )
    if consumer == "main-ci":
        return build_main_ci_runtime(
            database_url=database_url,
            buildkite_token=_required_environment("BUILDKITE_TOKEN"),
            slack=_slack(),
            clock=clock,
        )
    if consumer == "main-ci-backstop":
        return build_main_ci_backstop_runtime(
            database_url=database_url,
            buildkite_token=_required_environment("BUILDKITE_TOKEN"),
            slack=_slack(),
            clock=clock,
        )
    if consumer == "infra":
        # kubectl node-list sources are optional: the worker's security group
        # allows only 443/5432/6543 egress, so cluster API servers (6443) may
        # be unreachable. Unset = skip the source; set-but-failing still
        # fails the scan closed so misconfiguration is loud. Coverage without
        # kubectl is preserved transitively: the control-plane scrapers report
        # every cluster node, and a dead scraper silences (and alerts) all of
        # them.
        kubeconfigs = [
            path
            for name in (
                "GPU_REPORTER_KUBECONFIG_H100",
                "GPU_REPORTER_KUBECONFIG_DGX",
            )
            if (path := os.environ.get(name))
        ]
        return build_infra_runtime(
            database_url=database_url,
            buildkite_token=_required_environment("BUILDKITE_TOKEN"),
            kubeconfigs=kubeconfigs,
            slack=_slack(),
            clock=clock,
            delivery_mode=delivery_mode,
        )
    if consumer == "main-ci-analyze":
        return build_main_ci_analysis_runtime(
            database_url=database_url,
            buildkite_token=_required_environment("BUILDKITE_TOKEN"),
            github_token=_required_environment("GITHUB_TOKEN"),
            kimi_api_key=_required_environment("KIMI_API_KEY"),
            kimi_base_url=os.environ.get(
                "KIMI_BASE_URL", "https://api2.inferact.dev/v1"
            ),
            kimi_model=os.environ.get("KIMI_MODEL", "moonshotai/Kimi-K3"),
            # Main CI analysis is intentionally independent of the shared
            # KIMI_REASONING_EFFORT / KIMI_TIMEOUT_SECONDS so its latency and
            # reasoning budget stay independently bounded.
            # The per-job budget matches the ten-minute timer cadence; the
            # 30-minute execution lease still fences retries.
            kimi_timeout_seconds=int(
                os.environ.get("KIMI_MAIN_CI_TIMEOUT_SECONDS", "600")
            ),
            kimi_reasoning_effort=os.environ.get(
                "KIMI_MAIN_CI_REASONING_EFFORT", "high"
            ),
            slack=_slack(),
            clock=clock,
        )
    raise ValueError(f"unknown consumer: {consumer}")


def scheduled_command(consumer: str, target_time: datetime) -> ScheduledCommand:
    """Create one minute-stable reconciliation command for a timer wake-up."""
    if target_time.tzinfo is None:
        raise ValueError("target_time must be timezone-aware")
    command_types = {
        "fast-ci": "fast_ci_scan",
        "full-ci": "full_ci_reconcile",
        "full-ci-analyze": "full_ci_analyze",
        "main-ci": "main_ci_reconcile",
        "main-ci-backstop": "main_ci_backstop",
        "main-ci-analyze": "main_ci_analyze",
        "infra": "infra_scan",
    }
    try:
        command_type = command_types[consumer]
    except KeyError as exc:
        raise ValueError(f"unknown consumer: {consumer}") from exc
    target = target_time.astimezone(timezone.utc).replace(second=0, microsecond=0)
    return ScheduledCommand(command_type=command_type, target_time=target)


def main(arguments: Sequence[str] | None = None) -> int:
    args = list(arguments if arguments is not None else sys.argv[1:])
    if len(args) != 1 or args[0] not in {
        "fast-ci",
        "full-ci",
        "full-ci-analyze",
        "main-ci",
        "main-ci-backstop",
        "main-ci-analyze",
        "infra",
    }:
        return 2

    consumer = args[0]
    clock = SystemClock()
    runtime = _runtime(consumer, clock, _delivery_mode())
    result = runtime.process_command(scheduled_command(consumer, clock.now()))
    runtime.dispatch_due_notifications()
    return 1 if result.status is ProcessStatus.FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
