"""Tests for per-file maintainer validation, explain_unowned, and GraphQL items_by_numbers."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from triage.github_graphql import GraphQLGitHubClient
from triage.maintainers import parse_maintainer_files_partial
from triage.model import Maintainer
from triage.routing import RoutingContext, explain_unowned

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)


def test_parse_maintainer_files_partial_keeps_valid_files_when_one_is_broken() -> None:
    files = {
        "alice.yaml": "github_login: alice\nrules: {areas: [moe]}\n",
        "bob.yaml": "github_login: bob\nnotify_mode: off\n",  # bare off -> YAML False (invalid)
        "carol.yaml": "github_login: carol\nrules: {hardware: [B200]}\n",
    }
    valid, problems, broken = parse_maintainer_files_partial(files)
    assert [m.github_login for m in valid] == ["alice", "carol"]
    assert broken == {"bob"}
    assert len(problems) == 1 and "bob.notify_mode" in problems[0]


def test_explain_unowned_matches_router_blockers() -> None:
    alice = Maintainer(github_login="alice", rules={"areas": ["moe"]}, capacity_per_week=2)
    ctx = RoutingContext(
        item_key="vllm-project/vllm#1", kind="pr", title="Fix MoE", score=55, band="route",
        facets={"type": "bug", "areas": ["moe"]},
        prepass={"waiting_on": "author", "waiting_reasons": ["draft"]},
        files=[],
    )
    res = explain_unowned(ctx, [alice], load={}, excluded=set(), today=date(2026, 11, 20))
    assert "Waiting on the PR author" in res["summary"] and res["pending"] is False

    ready_ctx = RoutingContext(
        item_key="vllm-project/vllm#2", kind="issue", title="MoE bug", score=55, band="route",
        facets={"type": "bug", "areas": ["moe"]}, prepass={}, files=[],
    )
    capped = explain_unowned(ready_ctx, [alice], load={"alice": 2}, excluded=set(), today=date(2026, 11, 20))
    assert "already has 2 of 2" in capped["lines"][0]

    waiting = explain_unowned(
        ready_ctx, [alice], load={}, excluded=set(), today=date(2026, 11, 20),
        waiting_for_relevance=["alice"], grace_over=False,
    )
    assert waiting["pending"] is True and "Waiting for relevance" in waiting["summary"]


def test_graphql_items_by_numbers_batches_issues_and_prs(monkeypatch: Any) -> None:
    client = GraphQLGitHubClient("tok")

    def fake_query(query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        assert "n10: issueOrPullRequest(number: 10)" in query
        assert "n11: issueOrPullRequest(number: 11)" in query
        return {
            "repository": {
                "n10": {
                    "__typename": "Issue",
                    "number": 10, "title": "Issue 10", "body": "b", "url": "https://github.com/vllm-project/vllm/issues/10",
                    "state": "OPEN", "createdAt": "2026-11-20T10:00:00Z", "updatedAt": "2026-11-20T11:00:00Z",
                    "closedAt": None, "authorAssociation": "NONE", "author": {"login": "u", "__typename": "User"},
                    "labels": {"nodes": []}, "assignees": {"nodes": []},
                    "reactions": {"totalCount": 0}, "comments": {"totalCount": 0},
                },
                "n11": {
                    "__typename": "PullRequest",
                    "number": 11, "title": "PR 11", "body": "Fixes #10", "url": "https://github.com/vllm-project/vllm/pull/11",
                    "state": "OPEN", "createdAt": "2026-11-20T10:00:00Z", "updatedAt": "2026-11-20T11:30:00Z",
                    "closedAt": None, "authorAssociation": "NONE", "author": {"login": "u2", "__typename": "User"},
                    "labels": {"nodes": []}, "assignees": {"nodes": []},
                    "reactions": {"totalCount": 0}, "comments": {"totalCount": 0},
                    "isDraft": False, "mergeable": "MERGEABLE", "reviewDecision": None,
                    "commits": {"nodes": []}, "closingIssuesReferences": {"nodes": []},
                },
            }
        }

    monkeypatch.setattr(client, "_query", fake_query)
    items = client.items_by_numbers("vllm-project/vllm", [11, 10])
    assert [(i.number, i.kind) for i in items] == [(10, "issue"), (11, "pr")]
