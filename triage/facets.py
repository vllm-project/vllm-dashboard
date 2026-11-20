"""The structured facets the LLM extracts, their JSON schema, and validation.

The schema is passed to the model as a structured-output constraint, and
`normalize_facets` re-validates whatever comes back: the model reads
untrusted public text, so its output is untrusted too. Unknown enum values
are dropped rather than trusted, and free text is length-capped.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from triage.incidents import INCIDENT_SCHEMA, normalize_incident
from triage.model import AREAS, HARDWARE, ITEM_TYPES, MODEL_TRAITS, SERVING

PROMPT_VERSION = "v2-incident-evidence"

_STR = {"type": "string"}
_BOOL = {"type": "boolean"}
_NULLABLE_BOOL = {"type": ["boolean", "null"]}


def _enum_list(values: tuple[str, ...]) -> dict[str, Any]:
    return {"type": "array", "items": {"type": "string", "enum": list(values)}}


FACETS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "type", "summary", "models", "model_traits", "hardware", "serving",
        "areas", "severity", "default_config", "versions", "has_repro", "pr",
        "slop_signals", "confidence", "notes", "incident",
    ],
    "properties": {
        "incident": INCIDENT_SCHEMA,
        "type": {"type": "string", "enum": list(ITEM_TYPES)},
        "summary": {"type": "string", "maxLength": 240},
        "models": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name", "family"],
                "properties": {"name": _STR, "family": _STR},
            },
        },
        "model_traits": _enum_list(MODEL_TRAITS),
        "hardware": _enum_list(HARDWARE),
        "serving": _enum_list(SERVING),
        "areas": _enum_list(AREAS),
        "severity": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "serving_broken", "crash", "wrong_output", "hang",
                "perf_regression_pct", "memory_regression", "security",
            ],
            "properties": {
                "serving_broken": _BOOL,
                "crash": _BOOL,
                "wrong_output": _BOOL,
                "hang": _BOOL,
                "perf_regression_pct": {"type": ["number", "null"]},
                "memory_regression": _BOOL,
                "security": _BOOL,
            },
        },
        "default_config": _NULLABLE_BOOL,
        "versions": {
            "type": "object",
            "additionalProperties": False,
            "required": ["good", "bad", "affects_main", "affects_latest_release"],
            "properties": {
                "good": {"type": ["string", "null"]},
                "bad": {"type": ["string", "null"]},
                "affects_main": _NULLABLE_BOOL,
                "affects_latest_release": _NULLABLE_BOOL,
            },
        },
        "has_repro": _BOOL,
        "pr": {
            "anyOf": [
                {"type": "null"},
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["fixes_issues", "hot_path", "size", "has_tests", "low_effort"],
                    "properties": {
                        "fixes_issues": {"type": "array", "items": {"type": "integer"}},
                        "hot_path": _BOOL,
                        "size": {"type": "string", "enum": ["xs", "s", "m", "l", "xl"]},
                        "has_tests": _BOOL,
                        "low_effort": _BOOL,
                    },
                },
            ]
        },
        "slop_signals": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "notes": {"type": "string", "maxLength": 500},
    },
}


class FacetsError(ValueError):
    """The model output cannot be used as facets."""


def _bool(value: Any) -> bool:
    return value is True


def _nullable_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _version(value: Any) -> str | None:
    text = _text(value, 40)
    return text or None


def _enum_values(value: Any, allowed: tuple[str, ...]) -> list[str]:
    if not isinstance(value, list):
        return []
    seen: dict[str, None] = {}
    for entry in value:
        if isinstance(entry, str) and entry in allowed:
            seen.setdefault(entry, None)
    return list(seen)


def normalize_facets(raw: Any, *, kind: str, source: str | None = None) -> dict[str, Any]:
    """Validate and canonicalise model output; raise FacetsError if unusable."""
    if not isinstance(raw, dict):
        raise FacetsError("facets must be an object")
    item_type = raw.get("type")
    if item_type not in ITEM_TYPES:
        raise FacetsError(f"unknown type: {item_type!r}")

    models: list[dict[str, str]] = []
    for entry in raw.get("models") or []:
        if isinstance(entry, dict):
            name = _text(entry.get("name"), 80)
            if name:
                models.append({"name": name, "family": _text(entry.get("family"), 40).lower()})
    severity_raw: dict[str, Any] = raw["severity"] if isinstance(raw.get("severity"), dict) else {}
    pct = severity_raw.get("perf_regression_pct")
    perf_pct = float(pct) if isinstance(pct, (int, float)) and 0 < pct <= 1000 else None
    versions_raw: dict[str, Any] = raw["versions"] if isinstance(raw.get("versions"), dict) else {}

    pr: dict[str, Any] | None = None
    if kind == "pr" and isinstance(raw.get("pr"), dict):
        pr_raw = raw["pr"]
        size = pr_raw.get("size")
        pr = {
            "fixes_issues": sorted(
                {n for n in pr_raw.get("fixes_issues") or [] if isinstance(n, int) and n > 0}
            )[:10],
            "hot_path": _bool(pr_raw.get("hot_path")),
            "size": size if size in ("xs", "s", "m", "l", "xl") else "m",
            "has_tests": _bool(pr_raw.get("has_tests")),
            "low_effort": _bool(pr_raw.get("low_effort")),
        }
    confidence = raw.get("confidence")
    return {
        "incident": normalize_incident(raw.get("incident"), source=source),
        "type": item_type,
        "summary": _text(raw.get("summary"), 240),
        "models": models[:8],
        "model_traits": _enum_values(raw.get("model_traits"), MODEL_TRAITS),
        "hardware": _enum_values(raw.get("hardware"), HARDWARE),
        "serving": _enum_values(raw.get("serving"), SERVING),
        "areas": _enum_values(raw.get("areas"), AREAS),
        "severity": {
            "serving_broken": _bool(severity_raw.get("serving_broken")),
            "crash": _bool(severity_raw.get("crash")),
            "wrong_output": _bool(severity_raw.get("wrong_output")),
            "hang": _bool(severity_raw.get("hang")),
            "perf_regression_pct": perf_pct,
            "memory_regression": _bool(severity_raw.get("memory_regression")),
            "security": _bool(severity_raw.get("security")),
        },
        "default_config": _nullable_bool(raw.get("default_config")),
        "versions": {
            "good": _version(versions_raw.get("good")),
            "bad": _version(versions_raw.get("bad")),
            "affects_main": _nullable_bool(versions_raw.get("affects_main")),
            "affects_latest_release": _nullable_bool(versions_raw.get("affects_latest_release")),
        },
        "has_repro": _bool(raw.get("has_repro")),
        "pr": pr,
        "slop_signals": [
            _text(s, 60) for s in (raw.get("slop_signals") or []) if isinstance(s, str)
        ][:6],
        "confidence": float(confidence)
        if isinstance(confidence, (int, float)) and 0 <= confidence <= 1
        else 0.5,
        "notes": _text(raw.get("notes"), 500),
    }


def routing_facets_fingerprint(facets: Mapping[str, Any] | None) -> str:
    """Canonical hash of the routing-relevant facets.

    Ignores phrasing drift in free-text `summary`/`notes` and `confidence` so
    re-extracting an item whose semantic classification (type, areas, hardware,
    models, serving, severity, fixes_issues) did not change doesn't invalidate
    existing relevance judgements.
    """
    f = facets or {}
    models = sorted(
        (str(m.get("name") or "").strip().lower(), str(m.get("family") or "").strip().lower())
        for m in (f.get("models") or [])
        if isinstance(m, dict) and (m.get("name") or m.get("family"))
    )
    raw_sev = f.get("severity")
    sev_raw: Mapping[str, Any] = raw_sev if isinstance(raw_sev, Mapping) else {}
    severity = {
        k: sev_raw.get(k)
        for k in ("serving_broken", "crash", "wrong_output", "hang", "perf_regression_pct",
                  "memory_regression", "security")
    }
    pr_raw = f.get("pr") if isinstance(f.get("pr"), Mapping) else None
    fixes = sorted(
        {int(n) for n in (pr_raw.get("fixes_issues") or []) if isinstance(n, int) and n > 0}
    ) if pr_raw else []
    payload = {
        "type": f.get("type"),
        "areas": sorted(set(str(a) for a in (f.get("areas") or []))),
        "hardware": sorted(set(str(h) for h in (f.get("hardware") or []))),
        "serving": sorted(set(str(s) for s in (f.get("serving") or []))),
        "model_traits": sorted(set(str(t) for t in (f.get("model_traits") or []))),
        "models": models,
        "severity": severity,
        "fixes_issues": fixes,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:24]
