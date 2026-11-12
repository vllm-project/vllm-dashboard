"""Choose 1-2 maintainers for a scored item from their own rules.

Matching semantics are shared with the dashboard rule preview
(src/lib/triage-rules.ts) and documented in docs/data-model.md; keep the two
in step. v1 routes only on explicit rules: items no rule matches stay
"unrouted" on the dashboard instead of being guessed onto someone.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
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


@dataclass(frozen=True)
class Candidate:
    maintainer: Maintainer
    matched: tuple[str, ...]
    load: int
    involvement: tuple[str, ...] = ()

    @property
    def rank(self) -> tuple[int, int, int]:
        authored = any(i.startswith("authored") for i in self.involvement)
        commented = "commented" in self.involvement
        return (-int(authored), -int(commented), -len(self.matched))


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
    """Primary (and a backup for page-band items), best match first.

    Being involved in the item outranks any rule match: whoever wrote the
    PR an item names comes first, then maintainers who already commented,
    then the most specific rule match. Involvement routes even when no rule
    matches (and despite `exclude`), but min_score, time away, not_mine
    and capacity still apply.

    `load` is each maintainer's assignments opened in the last 7 days;
    `excluded` are maintainers who already said not_mine to this item.
    A maintainer at capacity is skipped unless the item is in the page band.
    """
    candidates: list[Candidate] = []
    for maintainer in maintainers:
        if not maintainer.active or maintainer.github_login in excluded:
            continue
        if ctx.score < maintainer.min_score or is_away(maintainer, today):
            continue
        current = load.get(maintainer.github_login, 0)
        if current >= maintainer.capacity_per_week and ctx.band != "page":
            continue
        matched = match_rules(maintainer.rules, ctx)
        involved = involvement(maintainer.github_login, ctx)
        if matched or involved:
            candidates.append(Candidate(maintainer, tuple(matched), current, tuple(involved)))
    candidates.sort(
        key=lambda c: (
            c.rank,
            c.load / max(1, c.maintainer.capacity_per_week),
            c.maintainer.github_login,
        )
    )
    return candidates[: 2 if ctx.band == "page" else 1]
