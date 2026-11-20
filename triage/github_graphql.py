"""Read-only GitHub GraphQL client for issue/PR ingestion.

Does what the REST client (github.py) does for ingest in a few batched
queries instead of one request per item:

  1. `updated_items`: one query lists issues and PRs updated since the
     cursor, 25 of each per page, with everything the prepass needs:
     labels, assignees, reactions, comment count, and for PRs draft state,
     closing issue references, review decision, mergeability and the checks
     on the head commit.
  2. `prefetch`: one query per ingest batch (25 items) gets the changed files
     of in-scope PRs, the first 30 comments of in-scope items whose comment
     count changed (plus who wrote the latest 30, for long threads), and the
     authors of PRs the items name (aliased fields).
  3. `pr_statuses`: one query per 25 PRs re-reads whose move it is, and
     the head commit with the Buildkite build its status points at (for
     triage/ci.py); check results and merge conflicts change without
     bumping a PR's updatedAt, so the cursor alone would not see them.

Issues come from repository.issues(filterBy: {since}) and PRs from
repository.pullRequests ordered by UPDATED_AT descending, read until the
cursor. Not GraphQL search: it stops at 1000 results (the first run looks
back two days, ~3500 items), its index lags behind writes, and it has its own
stricter rate limits.

Logins are reported as REST reports them (bots as "name[bot]"), so stored
comment text, and the content hash over it, does not depend on the client.
Needs only a read-only token; sends queries, never mutations.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any, Literal, cast
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from triage.github import (
    MAX_COMMENTS,
    MAX_FILE_PAGES,
    USER_AGENT,
    CommentRecord,
    GitHubError,
    PrStatus,
    _parse_time,
    fetch_pull_diff,
)
from triage.ci import BUILDKITE_CONTEXT, build_number_from_url
from triage.model import FileChange, Item

GRAPHQL_URL = "https://api.github.com/graphql"
LIST_PAGE_SIZE = 25
DETAIL_BATCH = 25
STATUS_BATCH = 25
# Comments past the first MAX_COMMENTS: only who wrote them and when.
COMMENT_TAIL = 30
MAX_CHECKS = 50

# REST logins of GitHub's own agents, whose GraphQL login is the app slug.
_REST_BOT_LOGINS = {"copilot-swe-agent": "Copilot", "copilot-pull-request-reviewer": "Copilot"}
# Check results that mean the check failed. CANCELLED (superseded by a newer
# run), SKIPPED, NEUTRAL, STALE and PENDING are not failures.
_FAILED = frozenset({"FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"})
_PASSED = frozenset({"SUCCESS"})

_ACTOR = "{ login __typename }"
_COMMON = f"""
  number title body url state createdAt updatedAt closedAt authorAssociation
  author {_ACTOR}
  labels(first: 100) {{ nodes {{ name }} }}
  assignees(first: 20) {{ nodes {{ login }} }}
  reactions {{ totalCount }}
  comments {{ totalCount }}
"""
_PR_STATUS = f"""
  state isDraft mergeable reviewDecision
  commits(last: 1) {{ nodes {{ commit {{ oid
    status {{ contexts {{ context state targetUrl }} }}
    statusCheckRollup {{ state
    contexts(first: {MAX_CHECKS}) {{ nodes {{ __typename
      ... on CheckRun {{ name conclusion }}
      ... on StatusContext {{ context state }} }} }} }} }} }} }}
"""
_RATE = "rateLimit { cost remaining resetAt }"

LIST_QUERY = f"""
query($owner: String!, $name: String!, $since: DateTime!, $first: Int!,
      $issuesAfter: String, $prsAfter: String, $withIssues: Boolean!, $withPrs: Boolean!) {{
  {_RATE}
  repository(owner: $owner, name: $name) {{
    issues(first: $first, after: $issuesAfter, filterBy: {{since: $since}},
           orderBy: {{field: UPDATED_AT, direction: ASC}}) @include(if: $withIssues) {{
      pageInfo {{ hasNextPage endCursor }}
      nodes {{ {_COMMON} }}
    }}
    pullRequests(first: $first, after: $prsAfter,
                 orderBy: {{field: UPDATED_AT, direction: DESC}}) @include(if: $withPrs) {{
      pageInfo {{ hasNextPage endCursor }}
      nodes {{
        {_COMMON}
        {_PR_STATUS}
        closingIssuesReferences(first: 25) {{ nodes {{ number repository {{ nameWithOwner }} }} }}
      }}
    }}
  }}
}}
"""

FILES_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  %s
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions }
      }
    }
  }
}
""" % _RATE

_FILES = "files(first: 100) { pageInfo { hasNextPage endCursor } nodes { path additions deletions } }"
_COMMENTS = (
    f"first: comments(first: {MAX_COMMENTS}) {{ nodes {{ author {_ACTOR} authorAssociation createdAt body }} }}\n"
    f"tail: comments(last: {COMMENT_TAIL}) {{ nodes {{ author {_ACTOR} createdAt }} }}"
)


def rest_login(actor: dict[str, Any] | None) -> str | None:
    """The login REST would report for a GraphQL actor (None: deleted user).
    GraphQL gives a bot its app slug ("dependabot"); REST says "dependabot[bot]"."""
    if not actor or not actor.get("login"):
        return None
    login = str(actor["login"])
    if actor.get("__typename") == "Bot":
        return _REST_BOT_LOGINS.get(login, f"{login}[bot]")
    return login


def failing_checks(commits: dict[str, Any] | None) -> list[str]:
    """Names of checks that failed on the head commit, in GitHub's order.
    A name that also has a passing run (re-run, or re-triggered by a label)
    is not failing."""
    nodes = (commits or {}).get("nodes") or []
    rollup = ((nodes[0] or {}).get("commit") or {}).get("statusCheckRollup") if nodes else None
    failed: dict[str, None] = {}
    passed: set[str] = set()
    for context in ((rollup or {}).get("contexts") or {}).get("nodes") or []:
        if not context:
            continue
        name = context.get("name") or context.get("context")
        result = context.get("conclusion") or context.get("state")
        if not name:
            continue
        if result in _FAILED:
            failed.setdefault(str(name), None)
        elif result in _PASSED:
            passed.add(str(name))
    return [name for name in failed if name not in passed]


def head_commit(commits: dict[str, Any] | None) -> tuple[str | None, str | None]:
    """(head commit sha, URL of the Buildkite build its `buildkite/ci...`
    status points at, or None when Buildkite hasn't started one)."""
    nodes = (commits or {}).get("nodes") or []
    commit = ((nodes[0] or {}).get("commit") or {}) if nodes else {}
    build_url: str | None = None
    best = -1
    for context in ((commit.get("status") or {}).get("contexts")) or []:
        if not context or not str(context.get("context") or "").startswith(BUILDKITE_CONTEXT):
            continue
        number = build_number_from_url(context.get("targetUrl"))
        if number is not None and number > best:
            best, build_url = number, str(context["targetUrl"])
    return (str(commit["oid"]) if commit.get("oid") else None), build_url


def _state(node: dict[str, Any]) -> Literal["open", "closed", "merged"]:
    state = str(node.get("state") or "").lower()
    return cast(Literal["open", "closed", "merged"], state if state in ("open", "merged") else "closed")


def item_from_node(repo: str, node: dict[str, Any], kind: Literal["issue", "pr"]) -> Item:
    """An Item as item_from_raw would build it from REST, plus PR status."""
    created = _parse_time(node.get("createdAt"))
    updated = _parse_time(node.get("updatedAt"))
    assert created is not None and updated is not None
    author = node.get("author")
    item = Item(
        repo=repo,
        number=int(node["number"]),
        kind=kind,
        title=node.get("title") or "",
        body=node.get("body") or "",
        author=rest_login(author) or "ghost",
        author_association=node.get("authorAssociation") or "NONE",
        state=_state(node),
        html_url=node.get("url") or f"https://github.com/{repo}/issues/{node['number']}",
        created_at=created,
        updated_at=updated,
        closed_at=_parse_time(node.get("closedAt")),
        draft=bool(node.get("isDraft")),
        labels=[label["name"] for label in (node.get("labels") or {}).get("nodes") or [] if label],
        reactions=int((node.get("reactions") or {}).get("totalCount") or 0),
        comment_count=int((node.get("comments") or {}).get("totalCount") or 0),
        is_bot=(author or {}).get("__typename") == "Bot",
        assignees=[a["login"] for a in (node.get("assignees") or {}).get("nodes") or [] if a and a.get("login")],
    )
    if kind == "pr":
        item.closing_issues = sorted({
            int(ref["number"])
            for ref in (node.get("closingIssuesReferences") or {}).get("nodes") or []
            if ref and ((ref.get("repository") or {}).get("nameWithOwner") or "").lower() == repo.lower()
        })
        item.review_decision = node.get("reviewDecision")
        item.mergeable = node.get("mergeable")
        item.failing_checks = failing_checks(node.get("commits"))
        item.head_sha = head_commit(node.get("commits"))[0]
    return item


def _split(repo: str) -> tuple[str, str]:
    owner, _, name = repo.partition("/")
    return owner, name


class GraphQLGitHubClient:
    reads_pr_status = True

    def __init__(
        self, token: str, *, timeout: float = 60.0, min_remaining: int = 200,
        page_size: int = LIST_PAGE_SIZE,
    ) -> None:
        self._token = token
        self._timeout = timeout
        self._min_remaining = min_remaining
        self._page_size = page_size
        # Filled by prefetch, read (and emptied) by the per-item calls.
        self._files: dict[int, list[FileChange]] = {}
        self._comments: dict[int, list[CommentRecord]] = {}
        self._tails: dict[int, list[tuple[str, datetime | None]]] = {}
        self._authors: dict[int, str | None] = {}
        self.calls = 0
        self.cost = 0

    # --- transport -------------------------------------------------------------

    def _query(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = json.dumps({"query": query, "variables": variables or {}}).encode()
        request = Request(
            GRAPHQL_URL, data=payload, method="POST",
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        for attempt in range(4):
            try:
                self.calls += 1
                with urlopen(request, timeout=self._timeout) as response:
                    body = json.loads(response.read())
            except HTTPError as exc:
                if exc.code in (502, 503, 504) and attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise GitHubError(f"GraphQL: HTTP {exc.code}") from exc
            except (URLError, OSError, HTTPException, ValueError) as exc:
                # Network errors, a response cut short, or one that isn't JSON.
                if attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise GitHubError(f"GraphQL: {getattr(exc, 'reason', exc)}") from exc
            return self._check(body)
        raise GitHubError("GraphQL: retries exhausted")

    def _check(self, body: dict[str, Any]) -> dict[str, Any]:
        # NOT_FOUND only nulls the aliased field it belongs to (e.g. a number
        # that is neither an issue nor a PR); anything else fails the run, so
        # nothing is stored from a partial answer.
        errors = [e for e in body.get("errors") or [] if e.get("type") != "NOT_FOUND"]
        if errors:
            raise GitHubError("GraphQL: " + "; ".join(str(e.get("message")) for e in errors[:3]))
        data = body.get("data")
        if not isinstance(data, dict):
            raise GitHubError("GraphQL: no data in the response")
        rate = data.get("rateLimit") or {}
        self.cost += int(rate.get("cost") or 0)
        remaining = int(rate.get("remaining", 5000))
        if remaining < self._min_remaining:
            raise GitHubError(
                f"GitHub GraphQL rate limit nearly exhausted ({remaining} left, resets {rate.get('resetAt')})"
            )
        return data

    # --- listing -------------------------------------------------------------

    def updated_items(self, repo: str, since: datetime, *, max_items: int) -> list[Item]:
        owner, name = _split(repo)
        since_utc = since.astimezone(timezone.utc)
        variables: dict[str, Any] = {
            "owner": owner, "name": name, "first": self._page_size,
            "since": since_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "issuesAfter": None, "prsAfter": None, "withIssues": True, "withPrs": True,
        }
        items: list[Item] = []
        while variables["withIssues"] or variables["withPrs"]:
            repository = self._query(LIST_QUERY, variables).get("repository") or {}
            if variables["withIssues"]:
                issues = repository.get("issues") or {}
                items += [item_from_node(repo, n, "issue") for n in issues.get("nodes") or [] if n]
                page = issues.get("pageInfo") or {}
                variables["withIssues"] = bool(page.get("hasNextPage"))
                variables["issuesAfter"] = page.get("endCursor")
            if variables["withPrs"]:
                pulls = repository.get("pullRequests") or {}
                reached_cursor = False
                for node in pulls.get("nodes") or []:
                    if not node:
                        continue
                    item = item_from_node(repo, node, "pr")
                    if item.updated_at < since_utc:
                        reached_cursor = True
                        break
                    items.append(item)
                page = pulls.get("pageInfo") or {}
                variables["withPrs"] = bool(page.get("hasNextPage")) and not reached_cursor
                variables["prsAfter"] = page.get("endCursor")
        items.sort(key=lambda i: (i.updated_at, i.number))
        return items[:max_items]

    # --- per-item details, batched ---------------------------------------------

    def prefetch(self, repo: str, *, files: list[int], comments: list[int], authors: list[int]) -> None:
        fragments = {
            "files": f"... on PullRequest {{ {_FILES} }}",
            "comments": f"... on Issue {{ {_COMMENTS} }} ... on PullRequest {{ {_COMMENTS} }}",
            "authors": f"... on PullRequest {{ author {_ACTOR} }}",
        }
        wanted: dict[int, set[str]] = {}
        for kind, numbers, cache in (("files", files, self._files), ("comments", comments, self._comments),
                                     ("authors", authors, self._authors)):
            for number in numbers:
                if number not in cache:
                    wanted.setdefault(number, set()).add(kind)
        ordered = sorted(wanted)
        owner, name = _split(repo)
        for start in range(0, len(ordered), DETAIL_BATCH):
            chunk = ordered[start:start + DETAIL_BATCH]
            fields = "\n".join(
                f"n{n}: issueOrPullRequest(number: {n}) {{ __typename "
                f"{' '.join(fragments[k] for k in sorted(wanted[n]))} }}"
                for n in chunk
            )
            data = self._query(
                f"query($owner: String!, $name: String!) {{ {_RATE} "
                f"repository(owner: $owner, name: $name) {{ {fields} }} }}",
                {"owner": owner, "name": name},
            )
            repository = data.get("repository") or {}
            for n in chunk:
                self._store_details(repo, n, repository.get(f"n{n}"), wanted[n])

    def _store_details(self, repo: str, number: int, node: dict[str, Any] | None, kinds: set[str]) -> None:
        node = node or {}
        is_pr = node.get("__typename") == "PullRequest"
        if "files" in kinds:
            got = node.get("files") or {}
            changes = [_file(f) for f in got.get("nodes") or [] if f]
            page = got.get("pageInfo") or {}
            if page.get("hasNextPage"):
                changes += self._more_files(repo, number, page.get("endCursor"))
            self._files[number] = changes
        if "comments" in kinds:
            self._comments[number] = [_comment(c) for c in (node.get("first") or {}).get("nodes") or [] if c]
            self._tails[number] = [
                (rest_login(c.get("author")) or "ghost", _parse_time(c.get("createdAt")))
                for c in (node.get("tail") or {}).get("nodes") or [] if c
            ]
        if "authors" in kinds:
            self._authors[number] = rest_login(node.get("author")) if is_pr else None

    def _more_files(self, repo: str, number: int, after: str | None) -> list[FileChange]:
        owner, name = _split(repo)
        out: list[FileChange] = []
        for _ in range(MAX_FILE_PAGES - 1):
            data = self._query(FILES_QUERY, {"owner": owner, "name": name, "number": number, "after": after})
            got = (((data.get("repository") or {}).get("pullRequest") or {}).get("files")) or {}
            out += [_file(f) for f in got.get("nodes") or [] if f]
            page = got.get("pageInfo") or {}
            if not page.get("hasNextPage"):
                break
            after = page.get("endCursor")
        return out

    def pull_files(self, repo: str, number: int) -> list[FileChange]:
        if number not in self._files:
            self.prefetch(repo, files=[number], comments=[], authors=[])
        return self._files.pop(number, [])

    def comment_records(self, repo: str, number: int) -> list[CommentRecord]:
        if number not in self._comments:
            self.prefetch(repo, files=[], comments=[number], authors=[])
        return self._comments.pop(number, [])

    def comment_tail(self, repo: str, number: int) -> list[tuple[str, datetime | None]]:
        return self._tails.pop(number, [])

    def pull_authors(self, repo: str, numbers: list[int]) -> dict[int, str]:
        self.prefetch(repo, files=[], comments=[], authors=[n for n in numbers if n not in self._authors])
        out: dict[int, str] = {}
        for number in numbers:
            author = self._authors.pop(number, None)
            if author is not None:
                out[number] = author
        return out

    # --- whose move, for PRs the cursor would not re-read ----------------------

    def pr_statuses(self, repo: str, numbers: list[int]) -> dict[int, PrStatus]:
        owner, name = _split(repo)
        out: dict[int, PrStatus] = {}
        for start in range(0, len(numbers), STATUS_BATCH):
            chunk = numbers[start:start + STATUS_BATCH]
            fields = "\n".join(f"n{n}: pullRequest(number: {n}) {{ {_PR_STATUS} }}" for n in chunk)
            data = self._query(
                f"query($owner: String!, $name: String!) {{ {_RATE} "
                f"repository(owner: $owner, name: $name) {{ {fields} }} }}",
                {"owner": owner, "name": name},
            )
            repository = data.get("repository") or {}
            for n in chunk:
                node = repository.get(f"n{n}")
                if node:
                    head_sha, build_url = head_commit(node.get("commits"))
                    out[n] = PrStatus(
                        state=_state(node), draft=bool(node.get("isDraft")),
                        review_decision=node.get("reviewDecision"), mergeable=node.get("mergeable"),
                        failing_checks=failing_checks(node.get("commits")),
                        head_sha=head_sha, ci_build_url=build_url,
                    )
        return out

    def pull_diff(self, repo: str, number: int) -> str:
        """Fetch a PR's unified diff via REST (GraphQL does not expose patches)."""
        return fetch_pull_diff(
            repo, number, token=self._token, timeout=self._timeout, min_remaining=self._min_remaining
        )


def _file(node: dict[str, Any]) -> FileChange:
    return FileChange(str(node.get("path") or ""), int(node.get("additions") or 0), int(node.get("deletions") or 0))


def _comment(node: dict[str, Any]) -> CommentRecord:
    """As GitHubClient.comment_records stores it."""
    user = rest_login(node.get("author")) or "ghost"
    association = node.get("authorAssociation") or ""
    return (user, _parse_time(node.get("createdAt")), f"[{user} ({association})]: {node.get('body') or ''}")
