"""Choose 1-2 maintainers for a scored item from their own rules.

Matching semantics are shared with the dashboard rule preview
(src/lib/triage-rules.ts) and documented in docs/data-model.md; keep the two
in step. v1 routes only on explicit rules: items no rule matches stay
"unrouted" on the dashboard instead of being guessed onto someone.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date
from fnmatch import fnmatch
from typing import Any

from triage.model import Band, Maintainer


@dataclass(frozen=True)
class RoutingContext:
    """What the router knows about one item."""

    item_key: str
    kind: str
    title: str
    score: int
    band: Band
    facets: Mapping[str, Any]
    prepass: Mapping[str, Any]
    files: list[str]
    # Claude's judgement per maintainer (see relevance.py), current text only.
    relevance: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    # Opened recently enough that a page-band item may skip the weekly cap.
    fresh: bool = True


@dataclass(frozen=True)
class Candidate:
    maintainer: Maintainer
    matched: tuple[str, ...]
    load: int
    involvement: tuple[str, ...] = ()
    relevance: str | None = None
    evidence_prs: tuple[int, ...] = ()

    @property
    def rank(self) -> tuple[int, int, int, int]:
        authored = any(i.startswith("authored") for i in self.involvement)
        commented = "commented" in self.involvement
        level = {"high": 2, "medium": 1}.get(self.relevance or "", 0)
        return (-int(authored), -int(commented), -level, -len(self.matched))

    @property
    def reasons(self) -> list[str]:
        """What the dashboard shows as "why you": involvement, relevance with
        its evidence, then rule matches."""
        out = list(self.involvement)
        if self.relevance in ("high", "medium"):
            evidence = ", ".join(f"#{n}" for n in self.evidence_prs[:3])
            out.append(f"relevance:{self.relevance}" + (f" (like {evidence})" if evidence else ""))
        return out + list(self.matched)


def involvement(login: str, ctx: RoutingContext) -> list[str]:
    """How a maintainer is already part of this item, strongest first:
    they wrote a PR the item names (e.g. the commit a regression was
    bisected to), or they have commented on it."""
    me = login.lower()
    out = [
        f"authored #{number}"
        for number, author in (ctx.prepass.get("referenced_pr_authors") or {}).items()
        if str(author).lower() == me
    ]
    if me in (str(c).lower() for c in ctx.prepass.get("commenters") or []):
        out.append("commented")
    return out


def _lower(values: Iterable[Any]) -> list[str]:
    return [str(v).lower() for v in values if v]


def match_rules(rules: Mapping[str, Any], ctx: RoutingContext) -> list[str]:
    """Matched criteria like "area:moe"; empty when the rules do not match."""
    facets, prepass = ctx.facets, ctx.prepass
    areas = set(facets.get("areas") or []) | set(prepass.get("areas") or [])
    hardware = set(facets.get("hardware") or []) | set(prepass.get("hardware_hints") or [])
    model_names = _lower(
        n for m in facets.get("models") or [] for n in (m.get("name"), m.get("family"))
    ) + _lower(prepass.get("model_hints") or [])
    item_type = facets.get("type")
    haystack = f"{ctx.title}\n{facets.get('summary') or ''}".lower()

    exclude = rules.get("exclude") or {}
    if item_type in (exclude.get("types") or []):
        return []
    if areas & set(exclude.get("areas") or []):
        return []
    if hardware & set(exclude.get("hardware") or []):
        return []
    types = rules.get("types") or []
    if types and item_type not in types:
        return []

    matched: list[str] = []
    matched += [f"area:{a}" for a in rules.get("areas") or [] if a in areas]
    matched += [f"hardware:{h}" for h in rules.get("hardware") or [] if h in hardware]
    for pattern in rules.get("models") or []:
        if any(fnmatch(name, str(pattern).lower()) for name in model_names):
            matched.append(f"model:{pattern}")
    for pattern in rules.get("paths") or []:
        glob = str(pattern)
        if any(fnmatch(path, glob) or fnmatch(path, glob.rstrip("*").rstrip("/") + "/*") for path in ctx.files):
            matched.append(f"path:{pattern}")
    for keyword in rules.get("keywords") or []:
        if str(keyword).strip() and str(keyword).lower() in haystack:
            matched.append(f"keyword:{keyword}")
    return matched


def is_away(maintainer: Maintainer, today: date) -> bool:
    for window in maintainer.away:
        try:
            start = date.fromisoformat(window["start"])
            end = date.fromisoformat(window["end"])
        except (KeyError, ValueError):
            continue
        if start <= today <= end:
            return True
    return False


def choose_owners(
    ctx: RoutingContext,
    maintainers: Iterable[Maintainer],
    *,
    load: Mapping[str, int],
    excluded: set[str],
    today: date,
) -> list[Candidate]:
    """Primary (and a backup for page-band items), best fit first.

    Who qualifies, strongest first:
      1. involvement: wrote a PR the item names, or already commented;
      2. relevance judged high or medium from their recent work and notes;
      3. an explicit rule in their file (an "always send me" override).
    Relevance "low"/"none" alone never routes. A maintainer's `exclude`
    applies to relevance and rules but not to involvement. min_score, time
    away, not_mine and capacity always apply; only page-band items opened in
    the last few days (`fresh`) may exceed capacity, so a backlog is spread
    out instead of landing on one person at once.
    """
    candidates: list[Candidate] = []
    for maintainer in maintainers:
        if not maintainer.active or maintainer.github_login in excluded:
            continue
        if ctx.score < maintainer.min_score or is_away(maintainer, today):
            continue
        current = load.get(maintainer.github_login, 0)
        if current >= maintainer.capacity_per_week and not (ctx.band == "page" and ctx.fresh):
            continue
        involved = involvement(maintainer.github_login, ctx)
        judged = ctx.relevance.get(maintainer.github_login) or {}
        level = judged.get("relevance")
        is_excluded = _excluded(maintainer.rules, ctx)
        relevant = level in ("high", "medium") and not is_excluded
        matched = match_rules(maintainer.rules, ctx)
        if involved or relevant or matched:
            candidates.append(Candidate(
                maintainer, tuple(matched), current, tuple(involved),
                level if relevant else None,
                tuple(int(n) for n in judged.get("evidence_prs") or []) if relevant else (),
            ))
    candidates.sort(
        key=lambda c: (
            c.rank,
            c.load / max(1, c.maintainer.capacity_per_week),
            c.maintainer.github_login,
        )
    )
    return candidates[: 2 if ctx.band == "page" else 1]


def _excluded(rules: Mapping[str, Any], ctx: RoutingContext) -> bool:
    exclude = rules.get("exclude") or {}
    areas = set(ctx.facets.get("areas") or []) | set(ctx.prepass.get("areas") or [])
    hardware = set(ctx.facets.get("hardware") or []) | set(ctx.prepass.get("hardware_hints") or [])
    return bool(
        ctx.facets.get("type") in (exclude.get("types") or [])
        or areas & set(exclude.get("areas") or [])
        or hardware & set(exclude.get("hardware") or [])
    )
