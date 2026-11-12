"""Deterministic signals computed on every ingest, before any LLM call.

They decide scope (what the LLM reads at all), order the extraction queue
when the budget is short, and give the scorer facts that do not depend on
the model: areas from changed paths, linked issues, hardware/model mentions.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from triage.config import TriageConfig
from triage.model import MAINTAINER_ASSOCIATIONS, Item

BODY_LIMIT = 20_000
COMMENTS_LIMIT = 8_000
MAX_FILES = 300

_LINKED_ISSUE = re.compile(
    r"(?i)\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|related(?: to)?|addresses)"
    r"\s*:?\s+(?:https://github\.com/vllm-project/vllm/issues/|#)(\d+)"
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


def content_hash(item: Item) -> str:
    """Hash of everything the extractor reads; a change re-queues extraction."""
    digest = hashlib.sha256()
    for part in (item.title, item.body[:BODY_LIMIT], "\n".join(item.comments)[:COMMENTS_LIMIT]):
        digest.update(part.encode())
        digest.update(b"\0")
    for change in item.files[:MAX_FILES]:
        digest.update(change.path.encode())
        digest.update(b"\n")
    return digest.hexdigest()[:32]


def linked_issues(text: str) -> list[int]:
    found = {int(n) for n in _LINKED_ISSUE.findall(text)}
    found.update(int(n) for n in _ISSUE_URL.findall(text))
    return sorted(found)


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
    return reason not in ("bot", "pr_maintainer_unlinked")


def compute_prepass(item: Item, config: TriageConfig) -> dict[str, Any]:
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
    links = linked_issues(text)
    template = _template(item)
    reason = scope_reason(item, links)
    return {
        "areas": sorted(areas),
        "linked_issues": links,
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
