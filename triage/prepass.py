"""Deterministic signals computed on every ingest, before any LLM call.

They decide scope (what the LLM reads at all), order the extraction queue
when the budget is short, and give the scorer facts that do not depend on
the model: areas from changed paths, linked issues, hardware/model mentions.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta
import re
from typing import Any

from triage.ci import ci_waits_on_author, pr_only_job_names
from triage.config import TriageConfig
from triage.diff import DIFF_LIMIT
from triage.model import MAINTAINER_ASSOCIATIONS, Item

BODY_LIMIT = 20_000
COMMENTS_LIMIT = 8_000
MAX_FILES = 300

_LINKED_ISSUE = re.compile(
    r"(?i)\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|related(?: to)?|addresses)"
    r"\s*:?\s+(?:https://github\.com/vllm-project/vllm/issues/|#)(\d+)"
)
# Only GitHub's closing keywords: a PR "fixes" an issue when it says
# "Fixes #N" / "Closes #N" / "Resolves #N" (or the issue URL). "Related to
# #N" or a bare mention is a link (linked_issues) but not a fix, so it never
# couples the two items (triage/groups.py).
_FIXES_ISSUE = re.compile(
    r"(?i)\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s*"
    r"(?:https://github\.com/vllm-project/vllm/issues/|vllm-project/vllm#|#)(\d+)\b"
)
_ISSUE_URL = re.compile(r"https://github\.com/vllm-project/vllm/issues/(\d+)")
# PRs an item points at: pull URLs, "PR #123", and commit subjects "... (#123)".
_PR_REFS = (
    re.compile(r"https://github\.com/vllm-project/vllm/pull/(\d+)"),
    re.compile(r"(?i)\b(?:PR|pull request)\s*#\s*(\d{3,6})\b"),
    re.compile(r"\(#(\d{4,6})\)"),
)
# Comment lines as stored by GitHubClient.comments: "[login (ASSOCIATION)]: body".
_COMMENTER = re.compile(r"(?m)^\[([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\s\((\w*)\)\]: ")
MAX_REFERENCED_PRS = 5

# Ordered: more specific first so "GB200" is not also counted as "B200".
_HARDWARE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (name, re.compile(pattern, re.IGNORECASE))
    for name, pattern in (
        ("GB300", r"(?<![A-WYZa-wyz])GB300\b"),
        ("GB200", r"(?<![A-WYZa-wyz])GB200\b"),
        ("B300", r"(?<![A-WYZa-wyz])B300\b"),
        ("B200", r"(?<![A-WYZa-wyz])B200\b"),
        ("H200", r"(?<![A-WYZa-wyz])H200\b"),
        ("H100", r"(?<![A-WYZa-wyz])H100\b|(?<![A-WYZa-wyz])H800\b"),
        ("A100", r"(?<![A-WYZa-wyz])A100\b|(?<![A-WYZa-wyz])A800\b"),
        ("L40S", r"(?<![A-WYZa-wyz])L40S?\b"),
        ("MI355X", r"(?<![A-WYZa-wyz])MI35[05]X?\b"),
        ("MI325X", r"(?<![A-WYZa-wyz])MI325X?\b"),
        ("MI300X", r"(?<![A-WYZa-wyz])MI300X?\b|(?<![A-WYZa-wyz])MI308X?\b"),
        ("TPU", r"(?<![A-WYZa-wyz])TPU(?:v\d+\w*)?\b|(?<![A-WYZa-wyz])trillium\b"),
        ("Gaudi", r"(?<![A-WYZa-wyz])Gaudi\d?\b|(?<![A-WYZa-wyz])HPU\b"),
        ("XPU", r"(?<![A-WYZa-wyz])XPU\b|(?<![A-WYZa-wyz])Arc\b|(?<![A-WYZa-wyz])Ponte Vecchio\b"),
        ("RTX", r"(?<![A-WYZa-wyz])RTX\s?\d{4}\b|(?<![A-WYZa-wyz])GeForce\b"),
        ("Apple", r"(?<![A-WYZa-wyz])Apple Silicon\b|(?<![A-WYZa-wyz])M[1-4] (?:Max|Pro|Ultra)\b"),
    )
)
_MODEL_HINT = re.compile(
    r"(?i)\b("
    r"deepseek[-\w.]*|qwen[-\w.]*|llama[-\w.]*|gpt-oss[-\w.]*|kimi[-\w.]*|"
    r"glm[-\w.]*|gemma[-\w.]*|mistral[-\w.]*|mixtral[-\w.]*|minimax[-\w.]*|"
    r"phi[-\d][-\w.]*|granite[-\w.]*|nemotron[-\w.]*|internvl[-\w.]*"
    r")"
)
_ENV_SECTION = re.compile(r"(?i)(collect_env|your current environment|PyTorch version|vLLM Version)")
_REPRO_SECTION = re.compile(r"(?i)(```|steps to reproduce|minimal reproduc|how to reproduce|vllm serve )")
_TEST_PLAN = re.compile(r"(?is)##\s*Test Plan\s*(.*?)(?:\n##\s|\Z)")
_BOT_LOGINS = re.compile(r"(?i)(\[bot\]$|^dependabot|^renovate|^github-actions|^mergify)")
_EXTRA_BOT_LOGINS = frozenset({"copilot", "vllm-bot", "mergify", "codecov", "coderabbitai", "greptile-apps"})
_SLASH_CMD_LINE = re.compile(r"^\s*/[a-z][a-z0-9_-]*(?:\s+.*)?$", re.IGNORECASE)
_NOISE_PHRASES = frozenset({
    "+1", "1", "bump", "ping", "ptal", "following", "same", "same here",
    "me too", "any update", "any updates", "thanks", "thank you", "thx",
    "lgtm", "done", "fixed", "rebased", "merged main", "updated", "up",
})
_SIGNAL_REF = re.compile(r"(#\d+|https?://|`)")
_NON_WORD_SPACE = re.compile(r"[^\w\s+]+")
# A GitHub user login, as _COMMENTER reads it (bots, "name[bot]", are not).
LOGIN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})")

# Checks whose failure is the PR author's to fix. vLLM's other red checks
# are not: "pre-run-check" fails until a maintainer adds the `ready` label
# (the reviewers' move), the docs build and the full Buildkite run
# ("buildkite/ci/pr...") are often red for reasons outside the PR.
AUTHOR_CHECKS = frozenset({"pre-commit", "DCO"})
# Why a PR waits on its author, in the order the dashboard lists them.
# "ci_pr_failures": its finished Buildkite build has failures main doesn't
# have (triage/ci.py, CI_PR_ONLY_FAILURES_WAIT_ON_AUTHOR).
WAITING_REASONS = ("draft", "ci_failing", "ci_pr_failures", "merge_conflict", "changes_requested")


def is_noise_comment(login: str, body: str) -> bool:
    """True for bot comments and low-signal chatter ('+1', 'bump', '/ci run',
    short replies with no refs/links/code) that shouldn't invalidate content_hash."""
    if _BOT_LOGINS.search(login) or login.lower() in _EXTRA_BOT_LOGINS:
        return True
    # Strip quoted lines and blank lines.
    lines = [line.strip() for line in body.splitlines() if line.strip() and not line.lstrip().startswith(">")]
    if not lines:
        return True
    if all(_SLASH_CMD_LINE.match(line) for line in lines):
        return True
    cleaned = " ".join(lines).strip()
    norm = _NON_WORD_SPACE.sub(" ", cleaned.lower()).strip()
    norm = " ".join(norm.split())
    if not norm or norm in _NOISE_PHRASES:
        return True
    if len(cleaned) < 20 and not _SIGNAL_REF.search(cleaned):
        return True
    return False


def filter_comment_records(records: list[tuple[str, Any, str]]) -> list[tuple[str, Any, str]]:
    """Keep only substantive comments for extraction & content_hash."""
    out: list[tuple[str, Any, str]] = []
    for login, created_at, text in records:
        _, sep, body = text.partition("]: ")
        raw_body = body if sep else text
        if not is_noise_comment(login, raw_body):
            out.append((login, created_at, text))
    return out


def core_content_hash(item: Item) -> str:
    """Hash of title, body, changed files, and PR diff excerpt (no comments)."""
    digest = hashlib.sha256()
    for part in (item.title, item.body[:BODY_LIMIT]):
        digest.update(part.encode())
        digest.update(b"\0")
    for change in item.files[:MAX_FILES]:
        digest.update(change.path.encode())
        digest.update(b"\n")
    if item.diff_excerpt:
        digest.update(b"\0diff\0")
        digest.update(item.diff_excerpt[:DIFF_LIMIT].encode())
    return digest.hexdigest()[:32]


def content_hash(item: Item) -> str:
    """Hash of everything the extractor reads; a change re-queues extraction."""
    digest = hashlib.sha256()
    for part in (item.title, item.body[:BODY_LIMIT], "\n".join(item.comments)[:COMMENTS_LIMIT]):
        digest.update(part.encode())
        digest.update(b"\0")
    for change in item.files[:MAX_FILES]:
        digest.update(change.path.encode())
        digest.update(b"\n")
    if item.diff_excerpt:
        digest.update(b"\0diff\0")
        digest.update(item.diff_excerpt[:DIFF_LIMIT].encode())
    return digest.hexdigest()[:32]


def linked_issues(text: str) -> list[int]:
    found = {int(n) for n in _LINKED_ISSUE.findall(text)}
    found.update(int(n) for n in _ISSUE_URL.findall(text))
    return sorted(found)


def fixes_issues(text: str) -> list[int]:
    """Issues the text closes with a GitHub closing keyword ("Fixes #N")."""
    return sorted({int(n) for n in _FIXES_ISSUE.findall(text)})


def referenced_prs(text: str, *, exclude: set[int] | None = None) -> list[int]:
    """PR numbers the text names (e.g. the commit a regression was bisected
    to), in order of first mention, capped."""
    seen: dict[int, None] = {}
    for pattern in _PR_REFS:
        for match in pattern.finditer(text):
            seen.setdefault(int(match.group(1)), None)
    out = [n for n in sorted(seen, key=lambda n: text.find(str(n))) if n not in (exclude or set())]
    return out[:MAX_REFERENCED_PRS]


def commenters(comments: list[str] | str) -> list[str]:
    """Logins that commented, in order, from stored comment text."""
    text = comments if isinstance(comments, str) else "\n\n".join(comments)
    seen: dict[str, None] = {}
    for login, _association in _COMMENTER.findall(text):
        seen.setdefault(login, None)
    return list(seen)


def hardware_hints(text: str) -> list[str]:
    hits: list[str] = []
    for name, pattern in _HARDWARE_PATTERNS:
        if pattern.search(text):
            hits.append(name)
    return hits


def model_hints(text: str) -> list[str]:
    seen: dict[str, None] = {}
    for match in _MODEL_HINT.findall(text):
        name = match.strip(".-")
        if len(name) > 3:
            seen.setdefault(name, None)
    return list(seen)[:10]


def _template(item: Item) -> dict[str, bool]:
    body = item.body
    if item.kind == "issue":
        return {
            "has_env": bool(_ENV_SECTION.search(body)),
            "has_repro": bool(_REPRO_SECTION.search(body)),
        }
    plan = _TEST_PLAN.search(body)
    plan_text = re.sub(r"<!--.*?-->", "", plan.group(1), flags=re.S).strip() if plan else ""
    return {"test_plan": len(plan_text) > 20}


def _slop_hints(item: Item, template: dict[str, bool]) -> list[str]:
    hints: list[str] = []
    if item.kind == "pr":
        if not template.get("test_plan"):
            hints.append("empty_test_plan")
        if len(item.body.strip()) < 40:
            hints.append("empty_description")
        touched_dirs = {change.path.split("/")[0] for change in item.files}
        if len(item.files) > 60 and len(touched_dirs) > 6:
            hints.append("sprawling_change")
    else:
        if len(item.body.strip()) < 60:
            hints.append("empty_body")
    return hints


def scope_reason(item: Item, links: list[int]) -> str:
    if item.is_bot or _BOT_LOGINS.search(item.author):
        return "bot"
    if item.kind == "issue":
        return "issue"
    if item.author_association not in MAINTAINER_ASSOCIATIONS:
        return "pr_external"
    if links:
        return "pr_linked_issue"
    return "pr_maintainer_unlinked"


def in_scope(reason: str) -> bool:
    return reason not in ("bot", "pr_maintainer_unlinked", "too_old")


def whose_move(
    *, draft: bool, review_decision: str | None, mergeable: str | None, failing_checks: list[str] | None,
    ci: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Whose move an open PR is: "author" when it is a draft, a check the
    author must fix is failing (AUTHOR_CHECKS), its finished CI build has
    failures main doesn't have (`ci`, the head commit's summary from
    triage/ci.py), it has merge conflicts, or a reviewer requested changes;
    "reviewer" otherwise. `failing_checks` None means the client could not
    read checks/reviews (REST): draft only. `ci` None: CI not known."""
    failing = list(failing_checks or [])
    reasons = {
        "draft": draft,
        "ci_failing": any(name in AUTHOR_CHECKS for name in failing),
        "ci_pr_failures": ci_waits_on_author(ci),
        "merge_conflict": mergeable == "CONFLICTING",
        "changes_requested": review_decision == "CHANGES_REQUESTED",
    }
    out: dict[str, Any] = {
        "waiting_on": "author" if any(reasons.values()) else "reviewer",
        "waiting_reasons": [r for r in WAITING_REASONS if reasons[r]],
    }
    if review_decision is not None:
        out["review_decision"] = review_decision
    if mergeable is not None:
        out["mergeable"] = mergeable
    if failing_checks is not None:
        out["failing_checks"] = failing[:10]
    if ci is not None:
        out["ci_pr_only_jobs"] = pr_only_job_names(ci) if reasons["ci_pr_failures"] else []
    return out


def merge_readiness(
    *, draft: bool, review_decision: str | None, mergeable: str | None,
    checks_state: str | None, head_sha: str | None, ci: dict[str, Any] | None,
    now: datetime | None,
) -> dict[str, Any]:
    """Conservative observed readiness, not permission to bypass GitHub merge rules."""
    return {
        "merge_ready": bool(
            not draft and review_decision == "APPROVED" and mergeable == "MERGEABLE"
            and checks_state == "SUCCESS" and head_sha and ci
            and ci.get("head_sha") == head_sha and ci.get("state") == "passed"
        ),
        "merge_checked_at": now.isoformat() if now else None,
        "review_decision": review_decision,
        "mergeable": mergeable,
        "checks_state": checks_state,
        "head_sha": head_sha,
    }


def compute_prepass(
    item: Item, config: TriageConfig, now: datetime | None = None, *, ci: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """`now` enables the age limit (config.max_age_days); without it (e.g.
    offline backtests) every item is judged on content alone. `ci`: the PR's
    stored CI summary for its current head commit, if any."""
    text = f"{item.title}\n{item.body}"
    areas: set[str] = set()
    for change in item.files:
        areas |= config.areas.areas_for_path(change.path)
    for label in item.labels:
        if label in config.areas.labels:
            areas.add(config.areas.labels[label])
    # Tests and docs alone say little about where the change lives.
    if item.kind == "pr" and areas - {"docs", "ci"}:
        areas.discard("docs")
    # The PR's closing references ("Development" sidebar) count as links
    # too, whether or not the body says "Fixes #N".
    links = sorted(set(linked_issues(text)) | set(item.closing_issues))
    template = _template(item)
    reason = scope_reason(item, links)
    if now is not None and item.created_at < now - timedelta(days=config.max_age_days):
        reason = "too_old"
    return {
        "areas": sorted(areas),
        "linked_issues": links,
        # What the PR fixes: closing keywords plus its closing references.
        # Plain mentions don't count (see triage/groups.py).
        "fixes_issues": sorted(set(fixes_issues(text)) | set(item.closing_issues)) if item.kind == "pr" else [],
        "hardware_hints": hardware_hints(text),
        "model_hints": model_hints(text),
        "is_maintainer": item.author_association in MAINTAINER_ASSOCIATIONS,
        "first_time": item.author_association
        in ("FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"),
        "template": template,
        "slop_hints": _slop_hints(item, template),
        "scope_reason": reason,
        "referenced_prs": referenced_prs(text, exclude={item.number, *links}),
        "commenters": commenters(item.comments),
        "gh_assignees": list(item.assignees),
        **(
            whose_move(draft=item.draft, review_decision=item.review_decision,
                       mergeable=item.mergeable, failing_checks=item.failing_checks, ci=ci)
            | merge_readiness(draft=item.draft, review_decision=item.review_decision,
                              mergeable=item.mergeable, checks_state=item.checks_state,
                              head_sha=item.head_sha, ci=ci, now=now)
            if item.kind == "pr" and item.state == "open" else {}
        ),
    }


def prepass_priority(item: Item, prepass: dict[str, Any]) -> int:
    """Order the extraction queue: likely-important, fresh items first."""
    text = f"{item.title}\n{item.body[:4000]}".lower()
    priority = 0
    for word, points in (
        ("regression", 30), ("crash", 25), ("cannot start", 25), ("fails to start", 25),
        ("garbage", 20), ("wrong output", 20), ("hang", 15), ("oom", 10),
        ("illegal memory access", 25), ("nan", 10), ("slower", 15), ("throughput", 8),
    ):
        if word in text:
            priority += points
    if prepass["hardware_hints"]:
        priority += 5
    if prepass["model_hints"]:
        priority += 5
    priority += min(item.reactions, 20)
    if item.kind == "issue":
        priority += 10
    if item.state != "open":
        priority -= 50
    return priority
