"""Deterministic impact score from prepass signals and LLM facets.

The model never sets the score. It extracts facts; this module turns them
into points using triage/config/scoring.yaml and tiers.yaml, and returns a
breakdown whose points sum to the score, so every number on the dashboard
can be explained and every weight can be tuned without new LLM calls.
"""

from __future__ import annotations

from collections.abc import Mapping
from fnmatch import fnmatch
from typing import Any

from triage.config import TriageConfig
from triage.model import Band, Score, ScoreFactor

_BANDS: tuple[Band, ...] = ("page", "route", "watch")


def model_tier(facets: Mapping[str, Any], tiers: Mapping[str, Any]) -> tuple[str, str | None]:
    """Best tier among the item's models, and the model that earned it."""
    names: list[str] = []
    for model in facets.get("models") or []:
        names.extend(n.lower() for n in (model.get("name"), model.get("family")) if n)
    for tier in ("tier1", "tier2"):
        for pattern in tiers["models"].get(tier) or []:
            for name in names:
                if fnmatch(name, pattern.lower()):
                    return tier, name
    return "other", None


def hardware_tier(hardware: list[str], tiers: Mapping[str, Any]) -> tuple[str, str | None]:
    for tier in ("tier1", "tier2"):
        listed = set(tiers["hardware"].get(tier) or [])
        for hw in hardware:
            if hw in listed:
                return tier, hw
    return "other", hardware[0] if hardware else None


def band_for(score: int, thresholds: Mapping[str, int]) -> Band:
    for band in _BANDS:
        if score >= thresholds[band]:
            return band
    return "ignore"


def score_item(
    *,
    kind: str,
    draft: bool,
    reactions: int,
    comment_count: int,
    prepass: Mapping[str, Any],
    facets: Mapping[str, Any] | None,
    config: TriageConfig,
    linked_issue_scores: Mapping[int, int] | None = None,
) -> Score:
    """Score one item. Without facets (not yet extracted) only prepass counts."""
    weights = config.scoring
    factors: list[ScoreFactor] = []

    def add(factor: str, points: float, detail: str | None = None) -> None:
        rounded = int(round(points))
        if rounded:
            factors.append(ScoreFactor(factor, rounded, detail))

    if facets is None:
        add("pending_extraction", 0)
        # Social signals still count so a pile-on is visible before the LLM runs.
        _social(add, reactions, comment_count, weights["social"])
        return _finish(factors, config)

    severity = facets.get("severity") or {}
    sev_w = weights["severity"]
    item_type = facets.get("type")
    # Severity is about defects. An RFC or feature request that mentions
    # wrong output elsewhere is not itself an incident (PRs: always counted,
    # since a fix PR is typed by what it fixes).
    if kind == "issue" and item_type not in sev_w["defect_types"]:
        severity = {}
    candidates: list[tuple[str, float, str | None]] = []
    for flag in ("serving_broken", "wrong_output", "crash", "hang", "security", "memory_regression"):
        if severity.get(flag):
            candidates.append((f"severity.{flag}", sev_w[flag], None))
    pct = severity.get("perf_regression_pct")
    if isinstance(pct, (int, float)) and pct > 0:
        points = min(sev_w["perf_regression_cap"], sev_w["perf_regression_per_10pct"] * pct / 10)
        candidates.append(("severity.perf_regression", points, f"{pct:g}% slower"))

    tier, model = model_tier(facets, config.tiers)
    hw = list(facets.get("hardware") or []) or list(prepass.get("hardware_hints") or [])
    hw_tier, hw_name = hardware_tier(hw, config.tiers) if hw else ("unknown", None)
    default_config = facets.get("default_config")
    config_key = "default" if default_config is True else "exotic" if default_config is False else "unknown"

    if candidates:
        name, base, detail = max(candidates, key=lambda c: c[1])
        reach = weights["reach"]
        model_key = tier if model else "unknown"
        multiplier = reach["model"][model_key] * reach["hardware"][hw_tier] * reach["config"][config_key]
        if name == "severity.security":
            multiplier = 1.0  # a vulnerability's reach is not about the model or GPU
        if kind == "pr":
            multiplier *= sev_w["pr_fraction"]
        parts = [] if name == "severity.security" else [
            f"model {model_key} x{reach['model'][model_key]:g}",
            f"hw {hw_tier} x{reach['hardware'][hw_tier]:g}",
            f"config {config_key} x{reach['config'][config_key]:g}",
        ]
        if kind == "pr":
            parts.append(f"pr x{sev_w['pr_fraction']:g}")
        add(name, base * multiplier, "; ".join(filter(None, [detail, f"{base:g} base", *parts])))

    add(f"type.{item_type}", weights["type"].get(item_type, 0))
    if item_type == "spam":
        return _finish(factors, config, band="ignore")

    popularity = weights["popularity"]
    add(f"popularity.model.{tier}", popularity["model"][tier], model)
    if hw_tier in popularity["hardware"]:
        add(f"popularity.hardware.{hw_tier}", popularity["hardware"][hw_tier], hw_name)

    versions = facets.get("versions") or {}
    if versions.get("affects_latest_release"):
        add("recency.affects_latest_release", weights["recency"]["affects_latest_release"], versions.get("bad"))
    elif versions.get("affects_main"):
        add("recency.affects_main", weights["recency"]["affects_main"])

    evidence = weights["evidence"]
    if facets.get("has_repro"):
        add("evidence.has_repro", evidence["has_repro"])
    if float(facets.get("confidence") or 0) < 0.4:
        add("evidence.low_confidence", evidence["low_confidence"])

    _social(add, reactions, comment_count, weights["social"])

    if kind == "pr":
        pr_w = weights["pr"]
        pr = facets.get("pr") or {}
        fixes = set(pr.get("fixes_issues") or []) | set(prepass.get("linked_issues") or [])
        best = max(
            ((n, s) for n, s in (linked_issue_scores or {}).items() if n in fixes),
            key=lambda pair: pair[1],
            default=None,
        )
        if best is not None:
            add("pr.fixes_issue", best[1] * pr_w["fixes_issue_fraction"], f"#{best[0]} scored {best[1]}")
        if pr.get("hot_path"):
            add("pr.hot_path", pr_w["hot_path"])
        if pr.get("has_tests"):
            add("pr.has_tests", pr_w["has_tests"])
        if pr.get("size"):
            add(f"pr.size.{pr['size']}", pr_w["size"].get(pr["size"], 0))
        if pr.get("low_effort"):
            add("pr.low_effort", pr_w["low_effort"])
        if draft:
            add("pr.draft", pr_w["draft"])

    signals = list(facets.get("slop_signals") or [])
    if signals:
        slop_w = weights["slop"]
        add("slop", max(slop_w["cap"], slop_w["per_signal"] * len(signals)), ", ".join(signals[:4]))

    return _finish(factors, config)


def _finish(factors: list[ScoreFactor], config: TriageConfig, band: Band | None = None) -> Score:
    """Clamp at zero with an explicit `floor` factor so points always sum to the score."""
    raw = sum(f.points for f in factors)
    if raw < 0:
        factors.append(ScoreFactor("floor", -raw))
    total = max(0, raw)
    return Score(
        total,
        band or band_for(total, config.scoring["thresholds"]),
        tuple(factors),
        config.version,
    )


def _social(add: Any, reactions: int, comment_count: int, weights: Mapping[str, Any]) -> None:
    points = reactions * weights["per_reaction"] + comment_count * weights["per_comment"]
    if points >= 1:
        add(
            "social",
            min(weights["cap"], points),
            f"{reactions} reactions, {comment_count} comments",
        )
