"""Timer entry point for triage consumers on the alerting worker.

Mirrors alerting.worker: one scheduled command per wake-up, processed
through AlertingRuntime, then due triage notifications are dispatched.
Started by deploy/aws/bin/run-worker for triage-* consumers.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Sequence
from datetime import timezone

from alerting.commands import ScheduledCommand
from alerting.ports import AlertPath, DeliveryMode
from alerting.runtime import AlertingRuntime, ProcessStatus
from alerting.worker import SystemClock, _delivery_mode, _record_failure, _required_environment, _slack

from triage.config import default_config
from triage.github import GitHubClient
from triage.maintainers import fetch_main_files
from triage.pipeline import DigestHandler, IngestHandler, RouteHandler
from triage.store import PostgresTriageStore

CONSUMERS = {
    "triage-ingest": "triage_ingest",
    "triage-route": "triage_route",
    "triage-digest": "triage_digest",
}


def triage_delivery_mode() -> DeliveryMode:
    """Live only when BOTH the S3 control says live AND TRIAGE_SLACK_ENABLED=1.

    The second switch is deliberately separate from the shared alerting
    control: nobody gets a triage Slack message until the triage owner sets
    it on purpose. Anything else renders and stores payloads as shadow
    records, which the outbox never delivers.
    """
    if os.environ.get("TRIAGE_SLACK_ENABLED") != "1":
        return DeliveryMode.SHADOW
    return _delivery_mode()


def build_runtime(consumer: str) -> tuple[AlertingRuntime, ScheduledCommand]:
    clock = SystemClock()
    store = PostgresTriageStore(_required_environment("DATABASE_URL"))
    mode = triage_delivery_mode()
    config = default_config()
    command_type = CONSUMERS[consumer]
    if consumer == "triage-ingest":
        handler = IngestHandler(
            store=store, github=GitHubClient(_required_environment("GITHUB_TOKEN")),
            config=config, clock=clock,
        )
    elif consumer == "triage-route":
        token = os.environ.get("GITHUB_TOKEN")
        handler = RouteHandler(  # type: ignore[assignment]
            store=store, config=config, clock=clock, delivery_mode=mode,
            maintainers_source=lambda: fetch_main_files(token),
            github=GitHubClient(token, min_remaining=1) if token else None,
        )
    else:
        handler = DigestHandler(  # type: ignore[assignment]
            store=store, clock=clock, delivery_mode=mode,
            team_channel=os.environ.get("TRIAGE_DIGEST_CHANNEL"),
        )
    runtime = AlertingRuntime(
        executions=store, outbox=store, slack=_slack(), clock=clock,
        handlers={command_type: handler}, alert_path=AlertPath.TRIAGE,
    )
    target = clock.now().astimezone(timezone.utc).replace(second=0, microsecond=0)
    return runtime, ScheduledCommand(command_type=command_type, target_time=target)


def main(arguments: Sequence[str] | None = None) -> int:
    args = list(arguments if arguments is not None else sys.argv[1:])
    if len(args) != 1 or args[0] not in CONSUMERS:
        return 2
    consumer = args[0]
    try:
        runtime, command = build_runtime(consumer)
        result = runtime.process_command(command)
        runtime.dispatch_due_notifications()
    except Exception as exc:
        _record_failure(consumer, f"{type(exc).__name__}: {exc}")
        raise
    if result.status is ProcessStatus.FAILED:
        _record_failure(result.idempotency_key, result.error or "unknown error")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
