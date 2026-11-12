"""`vllm-triage` command line.

  vllm-triage backtest fetch   --dir D --days 14
  vllm-triage backtest extract --dir D --limit 150 [--workers 4] [--model sonnet]
  vllm-triage backtest report  --dir D
  vllm-triage extract          (extractor host: one budgeted run against Postgres)
  vllm-triage relevance        (extractor host: judge routable items against maintainer profiles)
  vllm-triage sync-maintainers (sync config/maintainers/*.yaml into the database now)

Worker consumers (ingest/route/digest) run through `python -m triage.worker`.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path

from triage.config import default_config


def _github_token() -> str:
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        return token
    try:
        return subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit("set GITHUB_TOKEN (read-only is enough) or log in with gh") from exc


def _backtest(args: argparse.Namespace) -> int:
    from triage import backtest
    from triage.extract import ClaudeCodeBackend
    from triage.github import GitHubClient

    out_dir = Path(args.dir)
    config = default_config()
    if args.action == "fetch":
        start, end = backtest.default_window(args.days)
        n = backtest.fetch(GitHubClient(_github_token()), out_dir, start=start, end=end, config=config)
        print(json.dumps({"fetched": n, "start": start.isoformat(), "end": end.isoformat()}))
    elif args.action == "extract":
        stats = backtest.extract(
            out_dir,
            ClaudeCodeBackend(model=args.model),
            GitHubClient(_github_token()),
            limit=args.limit,
            workers=args.workers,
            pr_share=args.pr_share,
        )
        print(json.dumps(stats))
    else:
        print(json.dumps(backtest.write_report(out_dir, config), indent=2))
    return 0


def _extract(args: argparse.Namespace) -> int:
    from triage.extract import Budget, ClaudeCodeBackend, run_extraction
    from triage.store import PostgresTriageStore

    store = PostgresTriageStore(os.environ["DATABASE_URL"])
    budget = Budget(
        max_items_per_run=args.max_items_per_run,
        max_items_per_day=args.max_items_per_day,
        max_tokens_per_day=args.max_tokens_per_day,
    )
    result = run_extraction(
        store,
        ClaudeCodeBackend(model=args.model),
        budget=budget,
        now=datetime.now(timezone.utc),
        workers=args.workers,
    )
    print(json.dumps({"extracted": result.extracted, "failed": result.failed,
                      "stopped_reason": result.stopped_reason}))
    return 0 if result.failed == 0 or result.extracted else 1


def _relevance(args: argparse.Namespace) -> int:
    from triage.extract import ClaudeCodeBackend
    from triage.relevance import run_relevance
    from triage.store import PostgresTriageStore

    store = PostgresTriageStore(os.environ["DATABASE_URL"])
    result = run_relevance(
        store, ClaudeCodeBackend(model=args.model), now=datetime.now(timezone.utc),
        min_score=args.min_score, limit=args.limit, workers=args.workers,
    )
    print(json.dumps({"judged": result.judged, "failed": result.failed,
                      "stopped_reason": result.stopped_reason, "errors": result.errors[:3]}))
    return 0 if result.failed == 0 or result.judged else 1


def _sync(args: argparse.Namespace) -> int:
    """Sync local maintainer files now (the route consumer does this from
    `main` every run; this is for first setup or an urgent fix)."""
    from triage.maintainers import LOCAL_DIR, load_local_dir, parse_maintainer_files
    from triage.store import PostgresTriageStore

    maintainers = parse_maintainer_files(load_local_dir(Path(args.dir) if args.dir else LOCAL_DIR))
    upserted, deactivated = PostgresTriageStore(os.environ["DATABASE_URL"]).sync_maintainers(maintainers)
    print(json.dumps({"maintainers": upserted, "deactivated": deactivated}))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vllm-triage")
    sub = parser.add_subparsers(dest="command", required=True)

    bt = sub.add_parser("backtest")
    bt.add_argument("action", choices=["fetch", "extract", "report"])
    bt.add_argument("--dir", required=True)
    bt.add_argument("--days", type=int, default=14)
    bt.add_argument("--limit", type=int, default=100)
    bt.add_argument("--workers", type=int, default=4)
    bt.add_argument("--pr-share", type=float, default=0.4)
    bt.add_argument("--model", default=os.environ.get("TRIAGE_MODEL", "sonnet"))

    ex = sub.add_parser("extract")
    ex.add_argument("--model", default=os.environ.get("TRIAGE_MODEL", "sonnet"))
    ex.add_argument("--workers", type=int, default=2)
    ex.add_argument("--max-items-per-run", type=int, default=int(os.environ.get("TRIAGE_MAX_ITEMS_PER_RUN", "40")))
    ex.add_argument("--max-items-per-day", type=int, default=int(os.environ.get("TRIAGE_MAX_ITEMS_PER_DAY", "150")))
    ex.add_argument("--max-tokens-per-day", type=int, default=int(os.environ.get("TRIAGE_MAX_TOKENS_PER_DAY", "2000000")))

    rel = sub.add_parser("relevance")
    rel.add_argument("--model", default=os.environ.get("TRIAGE_MODEL", "sonnet"))
    rel.add_argument("--min-score", type=int, default=int(os.environ.get("TRIAGE_RELEVANCE_MIN_SCORE", "40")))
    rel.add_argument("--limit", type=int, default=int(os.environ.get("TRIAGE_RELEVANCE_PER_RUN", "40")))
    rel.add_argument("--workers", type=int, default=2)

    sync = sub.add_parser("sync-maintainers")
    sync.add_argument("--dir")

    args = parser.parse_args(argv)
    if args.command == "backtest":
        return _backtest(args)
    if args.command == "extract":
        return _extract(args)
    if args.command == "relevance":
        return _relevance(args)
    return _sync(args)


if __name__ == "__main__":
    sys.exit(main())
