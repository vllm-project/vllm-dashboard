"""Read-only GitHub REST client for issue/PR ingestion.

Uses the issues endpoint (which lists PRs too) ordered by update time, then
fetches changed files for in-scope PRs and the first comments of items that
have any. Needs only a read-only token; never writes.

Ingest uses the GraphQL client (github_graphql.py) by default, which does the
same work in a few batched queries; this one stays for TRIAGE_GITHUB_API=rest
(a quick rollback), the backtest, and maintainer profiles (search API).
Both implement `IngestClient`.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from triage.diff import RAW_DIFF_READ_LIMIT
from triage.model import FileChange, Item

API = "https://api.github.com"
USER_AGENT = "vllm-ci-triage"
MAX_FILE_PAGES = 3
MAX_COMMENTS = 30


# (login, created_at, text as stored: "[login (ASSOCIATION)]: body")
CommentRecord = tuple[str, datetime | None, str]


class GitHubError(Exception):
    pass


@dataclass(frozen=True)
class PrStatus:
    """Whose move it is on a PR, as of now (see prepass.whose_move)."""

    state: Literal["open", "closed", "merged"]
    draft: bool
    review_decision: str | None
    mergeable: str | None
    failing_checks: list[str]
    # Head commit, and the Buildkite build its `buildkite/ci...` status links
    # (None: no build started for it yet).
    head_sha: str | None = None
    ci_build_url: str | None = None


class IngestClient(Protocol):
    """What IngestHandler needs from GitHub."""

    # True when items carry review decision, mergeability and failing checks,
    # and pr_statuses() works (GraphQL only).
    reads_pr_status: bool

    def updated_items(self, repo: str, since: datetime, *, max_items: int) -> list[Item]:
        """Issues and PRs updated at or after `since`, oldest first, at most
        `max_items` (the oldest ones, so the cursor still advances)."""
        ...

    def prefetch(self, repo: str, *, files: list[int], comments: list[int], authors: list[int]) -> None:
        """Fetch in one go what pull_files/comment_records/pull_authors will be
        asked for next. A no-op where each call is its own request anyway."""
        ...

    def pull_files(self, repo: str, number: int) -> list[FileChange]: ...

    def comment_records(self, repo: str, number: int) -> list[CommentRecord]:
        """The first MAX_COMMENTS comments, oldest first."""
        ...

    def comment_tail(self, repo: str, number: int) -> list[tuple[str, datetime | None]]:
        """(login, created_at) of the latest comments, for threads longer than
        MAX_COMMENTS; may be empty."""
        ...

    def pull_authors(self, repo: str, numbers: list[int]) -> dict[int, str]:
        """Authors of those numbers that are PRs."""
        ...

    def pr_statuses(self, repo: str, numbers: list[int]) -> dict[int, PrStatus]:
        """Current status of open PRs; empty unless reads_pr_status."""
        ...

    def pull_diff(self, repo: str, number: int) -> str:
        """Raw unified diff for a PR (capped at RAW_DIFF_READ_LIMIT bytes), or ''."""
        ...


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class GitHubClient:
    reads_pr_status = False

    def __init__(self, token: str, *, timeout: float = 30.0, min_remaining: int = 200) -> None:
        self._token = token
        self._timeout = timeout
        self._min_remaining = min_remaining
        self.calls = 0

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = f"{API}{path}"
        if params:
            url += "?" + urlencode(params)
        request = Request(
            url,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": USER_AGENT,
            },
        )
        for attempt in range(4):
            try:
                self.calls += 1
                with urlopen(request, timeout=self._timeout) as response:
                    remaining = int(response.headers.get("X-RateLimit-Remaining", "5000"))
                    body = json.loads(response.read())
                    if remaining < self._min_remaining:
                        reset = int(response.headers.get("X-RateLimit-Reset", "0"))
                        raise GitHubError(
                            f"GitHub rate limit nearly exhausted ({remaining} left, resets {reset})"
                        )
                    return body
            except HTTPError as exc:
                if exc.code in (502, 503, 504) and attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                if exc.code == 404:
                    return None
                raise GitHubError(f"GET {path}: HTTP {exc.code}") from exc
            except URLError as exc:
                if attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise GitHubError(f"GET {path}: {exc.reason}") from exc
        raise GitHubError(f"GET {path}: retries exhausted")

    def issues_updated_since(
        self, repo: str, since: datetime, *, until: datetime | None = None, max_items: int = 2000
    ) -> Iterator[dict[str, Any]]:
        """Raw issue/PR objects updated at or after `since`, oldest first."""
        page = 1
        seen = 0
        while seen < max_items:
            batch = self._get(
                f"/repos/{repo}/issues",
                {
                    "state": "all",
                    "sort": "updated",
                    "direction": "asc",
                    "since": since.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "per_page": 100,
                    "page": page,
                },
            )
            if not batch:
                return
            for raw in batch:
                updated = _parse_time(raw.get("updated_at"))
                if until is not None and updated is not None and updated > until:
                    return
                yield raw
                seen += 1
                if seen >= max_items:
                    return
            if len(batch) < 100:
                return
            page += 1

    def updated_items(self, repo: str, since: datetime, *, max_items: int) -> list[Item]:
        return [item_from_raw(repo, raw) for raw in self.issues_updated_since(repo, since, max_items=max_items)]

    def prefetch(self, repo: str, *, files: list[int], comments: list[int], authors: list[int]) -> None:
        return None

    def pull_files(self, repo: str, number: int) -> list[FileChange]:
        files: list[FileChange] = []
        for page in range(1, MAX_FILE_PAGES + 1):
            batch = self._get(f"/repos/{repo}/pulls/{number}/files", {"per_page": 100, "page": page})
            if not batch:
                break
            files.extend(
                FileChange(f["filename"], int(f.get("additions") or 0), int(f.get("deletions") or 0))
                for f in batch
            )
            if len(batch) < 100:
                break
        return files

    def maintainer_prs(
        self, repo: str, login: str, *, since: datetime, per_kind: int = 120
    ) -> list[dict[str, Any]]:
        """A maintainer's recent PRs, newest first: what they authored, then
        what they reviewed (excluding their own). Uses the search API, which
        has its own 30/minute budget, so calls are spaced out."""
        out: list[dict[str, Any]] = []
        day = since.astimezone(timezone.utc).strftime("%Y-%m-%d")
        for kind, query in (
            ("authored", f"repo:{repo} is:pr author:{login} created:>={day}"),
            ("reviewed", f"repo:{repo} is:pr reviewed-by:{login} -author:{login} created:>={day}"),
        ):
            got = 0
            for page in (1, 2):
                time.sleep(2.2)
                result = self._get("/search/issues", {"q": query, "sort": "created", "order": "desc",
                                                      "per_page": 100, "page": page}) or {}
                items = result.get("items") or []
                for raw in items:
                    if got >= per_kind:
                        break
                    out.append({"number": int(raw["number"]), "kind": kind, "title": str(raw.get("title") or "")})
                    got += 1
                if len(items) < 100 or got >= per_kind:
                    break
        return out

    def pull_author(self, repo: str, number: int) -> str | None:
        pull = self._get(f"/repos/{repo}/pulls/{number}")
        if not isinstance(pull, dict):
            return None  # not a PR (e.g. an issue number) or gone
        login = (pull.get("user") or {}).get("login")
        return login if isinstance(login, str) else None

    def pull_authors(self, repo: str, numbers: list[int]) -> dict[int, str]:
        out: dict[int, str] = {}
        for number in numbers:
            author = self.pull_author(repo, number)
            if author is not None:
                out[number] = author
        return out

    def comment_tail(self, repo: str, number: int) -> list[tuple[str, datetime | None]]:
        return []

    def pr_statuses(self, repo: str, numbers: list[int]) -> dict[int, PrStatus]:
        return {}

    def pull_diff(self, repo: str, number: int) -> str:
        return fetch_pull_diff(
            repo, number, token=self._token, timeout=self._timeout, min_remaining=self._min_remaining
        )

    def comment_records(self, repo: str, number: int) -> list[CommentRecord]:
        """(login, created_at, text as stored) for the first MAX_COMMENTS comments."""
        batch = self._get(f"/repos/{repo}/issues/{number}/comments", {"per_page": MAX_COMMENTS}) or []
        out = []
        for comment in batch:
            user = (comment.get("user") or {}).get("login", "?")
            association = comment.get("author_association", "")
            out.append((user, _parse_time(comment.get("created_at")),
                        f"[{user} ({association})]: {comment.get('body') or ''}"))
        return out

    def comments(self, repo: str, number: int) -> list[str]:
        return [text for _, _, text in self.comment_records(repo, number)]


def fetch_pull_diff(
    repo: str,
    number: int,
    *,
    token: str,
    timeout: float = 30.0,
    min_remaining: int = 200,
    max_bytes: int = RAW_DIFF_READ_LIMIT,
) -> str:
    """Fetch a PR's unified diff via REST (capped at `max_bytes`).

    Returns '' on 404/406/422 (e.g. GitHub's diff-too-large 406) so giant PRs
    never break ingest.
    """
    url = f"{API}/repos/{repo}/pulls/{number}"
    request = Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github.v3.diff",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
        },
    )
    for attempt in range(4):
        try:
            with urlopen(request, timeout=timeout) as response:
                remaining = int(response.headers.get("X-RateLimit-Remaining", "5000"))
                raw: bytes = response.read(max_bytes)
                if remaining < min_remaining:
                    reset = int(response.headers.get("X-RateLimit-Reset", "0"))
                    raise GitHubError(
                        f"GitHub rate limit nearly exhausted ({remaining} left, resets {reset})"
                    )
                return raw.decode("utf-8", errors="replace")
        except HTTPError as exc:
            if exc.code in (502, 503, 504) and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            if exc.code in (404, 406, 422):
                return ""
            raise GitHubError(f"GET /repos/{repo}/pulls/{number} (diff): HTTP {exc.code}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            if attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise GitHubError(f"GET /repos/{repo}/pulls/{number} (diff): {getattr(exc, 'reason', exc)}") from exc
    raise GitHubError(f"GET /repos/{repo}/pulls/{number} (diff): retries exhausted")


def item_from_raw(repo: str, raw: dict[str, Any]) -> Item:
    """Convert an issues-endpoint object; files/comments are filled separately."""
    is_pr = "pull_request" in raw
    merged_at = (raw.get("pull_request") or {}).get("merged_at") if is_pr else None
    state = "merged" if merged_at else raw.get("state", "open")
    user = raw.get("user") or {}
    created = _parse_time(raw.get("created_at"))
    updated = _parse_time(raw.get("updated_at"))
    assert created is not None and updated is not None
    return Item(
        repo=repo,
        number=int(raw["number"]),
        kind="pr" if is_pr else "issue",
        title=raw.get("title") or "",
        body=raw.get("body") or "",
        author=user.get("login") or "ghost",
        author_association=raw.get("author_association") or "NONE",
        state=cast(Literal["open", "closed", "merged"], state if state in ("open", "closed", "merged") else "closed"),
        html_url=raw.get("html_url") or f"https://github.com/{repo}/issues/{raw['number']}",
        created_at=created,
        updated_at=updated,
        closed_at=_parse_time(raw.get("closed_at")),
        draft=bool(raw.get("draft")),
        labels=[label["name"] for label in raw.get("labels") or [] if isinstance(label, dict)],
        reactions=int((raw.get("reactions") or {}).get("total_count") or 0),
        comment_count=int(raw.get("comments") or 0),
        is_bot=user.get("type") == "Bot",
        assignees=[a["login"] for a in raw.get("assignees") or [] if isinstance(a, dict) and a.get("login")],
    )
