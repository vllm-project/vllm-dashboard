"""Backfill the pull request a Full CI run's head commit merged.

The analyzer resolves that pull request against GitHub to write its report, and
records it on the run from now on. Runs analyzed before the run table carried
those columns keep a null there permanently, because an analysis never runs
twice for the same build. This one-off command fills them in, using the same
lookup the analyzer uses, so the dashboard can name the change every historical
run carried.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from typing import Protocol

from alerting.analyzer import GitHubRestClient, PullRequestRef
from alerting.postgres import PostgresAlertStore


class BackfillStore(Protocol):
    def runs_missing_commit_pull_request(
        self, *, limit: int
    ) -> list[tuple[str, str]]: ...

    def record_commit_pull_request(
        self, *, build_id: str, number: int, url: str, title: str
    ) -> None: ...


class GitHubLookup(Protocol):
    def pull_for_commit(self, commit_sha: str) -> PullRequestRef | None: ...


def backfill(
    *, store: BackfillStore, github: GitHubLookup, limit: int
) -> tuple[int, int]:
    """Returns how many runs were resolved and how many reached no pull request.

    A commit reachable by no pull request is a real state, not a failure, so it
    is counted and left null rather than retried into an invented value.
    """
    resolved = 0
    unreachable = 0
    for build_id, commit_sha in store.runs_missing_commit_pull_request(limit=limit):
        pull = github.pull_for_commit(commit_sha)
        if pull is None:
            unreachable += 1
            continue
        store.record_commit_pull_request(
            build_id=build_id,
            number=pull.number,
            url=pull.url,
            title=pull.title,
        )
        resolved += 1
    return resolved, unreachable


def _required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main(arguments: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Resolve missing Full CI commit pull requests from GitHub"
    )
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args(arguments)
    if args.limit < 1:
        print("--limit must be positive", file=sys.stderr)
        return 2

    resolved, unreachable = backfill(
        store=PostgresAlertStore.from_database_url(
            _required_environment("DATABASE_URL")
        ),
        github=GitHubRestClient(token=_required_environment("GITHUB_TOKEN")),
        limit=args.limit,
    )
    print(f"resolved {resolved} runs, {unreachable} reached no pull request")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
