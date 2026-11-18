"""Relevance from history: judgement parsing and how routing uses it."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from triage.extract import ExtractionError
from triage.model import Maintainer
from triage.relevance import MaintainerProfile, RelevanceTask, parse_judgments, render_profiles
from triage.routing import RoutingContext, choose_owners

PROFILES = {
    "gau": MaintainerProfile("gau", [{"number": 61343, "kind": "authored", "title": "per_token_group_quant reciprocal"}],
                             "NVIDIA kernels. Don't send me ROCm.", "h1"),
    "amd": MaintainerProfile("amd", [{"number": 7, "kind": "reviewed", "title": "[ROCm] AITER MLA"}], "", "h2"),
}
TASK = RelevanceTask("r#1", "issue", "FP8 accuracy drop", {"summary": "s"}, "c", ["gau", "amd"])


def test_profiles_render_notes_and_escape_titles() -> None:
    text = render_profiles([MaintainerProfile("x", [{"number": 1, "kind": "authored", "title": "<b>&"}], "my notes", "h")])
    assert "<notes>my notes</notes>" in text and "&lt;b&gt;&amp;" in text


def test_judgments_keep_only_own_evidence_and_known_people() -> None:
    out = parse_judgments({"judgments": [
        {"github_login": "gau", "relevance": "high", "evidence_prs": [61343, 999], "reason": "his PR"},
        {"github_login": "amd", "relevance": "none", "evidence_prs": [61343], "reason": ""},
        {"github_login": "stranger", "relevance": "high", "evidence_prs": [], "reason": ""},
    ]}, TASK, PROFILES)
    by = {j.maintainer: j for j in out}
    assert by["gau"].evidence_prs == [61343] and by["amd"].evidence_prs == []
    assert set(by) == {"gau", "amd"}


def test_a_skipped_maintainer_is_an_error() -> None:
    with pytest.raises(ExtractionError):
        parse_judgments({"judgments": [{"github_login": "gau", "relevance": "low",
                                        "evidence_prs": [], "reason": ""}]}, TASK, PROFILES)


def ctx(relevance: dict[str, Any], *, band: str = "route", fresh: bool = True, hardware: list[str] | None = None) -> RoutingContext:
    return RoutingContext(item_key="r#1", kind="issue", title="t", score=80 if band == "page" else 50,
                          band=band, facets={"type": "bug", "hardware": hardware or []},  # type: ignore[arg-type]
                          prepass={}, files=[], relevance=relevance, fresh=fresh)


def test_relevance_routes_without_any_rules_and_low_never_does() -> None:
    people = [Maintainer(github_login="gau"), Maintainer(github_login="amd")]
    owners = choose_owners(ctx({"gau": {"relevance": "high", "evidence_prs": [61343]},
                                "amd": {"relevance": "low"}}), people, load={}, excluded=set(), today=date(2026, 11, 12))
    assert [(o.maintainer.github_login, o.reasons) for o in owners] == [("gau", ["relevance:high (like #61343)"])]
    assert choose_owners(ctx({"gau": {"relevance": "low"}, "amd": {"relevance": "none"}}), people,
                         load={}, excluded=set(), today=date(2026, 11, 12)) == []


def test_high_beats_medium_beats_rules_and_exclude_blocks_relevance() -> None:
    rule_only = Maintainer(github_login="rules", rules={"areas": [], "hardware": ["B200"]})
    medium = Maintainer(github_login="medium")
    high_but_excluded = Maintainer(github_login="nvidia", rules={"exclude": {"hardware": ["B200"]}})
    owners = choose_owners(
        ctx({"medium": {"relevance": "medium"}, "nvidia": {"relevance": "high"}}, band="page", hardware=["B200"]),
        [rule_only, medium, high_but_excluded], load={}, excluded=set(), today=date(2026, 11, 12))
    assert [o.maintainer.github_login for o in owners] == ["medium"]  # backups must be clear matches


def test_strong_only_pass_and_strong_backups() -> None:
    people = [Maintainer(github_login="a"), Maintainer(github_login="b"), Maintainer(github_login="c")]
    judged = {"a": {"relevance": "medium"}, "b": {"relevance": "high"}, "c": {"relevance": "high"}}
    strong = choose_owners(ctx(judged, band="page"), people, load={}, excluded=set(),
                           today=date(2026, 11, 12), strong_only=True)
    assert [o.maintainer.github_login for o in strong] == ["b", "c"]
    only_medium = {"a": {"relevance": "medium"}}
    assert choose_owners(ctx(only_medium, band="page"), people, load={}, excluded=set(),
                         today=date(2026, 11, 12), strong_only=True) == []
    owners = choose_owners(ctx(only_medium, band="page"), people, load={}, excluded=set(), today=date(2026, 11, 12))
    assert [(o.maintainer.github_login, o.strong) for o in owners] == [("a", False)]


def test_backlog_page_items_respect_capacity_unless_fresh_or_a_clear_match() -> None:
    m = Maintainer(github_login="gau", capacity_per_week=2)
    medium, high = {"gau": {"relevance": "medium"}}, {"gau": {"relevance": "high"}}
    full = {"gau": 2}
    today = date(2026, 11, 12)
    assert choose_owners(ctx(medium, band="page", fresh=False), [m], load=full, excluded=set(), today=today) == []
    assert len(choose_owners(ctx(medium, band="page", fresh=True), [m], load=full, excluded=set(), today=today)) == 1
    assert len(choose_owners(ctx(high, band="page", fresh=False), [m], load=full, excluded=set(), today=today)) == 1
