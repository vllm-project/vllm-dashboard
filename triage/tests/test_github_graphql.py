"""The GraphQL ingest client against recorded-shape responses, and its parity
with the REST client: same Item, same stored comment text, same content hash."""

from __future__ import annotations

import io
import json
from datetime import datetime, timedelta, timezone
from http.client import IncompleteRead
from typing import Any
from urllib.error import HTTPError

import pytest

from alerting.commands import ScheduledCommand
from triage import github_graphql
from triage.config import default_config
from triage.github import GitHubError, item_from_raw
from triage.github_graphql import GraphQLGitHubClient, failing_checks, item_from_node, rest_login
from triage.model import FileChange
from triage.pipeline import IngestHandler
from triage.prepass import compute_prepass, content_hash, whose_move
from triage.routing import waiting_on_author
from triage.store import StoredItemState

REPO = "vllm-project/vllm"
NOW = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)
RATE = {"cost": 1, "remaining": 4900, "resetAt": "2026-11-18T13:00:00Z"}


def ts(minutes_ago: int) -> str:
    return (NOW - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def actor(login: str | None, typename: str = "User") -> dict[str, Any] | None:
    return {"login": login, "__typename": typename} if login else None


def checks(*runs: tuple[str, str]) -> dict[str, Any]:
    nodes = [
        {"__typename": "StatusContext", "context": name, "state": result} if name.startswith("buildkite")
        else {"__typename": "CheckRun", "name": name, "conclusion": result}
        for name, result in runs
    ]
    return {"nodes": [{"commit": {"statusCheckRollup": {"state": "FAILURE", "contexts": {"nodes": nodes}}}}]}


def issue_node(number: int, updated: int, **kw: Any) -> dict[str, Any]:
    node = {
        "number": number, "title": f"Issue {number}", "body": "DeepSeek crashes on B200\r\n\r\nrepro: vllm serve",
        "url": f"https://github.com/{REPO}/issues/{number}", "state": "OPEN",
        "createdAt": ts(600), "updatedAt": ts(updated), "closedAt": None, "authorAssociation": "NONE",
        "author": actor("someone"), "labels": {"nodes": [{"name": "bug"}, {"name": "rocm"}]},
        "assignees": {"nodes": [{"login": "mgoin"}]}, "reactions": {"totalCount": 3},
        "comments": {"totalCount": 2},
    }
    node.update(kw)
    return node


def pr_node(number: int, updated: int, **kw: Any) -> dict[str, Any]:
    node = issue_node(number, updated, title=f"PR {number}", url=f"https://github.com/{REPO}/pull/{number}",
                      body="Fixes the MoE crash.\n\n## Test Plan\npytest tests/kernels/moe -k fp8 and more")
    node.update({
        "isDraft": False, "mergeable": "MERGEABLE", "reviewDecision": "REVIEW_REQUIRED",
        "commits": checks(("pre-run-check", "FAILURE"), ("pre-commit", "SUCCESS")),
        "closingIssuesReferences": {"nodes": [
            {"number": 900, "repository": {"nameWithOwner": REPO}},
            {"number": 5, "repository": {"nameWithOwner": "other/repo"}},
        ]},
    })
    node.update(kw)
    return node


def comment(login: str | None, minutes_ago: int, body: str, association: str = "MEMBER", typename: str = "User") -> dict[str, Any]:
    return {"author": actor(login, typename), "authorAssociation": association, "createdAt": ts(minutes_ago), "body": body}


class FakeGraphQL:
    """Stands in for urlopen: answers each query with a handler's result and
    records the queries."""

    def __init__(self, handler: Any) -> None:
        self.handler = handler
        self.queries: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, request: Any, timeout: float = 0) -> Any:
        payload = json.loads(request.data)
        self.queries.append((payload["query"], payload["variables"]))
        result = self.handler(payload["query"], payload["variables"])
        if isinstance(result, BaseException):
            raise result
        body = json.dumps(result if "data" in result or "errors" in result else {"data": {"rateLimit": RATE, **result}})
        return io.BytesIO(body.encode())


@pytest.fixture()
def fake(monkeypatch: pytest.MonkeyPatch) -> Any:
    def install(handler: Any) -> FakeGraphQL:
        transport = FakeGraphQL(handler)
        monkeypatch.setattr(github_graphql, "urlopen", transport)
        monkeypatch.setattr("triage.github_graphql.time.sleep", lambda s: None)
        return transport
    return install


# --- listing -----------------------------------------------------------------


def test_lists_issues_and_prs_since_the_cursor_oldest_first(fake: Any) -> None:
    pages = {
        None: [pr_node(105, 1), pr_node(104, 20)],
        "p2": [pr_node(103, 40), pr_node(102, 90), pr_node(101, 95)],
    }

    def handler(query: str, v: dict[str, Any]) -> dict[str, Any]:
        repo: dict[str, Any] = {}
        if v["withIssues"]:
            repo["issues"] = {"pageInfo": {"hasNextPage": False, "endCursor": "i1"},
                              "nodes": [issue_node(201, 50), issue_node(202, 5)]}
        if v["withPrs"]:
            repo["pullRequests"] = {"pageInfo": {"hasNextPage": v["prsAfter"] is None, "endCursor": "p2"},
                                    "nodes": pages[v["prsAfter"]]}
        return {"repository": repo}

    transport = fake(handler)
    client = GraphQLGitHubClient("t")
    items = client.updated_items(REPO, NOW - timedelta(minutes=60), max_items=100)
    # PRs stop at the first one older than the cursor; issues come filtered.
    assert [i.number for i in items] == [201, 103, 104, 202, 105]
    assert [v["withIssues"] for _, v in transport.queries] == [True, False]
    assert transport.queries[0][1]["since"] == "2026-11-18T11:00:00Z"
    assert client.calls == 2 and client.cost == 2
    # The cap keeps the oldest, so the cursor still moves forward.
    capped = GraphQLGitHubClient("t").updated_items(REPO, NOW - timedelta(minutes=60), max_items=2)
    assert [i.number for i in capped] == [201, 103]


def test_items_read_like_rest() -> None:
    pr = item_from_node(REPO, pr_node(7, 3, author=actor("dependabot", "Bot"), state="MERGED",
                                      closedAt=ts(2)), "pr")
    assert (pr.author, pr.is_bot, pr.state, pr.kind) == ("dependabot[bot]", True, "merged", "pr")
    assert pr.closing_issues == [900]  # the other repo's issue is dropped
    assert pr.failing_checks == ["pre-run-check"] and pr.review_decision == "REVIEW_REQUIRED"
    issue = item_from_node(REPO, issue_node(8, 3, author=None, state="CLOSED"), "issue")
    assert (issue.author, issue.state, issue.draft, issue.failing_checks) == ("ghost", "closed", False, None)
    assert issue.labels == ["bug", "rocm"] and issue.assignees == ["mgoin"]
    assert (issue.reactions, issue.comment_count) == (3, 2)
    assert rest_login(actor("copilot-swe-agent", "Bot")) == "Copilot"


def test_rest_and_graphql_build_the_same_item_and_hash() -> None:
    """The same issue as the two APIs return it."""
    rest = {
        "number": 8, "title": "Issue 8", "body": "DeepSeek crashes on B200\r\n\r\nrepro: vllm serve",
        "html_url": f"https://github.com/{REPO}/issues/8", "state": "open", "created_at": ts(600),
        "updated_at": ts(3), "closed_at": None, "author_association": "NONE",
        "user": {"login": "someone", "type": "User"}, "labels": [{"name": "bug"}, {"name": "rocm"}],
        "assignees": [{"login": "mgoin"}], "reactions": {"total_count": 3}, "comments": 2,
    }
    from_rest = item_from_raw(REPO, rest)
    from_graphql = item_from_node(REPO, issue_node(8, 3), "issue")
    assert from_rest == from_graphql
    assert content_hash(from_rest) == content_hash(from_graphql)
    config = default_config()
    assert compute_prepass(from_rest, config, NOW) == compute_prepass(from_graphql, config, NOW)


def test_failing_checks_ignore_cancelled_and_rerun_checks() -> None:
    got = failing_checks(checks(
        ("pre-run-check", "FAILURE"), ("pre-run-check", "SUCCESS"),  # re-triggered by the `ready` label
        ("pre-commit", "CANCELLED"), ("DCO", "FAILURE"), ("buildkite/ci/pr", "ERROR"), ("docs", "PENDING"),
    ))
    assert got == ["DCO", "buildkite/ci/pr"]
    assert failing_checks(None) == [] and failing_checks({"nodes": []}) == []


# --- details -----------------------------------------------------------------


def test_one_query_fetches_files_comments_and_pr_authors_for_a_batch(fake: Any) -> None:
    def handler(query: str, v: dict[str, Any]) -> dict[str, Any]:
        assert "n12: issueOrPullRequest(number: 12)" in query
        return {"repository": {
            "n11": {"__typename": "PullRequest",
                    "files": {"pageInfo": {"hasNextPage": False}, "nodes": [{"path": "vllm/a.py", "additions": 3, "deletions": 1}]},
                    "first": {"nodes": [comment("gemini-code-assist", 9, "Summary", "NONE", "Bot"),
                                        comment(None, 8, "deleted user", "NONE")]},
                    "tail": {"nodes": [{"author": actor("mgoin"), "createdAt": ts(1)}]}},
            "n12": {"__typename": "Issue"},
            "n13": {"__typename": "PullRequest", "author": actor("gau-nernst")},
        }}

    transport = fake(handler)
    client = GraphQLGitHubClient("t")
    client.prefetch(REPO, files=[11], comments=[11], authors=[12, 13])
    assert len(transport.queries) == 1
    assert client.pull_files(REPO, 11) == [FileChange("vllm/a.py", 3, 1)]
    records = client.comment_records(REPO, 11)
    assert [text for _, _, text in records] == ["[gemini-code-assist[bot] (NONE)]: Summary", "[ghost (NONE)]: deleted user"]
    assert client.comment_tail(REPO, 11) == [("mgoin", NOW - timedelta(minutes=1))]
    assert client.pull_authors(REPO, [12, 13]) == {13: "gau-nernst"}  # 12 is an issue
    assert len(transport.queries) == 1  # all served from the one query


def test_files_past_the_first_hundred_are_paged(fake: Any) -> None:
    def handler(query: str, v: dict[str, Any]) -> dict[str, Any]:
        if "after: $after" in query:
            last = v["after"] == "c2"
            files = {"pageInfo": {"hasNextPage": not last, "endCursor": "c2"},
                     "nodes": [{"path": f"{v['after']}/{i}.py", "additions": 1, "deletions": 0} for i in range(100)]}
            return {"repository": {"pullRequest": {"files": files}}}
        return {"repository": {"n11": {"__typename": "PullRequest", "files": {
            "pageInfo": {"hasNextPage": True, "endCursor": "c1"},
            "nodes": [{"path": f"a/{i}.py", "additions": 1, "deletions": 0} for i in range(100)]}}}}

    transport = fake(handler)
    files = GraphQLGitHubClient("t").pull_files(REPO, 11)
    assert len(files) == 300 and files[100].path == "c1/0.py" and files[200].path == "c2/0.py"
    assert len(transport.queries) == 3  # MAX_FILE_PAGES, as REST


# --- transport ---------------------------------------------------------------


def test_backs_off_near_the_rate_limit_and_fails_on_errors(fake: Any) -> None:
    fake(lambda q, v: {"data": {"rateLimit": {**RATE, "remaining": 50}, "repository": {}}})
    with pytest.raises(GitHubError, match="nearly exhausted"):
        GraphQLGitHubClient("t").pr_statuses(REPO, [1])
    fake(lambda q, v: {"data": {"rateLimit": RATE, "repository": {"n1": None}},
                       "errors": [{"type": "NOT_FOUND", "message": "gone"}]})
    assert GraphQLGitHubClient("t").pr_statuses(REPO, [1]) == {}  # NOT_FOUND only nulls that field
    fake(lambda q, v: {"data": None, "errors": [{"type": "RATE_LIMITED", "message": "slow down"}]})
    with pytest.raises(GitHubError, match="slow down"):
        GraphQLGitHubClient("t").pr_statuses(REPO, [1])


def test_retries_bad_gateways_and_cut_off_responses(fake: Any) -> None:
    answers: list[Any] = [
        HTTPError("u", 502, "bad gateway", {}, None),  # type: ignore[arg-type]
        IncompleteRead(b"{", 10),
        {"repository": {"n1": {"state": "OPEN", "isDraft": True, "mergeable": "CONFLICTING",
                               "reviewDecision": None, "commits": checks(("DCO", "FAILURE"))}}},
    ]
    transport = fake(lambda q, v: answers.pop(0))
    client = GraphQLGitHubClient("t")
    status = client.pr_statuses(REPO, [1])[1]
    assert (status.state, status.draft, status.mergeable, status.failing_checks) == ("open", True, "CONFLICTING", ["DCO"])
    assert len(transport.queries) == 3 and client.calls == 3


# --- whose move ----------------------------------------------------------------


def test_whose_move() -> None:
    assert whose_move(draft=False, review_decision="APPROVED", mergeable="MERGEABLE",
                      failing_checks=["pre-run-check", "docs/readthedocs.org:vllm", "buildkite/ci/pr"]) == {
        "waiting_on": "reviewer", "waiting_reasons": [],
        "failing_checks": ["pre-run-check", "docs/readthedocs.org:vllm", "buildkite/ci/pr"]}
    assert whose_move(draft=True, review_decision="CHANGES_REQUESTED", mergeable="CONFLICTING",
                      failing_checks=["pre-commit"]) == {
        "waiting_on": "author", "waiting_reasons": ["draft", "ci_failing", "merge_conflict", "changes_requested"],
        "failing_checks": ["pre-commit"]}
    # REST knows only the draft flag.
    assert whose_move(draft=False, review_decision=None, mergeable=None, failing_checks=None) == {
        "waiting_on": "reviewer", "waiting_reasons": []}
    assert waiting_on_author({"waiting_on": "author"}, "route")
    assert not waiting_on_author({"waiting_on": "author"}, "page")
    assert not waiting_on_author({}, "route")


def test_prepass_links_closing_issues_and_says_whose_move() -> None:
    config = default_config()
    pr = item_from_node(REPO, pr_node(7, 3, body="Speeds up MoE. Related to #901.",
                                      authorAssociation="MEMBER", mergeable="CONFLICTING"), "pr")
    prepass = compute_prepass(pr, config, NOW)
    assert prepass["linked_issues"] == [900, 901]  # sidebar link + body regex
    assert prepass["scope_reason"] == "pr_linked_issue"  # a maintainer PR linked only in the sidebar
    assert (prepass["waiting_on"], prepass["waiting_reasons"]) == ("author", ["merge_conflict"])
    closed = item_from_node(REPO, pr_node(8, 3, state="CLOSED"), "pr")
    assert "waiting_on" not in compute_prepass(closed, config, NOW)
    assert "waiting_on" not in compute_prepass(item_from_node(REPO, issue_node(9, 3), "issue"), config, NOW)


# --- through the ingest handler ------------------------------------------------


class MemoryStore:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        self.cursor_value: datetime | None = NOW - timedelta(minutes=30)
        self.waiting: list[tuple[str, int, dict[str, Any]]] = []
        self.prepass_updates: list[tuple[str, dict[str, Any]]] = []

    def cursor(self, name: str) -> datetime | None:
        return self.cursor_value

    def set_cursor(self, name: str, value: datetime) -> None:
        self.cursor_value = value

    def item_state(self, key: str) -> StoredItemState | None:
        row = self.rows.get(key)
        return StoredItemState(row["content_hash"], row["comment_count"], row["updated_at"], row["files"],
                               row["comments_excerpt"], row["prepass"]) if row else None

    def upsert_item(self, item: Any, *, prepass: dict[str, Any], priority: int, content_hash: str,
                    in_scope: bool, comments_excerpt: str) -> None:
        self.rows[item.key] = {"content_hash": content_hash, "comment_count": item.comment_count,
                               "updated_at": item.updated_at, "files": [f.path for f in item.files],
                               "comments_excerpt": comments_excerpt, "prepass": prepass, "in_scope": in_scope}

    def waiting_prs(self, repo: str, *, limit: int) -> list[tuple[str, int, dict[str, Any]]]:
        return self.waiting[:limit]

    def update_prepass(self, item_key: str, fields: dict[str, Any]) -> None:
        self.prepass_updates.append((item_key, fields))


class Clock:
    def now(self) -> datetime:
        return NOW


def test_an_ingest_run_is_two_queries_and_the_hash_survives_a_reread(fake: Any) -> None:
    body = "Regression from PR #61343 on H100.\n\n" + "x" * 80
    comments = [comment("mgoin", 50, "Can you share the log?\n\nThanks"),
                comment("someone", 40, "Here:\n\n```\ntrace\n```", "NONE")]
    count = {"n": 2}

    def handler(query: str, v: dict[str, Any]) -> dict[str, Any]:
        if "filterBy" in query:
            return {"repository": {
                "issues": {"pageInfo": {"hasNextPage": False}, "nodes": [
                    issue_node(301, 10, body=body, comments={"totalCount": count["n"]})]},
                "pullRequests": {"pageInfo": {"hasNextPage": False}, "nodes": [
                    pr_node(302, 12, commits=checks(("pre-commit", "FAILURE")))]}}}
        detail: dict[str, Any] = {"repository": {}}
        if "n301:" in query:
            detail["repository"]["n301"] = {"__typename": "Issue", "first": {"nodes": comments[:count["n"]]},
                                            "tail": {"nodes": []}}
        if "n302:" in query:
            detail["repository"]["n302"] = {"__typename": "PullRequest", "files": {
                "pageInfo": {"hasNextPage": False}, "nodes": [{"path": "vllm/model_executor/layers/fused_moe/x.py",
                                                              "additions": 1, "deletions": 1}]},
                "first": {"nodes": []}, "tail": {"nodes": []}}
        if "n61343:" in query:
            detail["repository"]["n61343"] = {"__typename": "PullRequest", "author": actor("gau-nernst")}
        return detail

    transport = fake(handler)
    store = MemoryStore()
    client = GraphQLGitHubClient("t")
    handler_ = IngestHandler(store=store, github=client, config=default_config(), clock=Clock())  # type: ignore[arg-type]
    handler_(ScheduledCommand("triage_ingest", NOW))
    assert len(transport.queries) == 2  # the list, then one detail query for both items
    issue = store.rows[f"{REPO}#301"]
    assert issue["prepass"]["referenced_pr_authors"] == {"61343": "gau-nernst"}
    assert issue["prepass"]["commenters"] == ["mgoin", "someone"]
    assert issue["comments_excerpt"].startswith("[mgoin (MEMBER)]: Can you share the log?\n\nThanks\n\n[someone")
    pr = store.rows[f"{REPO}#302"]
    assert (pr["prepass"]["waiting_on"], pr["prepass"]["waiting_reasons"]) == ("author", ["ci_failing"])
    assert pr["files"] == ["vllm/model_executor/layers/fused_moe/x.py"]

    # Next run: the comment count is unchanged, so comments aren't re-read and
    # the hash is the same as when they were (comment bodies have blank lines).
    first_hash = issue["content_hash"]
    transport.queries.clear()
    handler_(ScheduledCommand("triage_ingest", NOW))
    assert [q for q, _ in transport.queries if "n301:" in q] == []
    assert store.rows[f"{REPO}#301"]["content_hash"] == first_hash
    assert store.rows[f"{REPO}#301"]["prepass"]["commenters"] == ["mgoin", "someone"]


def test_waiting_prs_are_rechecked_and_only_changes_written(fake: Any) -> None:
    fake(lambda q, v: {"repository": {"issues": {"pageInfo": {}, "nodes": []},
                                      "pullRequests": {"pageInfo": {}, "nodes": []}}} if "filterBy" in q else {
        "repository": {
            "n1": {"state": "OPEN", "isDraft": False, "mergeable": "MERGEABLE", "reviewDecision": None,
                   "commits": checks(("pre-commit", "SUCCESS"))},
            "n2": {"state": "OPEN", "isDraft": True, "mergeable": "MERGEABLE", "reviewDecision": None,
                   "commits": checks()},
            "n3": {"state": "MERGED", "isDraft": False, "mergeable": "UNKNOWN", "reviewDecision": None,
                   "commits": checks()},
        }})
    store = MemoryStore()
    still = {"waiting_on": "author", "waiting_reasons": ["draft"], "failing_checks": []}
    store.waiting = [("k1", 1, {"waiting_on": "author", "waiting_reasons": ["ci_failing"], "failing_checks": ["pre-commit"]}),
                     ("k2", 2, still), ("k3", 3, still)]
    IngestHandler(store=store, github=GraphQLGitHubClient("t"), config=default_config(),  # type: ignore[arg-type]
                  clock=Clock())(ScheduledCommand("triage_ingest", NOW))
    assert store.prepass_updates == [("k1", {"waiting_on": "reviewer", "waiting_reasons": [], "failing_checks": []})]


def test_the_api_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    from triage.github import GitHubClient
    from triage.worker import ingest_client

    monkeypatch.delenv("TRIAGE_GITHUB_API", raising=False)
    assert isinstance(ingest_client("t"), GraphQLGitHubClient)
    monkeypatch.setenv("TRIAGE_GITHUB_API", "REST")
    assert isinstance(ingest_client("t"), GitHubClient)
    monkeypatch.setenv("TRIAGE_GITHUB_API", "soap")
    with pytest.raises(ValueError):
        ingest_client("t")


def test_prefetch_asks_only_for_what_is_not_cached(fake: Any) -> None:
    def handler(query: str, v: dict[str, Any]) -> dict[str, Any]:
        node: dict[str, Any] = {"__typename": "PullRequest"}
        if "files(first" in query:
            node["files"] = {"pageInfo": {}, "nodes": [{"path": "a.py", "additions": 1, "deletions": 0}]}
        if "first: comments" in query:
            node["first"] = {"nodes": [comment("mgoin", 1, "hi")]}
            node["tail"] = {"nodes": []}
        return {"repository": {"n11": node}}

    transport = fake(handler)
    client = GraphQLGitHubClient("t")
    client.prefetch(REPO, files=[11], comments=[], authors=[])
    client.prefetch(REPO, files=[11], comments=[11], authors=[])  # files already cached
    assert "files(first" not in transport.queries[1][0]
    assert client.pull_files(REPO, 11) == [FileChange("a.py", 1, 0)]
    assert [t for _, _, t in client.comment_records(REPO, 11)] == ["[mgoin (MEMBER)]: hi"]
