"""Backfill of Full CI commit pull requests through its public seam."""

from __future__ import annotations

from alerting import backfill
from alerting.analyzer import PullRequestRef


class FakeStore:
    def __init__(self, runs: list[tuple[str, str]]) -> None:
        self.runs = runs
        self.recorded: list[tuple[str, int, str, str]] = []

    def runs_missing_commit_pull_request(self, *, limit: int) -> list[tuple[str, str]]:
        return self.runs[:limit]

    def record_commit_pull_request(
        self, *, build_id: str, number: int, url: str, title: str
    ) -> None:
        self.recorded.append((build_id, number, url, title))


class FakeGitHub:
    def __init__(self, pulls: dict[str, PullRequestRef]) -> None:
        self.pulls = pulls
        self.asked: list[str] = []

    def pull_for_commit(self, commit_sha: str) -> PullRequestRef | None:
        self.asked.append(commit_sha)
        return self.pulls.get(commit_sha)


def test_a_resolved_commit_records_its_pull_request() -> None:
    store = FakeStore([("build-101", "commit-101")])
    github = FakeGitHub(
        {
            "commit-101": PullRequestRef(
                number=54353,
                url="https://github.com/vllm-project/vllm/pull/54353",
                title="[Bugfix] Bound cache_salt length",
            )
        }
    )

    resolved, unreachable = backfill.backfill(store=store, github=github, limit=10)

    assert (resolved, unreachable) == (1, 0)
    assert store.recorded == [
        (
            "build-101",
            54353,
            "https://github.com/vllm-project/vllm/pull/54353",
            "[Bugfix] Bound cache_salt length",
        )
    ]


def test_a_commit_reachable_by_no_pull_request_is_counted_not_invented() -> None:
    store = FakeStore([("build-100", "commit-100")])
    github = FakeGitHub({})

    resolved, unreachable = backfill.backfill(store=store, github=github, limit=10)

    assert (resolved, unreachable) == (0, 1)
    assert store.recorded == []


def test_the_limit_bounds_how_many_commits_are_asked_about() -> None:
    store = FakeStore([(f"build-{n}", f"commit-{n}") for n in range(10)])
    github = FakeGitHub({})

    backfill.backfill(store=store, github=github, limit=3)

    assert github.asked == ["commit-0", "commit-1", "commit-2"]


def test_a_non_positive_limit_is_rejected_before_any_lookup() -> None:
    assert backfill.main(["--limit", "0"]) == 2
