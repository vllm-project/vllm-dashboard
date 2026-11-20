"""Timer entry point for triage consumers on the alerting worker.

Mirrors alerting.worker: one scheduled command per wake-up, processed
through AlertingRuntime, then due triage notifications are dispatched.
Started by deploy/aws/bin/run-worker for triage-* consumers.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Sequence
from datetime import timedelta, timezone

from alerting.commands import ScheduledCommand
from alerting.full_ci import BuildkiteRestClient
from alerting.ports import AlertPath, DeliveryMode
from alerting.runtime import AlertingRuntime, ProcessStatus
from alerting.worker import SystemClock, _delivery_mode, _record_failure, _required_environment, _slack

from triage.backends import build_backend
from triage.config import default_config
from triage.extract import Budget, ClaudeCodeBackend, run_extraction
from triage.github import GitHubClient, IngestClient
from triage.github_graphql import GraphQLGitHubClient
from triage.maintainers import fetch_main_files
from triage.pipeline import DigestHandler, IngestHandler, RouteHandler
from triage.relevance import run_relevance
from triage.store import PostgresTriageStore

CONSUMERS = {
    "triage-ingest": "triage_ingest",
    "triage-route": "triage_route",
    "triage-digest": "triage_digest",
    "triage-extract": "triage_extract",
    "triage-relevance": "triage_relevance",
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


def ingest_client(token: str) -> IngestClient:
    """TRIAGE_GITHUB_API=rest switches ingest back to the REST client (one
    request per PR's files, comments and named PR); default graphql."""
    api = os.environ.get("TRIAGE_GITHUB_API", "graphql").strip().lower()
    if api == "rest":
        return GitHubClient(token)
    if api != "graphql":
        raise ValueError(f"TRIAGE_GITHUB_API must be 'graphql' or 'rest', not {api!r}")
    return GraphQLGitHubClient(token)


def build_runtime(consumer: str) -> tuple[AlertingRuntime, ScheduledCommand]:
    clock = SystemClock()
    store = PostgresTriageStore(_required_environment("DATABASE_URL"))
    mode = triage_delivery_mode()
    config = default_config()
    command_type = CONSUMERS[consumer]
    if consumer == "triage-ingest":
        # The alerting worker's read-only Buildkite token, for PR CI status
        # (triage/ci.py); without it, CI status is not tracked.
        buildkite_token = os.environ.get("BUILDKITE_TOKEN")
        cooldown_hours = float(os.environ.get("TRIAGE_REEXTRACT_COOLDOWN_HOURS", "12"))
        handler = IngestHandler(
            store=store, github=ingest_client(_required_environment("GITHUB_TOKEN")),
            config=config, clock=clock,
            buildkite=BuildkiteRestClient(token=buildkite_token) if buildkite_token else None,
            reextract_cooldown=timedelta(hours=max(0.0, cooldown_hours)),
        )
    elif consumer == "triage-route":
        token = os.environ.get("GITHUB_TOKEN")
        handler = RouteHandler(  # type: ignore[assignment]
            store=store, config=config, clock=clock, delivery_mode=mode,
            maintainers_source=lambda: fetch_main_files(token),
            github=GitHubClient(token, min_remaining=1) if token else None,
        )
    elif consumer == "triage-extract":
        backend = build_backend(role="extract")
        if isinstance(backend, ClaudeCodeBackend):
            raise ValueError(
                "triage-extract on the worker requires a direct API backend (TRIAGE_BACKEND=openai or anthropic); "
                "Claude Code CLI runs on the extractor host instead"
            )
        budget = Budget(
            max_items_per_run=int(os.environ.get("TRIAGE_MAX_ITEMS_PER_RUN", "40")),
            max_items_per_day=int(os.environ.get("TRIAGE_MAX_ITEMS_PER_DAY", "0")),
            max_tokens_per_day=int(os.environ.get("TRIAGE_MAX_TOKENS_PER_DAY", "0")),
        )
        workers = int(os.environ.get("TRIAGE_WORKERS", "4"))

        def _run_extract(_: ScheduledCommand) -> None:
            run_extraction(store, backend, budget=budget, now=clock.now(), workers=workers)

        handler = _run_extract  # type: ignore[assignment]
    elif consumer == "triage-relevance":
        backend = build_backend(role="relevance")
        if isinstance(backend, ClaudeCodeBackend):
            raise ValueError(
                "triage-relevance on the worker requires a direct API backend "
                "(TRIAGE_RELEVANCE_BACKEND=openai or anthropic); Claude Code CLI runs on the extractor host instead"
            )
        min_score = int(os.environ.get("TRIAGE_RELEVANCE_MIN_SCORE", "40"))
        limit = int(os.environ.get("TRIAGE_RELEVANCE_PER_RUN", "40"))
        workers = int(os.environ.get("TRIAGE_RELEVANCE_WORKERS", "4"))

        def _run_relevance(_: ScheduledCommand) -> None:
            run_relevance(store, backend, now=clock.now(), min_score=min_score, limit=limit, workers=workers)

        handler = _run_relevance  # type: ignore[assignment]
    else:
        handler = DigestHandler(  # type: ignore[assignment]
            store=store, clock=clock, delivery_mode=mode,
            team_channel=os.environ.get("TRIAGE_DIGEST_CHANNEL"),
            suppression_threshold=int(os.environ.get("TRIAGE_SUPPRESSION_ALERT", "10")),
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
