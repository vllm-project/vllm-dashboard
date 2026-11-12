"""Read-only GitHub REST client for issue/PR ingestion.

Uses the issues endpoint (which lists PRs too) ordered by update time, then
fetches changed files for in-scope PRs and the first comments of items that
have any. Needs only a read-only token; never writes.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any, Literal, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from triage.model import FileChange, Item

API = "https://api.github.com"
USER_AGENT = "vllm-ci-triage"
MAX_FILE_PAGES = 3
MAX_COMMENTS = 30


class GitHubError(Exception):
    pass


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class GitHubClient:
    def __init__(self, token: str, *, timeout: float = 30.0, min_remaining: int = 200) -> None:
        self._token = token
        self._timeout = timeout
        self._min_remaining = min_remaining

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

    def comments(self, repo: str, number: int) -> list[str]:
        batch = self._get(f"/repos/{repo}/issues/{number}/comments", {"per_page": MAX_COMMENTS}) or []
        out = []
        for comment in batch:
            user = (comment.get("user") or {}).get("login", "?")
            association = comment.get("author_association", "")
            out.append(f"[{user} ({association})]: {comment.get('body') or ''}")
        return out


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
    )
