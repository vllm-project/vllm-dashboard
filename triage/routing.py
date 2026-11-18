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
    def rank(self) -> tuple[int, int, int, int, int]:
        assigned = GH_ASSIGNED in self.involvement
        authored = any(i.startswith("authored") for i in self.involvement)
        commented = "commented" in self.involvement
        level = {"high": 2, "medium": 1}.get(self.relevance or "", 0)
        return (-int(assigned), -int(authored), -int(commented), -level, -len(self.matched))

    @property
    def strong(self) -> bool:
        """A clear match: already involved, or judged high."""
        return bool(self.involvement) or self.relevance == "high"

    @property
    def reasons(self) -> list[str]:
        """What the dashboard shows as "why you": involvement, relevance with
        its evidence, then rule matches."""
        out = list(self.involvement)
        if self.relevance in ("high", "medium"):
            evidence = ", ".join(f"#{n}" for n in self.evidence_prs[:3])
            out.append(f"relevance:{self.relevance}" + (f" (like {evidence})" if evidence else ""))
        return out + list(self.matched)


# Reason code: the item is assigned to this maintainer on GitHub.
GH_ASSIGNED = "assigned on GitHub"


def gh_assignees(prepass: Mapping[str, Any]) -> set[str]:
    """GitHub assignees of the item, lower case."""
    return {str(a).lower() for a in prepass.get("gh_assignees") or [] if a}


def assigned_elsewhere(prepass: Mapping[str, Any], maintainers: Iterable[str]) -> bool:
    """The item has GitHub assignees and none of them is one of our
    maintainers: someone outside triage is already handling it, so the
    router leaves it alone (it stays on the dashboard)."""
    assignees = gh_assignees(prepass)
    return bool(assignees) and not assignees & {m.lower() for m in maintainers}


def waiting_on_author(prepass: Mapping[str, Any], band: str) -> bool:
    """A PR whose next move is its author's (prepass.waiting_on, see
    prepass.whose_move) isn't routed, unless it is page band: a P0 fix needs
    an owner even while it is red, so someone can get it over the line."""
    return prepass.get("waiting_on") == "author" and band != "page"


def involvement(login: str, ctx: RoutingContext) -> list[str]:
    """How a maintainer is already part of this item, strongest first:
    the item is assigned to them on GitHub, they wrote a PR the item names
    (e.g. the commit a regression was bisected to), or they have commented
    on it."""
    me = login.lower()
    out = [GH_ASSIGNED] if me in gh_assignees(ctx.prepass) else []
    out += [
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
    strong_only: bool = False,
) -> list[Candidate]:
    """Primary (and a backup for page-band items), best fit first.

    With `strong_only`, only clear matches (involved or "high") qualify; the
    route consumer runs that pass over the whole queue first, so weaker
    matches only use capacity that clear matches left over. A backup must
    always be a clear match: a second "medium" guess adds noise, not cover.

    Who qualifies, strongest first:
      1. involvement: assigned on GitHub, wrote a PR the item names, or
         already commented;
      2. relevance judged high or medium from their recent work and notes;
      3. an explicit rule in their file (an "always send me" override).
    Relevance "low"/"none" alone never routes. A maintainer's `exclude`
    applies to relevance and rules but not to involvement. min_score, time
    away and not_mine always apply. Capacity applies too, except to page-band
    items that are fresh (opened in the last few days) or a clear match for
    that person (involved or "high"): a weekly cap must not keep a P0 from
    the one person it is clearly for, but a backlog of weaker matches is
    still spread out instead of landing on one person at once.
    """
    candidates: list[Candidate] = []
    for maintainer in maintainers:
        if not maintainer.active or maintainer.github_login in excluded:
            continue
        if ctx.score < maintainer.min_score or is_away(maintainer, today):
            continue
        involved = involvement(maintainer.github_login, ctx)
        judged = ctx.relevance.get(maintainer.github_login) or {}
        level = judged.get("relevance")
        is_excluded = _excluded(maintainer.rules, ctx)
        relevant = level in ("high", "medium") and not is_excluded
        matched = match_rules(maintainer.rules, ctx)
        current = load.get(maintainer.github_login, 0)
        clear_match = bool(involved) or (relevant and level == "high")
        if current >= maintainer.capacity_per_week and not (
            ctx.band == "page" and (ctx.fresh or clear_match)
        ):
            continue
        if involved or relevant or matched:
            candidates.append(Candidate(
                maintainer, tuple(matched), current, tuple(involved),
                level if relevant else None,
                tuple(int(n) for n in judged.get("evidence_prs") or []) if relevant else (),
            ))
    if strong_only:
        candidates = [c for c in candidates if c.strong]
    candidates.sort(
        key=lambda c: (
            c.rank,
            c.load / max(1, c.maintainer.capacity_per_week),
            c.maintainer.github_login,
        )
    )
    owners = candidates[:1]
    if ctx.band == "page":
        owners += [c for c in candidates[1:] if c.strong][:1]
    return owners


def _excluded(rules: Mapping[str, Any], ctx: RoutingContext) -> bool:
    """A maintainer's hard "don't send me". Hardware only excludes an item
    that is entirely about excluded hardware: an NVIDIA fix whose text also
    mentions an AMD GPU (say, in a test matrix) is still theirs. Claude's
    hardware label is used; the text scan only when Claude found none."""
    exclude = rules.get("exclude") or {}
    areas = set(ctx.facets.get("areas") or []) | set(ctx.prepass.get("areas") or [])
    hardware = set(ctx.facets.get("hardware") or []) or set(ctx.prepass.get("hardware_hints") or [])
    excluded_hw = set(exclude.get("hardware") or [])
    return bool(
        ctx.facets.get("type") in (exclude.get("types") or [])
        or areas & set(exclude.get("areas") or [])
        or (hardware and hardware <= excluded_hw)
    )
