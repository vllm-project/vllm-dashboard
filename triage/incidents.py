"""Evidence-based incident policy, independent of hardware and queue ranking."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

INCIDENT_ENUMS = {
    "impact": ("outage", "material_wrong_results", "serious_security", "service_unusable",
               "distribution_blocked", "limited", "unknown"),
    "exposure": ("broad_supported", "critical_deployment", "limited", "unknown"),
    "affected_context": ("supported_release", "production_deployment", "main_only", "unknown"),
    "verification": ("reproduced", "maintainer_confirmed", "security_advisory", "unverified", "unknown"),
    "mitigation": ("none", "unacceptable", "available", "unknown"),
    "status": ("active", "mitigated", "resolved", "unknown"),
}
EVIDENCE_KEYS = ("impact", "exposure", "current", "verification", "mitigation")
CRITICAL_IMPACTS = frozenset(INCIDENT_ENUMS["impact"][:-2])
INCIDENT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": [*INCIDENT_ENUMS, "release_blocker", "reason", "evidence"],
    "properties": {
        **{k: {"type": "string", "enum": list(v)} for k, v in INCIDENT_ENUMS.items()},
        "release_blocker": {"type": ["boolean", "null"]},
        "reason": {"type": "string", "maxLength": 500},
        "evidence": {
            "type": "object", "additionalProperties": False, "required": list(EVIDENCE_KEYS),
            "properties": {k: {"type": "string", "maxLength": 1000} for k in EVIDENCE_KEYS},
        },
    },
}


def normalize_incident(raw: Any, *, source: str | None = None) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    result: dict[str, Any] = {
        k: raw.get(k) if raw.get(k) in choices else "unknown"
        for k, choices in INCIDENT_ENUMS.items()
    }
    result["release_blocker"] = raw.get("release_blocker") if isinstance(raw.get("release_blocker"), bool) else None
    result["reason"] = raw.get("reason", "")[:500] if isinstance(raw.get("reason"), str) else ""
    evidence = raw.get("evidence") if isinstance(raw.get("evidence"), dict) else {}
    # Evidence must be quoted from supplied material, not generated support.
    # Whitespace may change in excerpts; do not allow paraphrases or omissions.
    normalized_source = " ".join(source.split()) if source is not None else None
    result["evidence"] = {}
    for key in EVIDENCE_KEYS:
        quote = evidence.get(key, "")
        quote = quote.strip()[:1000] if isinstance(quote, str) else ""
        if normalized_source is not None and " ".join(quote.split()) not in normalized_source:
            quote = ""
        result["evidence"][key] = quote
    return result


def p0_ineligibility(facets: Mapping[str, Any]) -> str | None:
    """None means interrupt-level impact is supported by all five evidence fields.

    These are extracted report claims, not verification performed by the bot.
    Unknowns do not become evidence through popularity or extraction confidence.
    """
    if facets.get("type") not in ("bug", "regression", "perf_regression", "performance", "ci"):
        return "P0 requires a defect, not a feature or question"
    incident = normalize_incident(facets.get("incident"))
    if incident["impact"] not in CRITICAL_IMPACTS:
        return "P0 requires critical service, correctness, security, or distribution impact"
    if incident["status"] != "active":
        return "P0 requires an active incident; acknowledgment alone is not mitigation"
    if incident["affected_context"] not in ("supported_release", "production_deployment"):
        return "P0 requires affected users on a supported release or production deployment; main-only is a release concern"
    if incident["exposure"] not in ("broad_supported", "critical_deployment"):
        return "P0 requires broad supported-path impact or an identified critical deployment"
    verification = incident["verification"]
    if verification not in ("reproduced", "maintainer_confirmed", "security_advisory"):
        return "P0 requires concrete failure evidence or confirmation, not just a reproduction command"
    if verification == "security_advisory" and incident["impact"] != "serious_security":
        return "A security advisory cannot establish an unrelated service incident"
    if incident["mitigation"] not in ("none", "unacceptable"):
        return "P0 requires evidence that a safe, practical mitigation is unavailable or inadequate"
    missing = [key for key in EVIDENCE_KEYS if not incident["evidence"][key]]
    if missing:
        return "P0 evidence missing: " + ", ".join(missing)
    return None


def needs_verification(facets: Mapping[str, Any]) -> bool:
    incident = normalize_incident(facets.get("incident"))
    severe = incident["impact"] in CRITICAL_IMPACTS or (facets.get("severity") or {}).get("security")
    return bool(facets.get("type") in ("bug", "regression", "perf_regression", "performance", "ci")
                and severe and incident["status"] not in ("mitigated", "resolved"))
