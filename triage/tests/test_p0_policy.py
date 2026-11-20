"""Critical incident evidence, backend neutrality, and fix inheritance."""
from copy import deepcopy

import pytest

from triage.config import default_config
from triage.facets import normalize_facets
from triage.incidents import CRITICAL_IMPACTS, EVIDENCE_KEYS, normalize_incident
from triage.scoring import score_item

from triage.tests.incident_fixture import INCIDENT, REPORT


def defect(**changes):
    result = dict(type="regression", models=[{"name": "DeepSeek-V4", "family": "deepseek"}],
                  hardware=["H100"], areas=["attention"], default_config=True,
                  severity={"serving_broken": True}, has_repro=True, confidence=0.9,
                  versions={"affects_latest_release": True})
    result.update(changes)
    return result


def score(facets, **changes):
    args = dict(kind="issue", draft=False, reactions=0, comment_count=0, prepass={},
                facets=facets, config=default_config())
    args.update(changes)
    result = score_item(**args)
    assert result.score == sum(f.points for f in result.breakdown)
    return result


@pytest.mark.parametrize("hardware", [["CPU_x86"], ["CPU_arm"], ["A100"], ["H100"], ["MI300X"], ["TPU"], []])
@pytest.mark.parametrize("default_config", [True, False, None])
def test_all_backends_and_supported_configurations_use_the_same_incident_gate(hardware, default_config):
    result = score(defect(hardware=hardware, default_config=default_config,
                          models=[], incident=INCIDENT))
    assert result.band == "page"
    assert result.breakdown[-1].factor == "policy.p0_incident"


@pytest.mark.parametrize("impact", sorted(CRITICAL_IMPACTS))
def test_outages_correctness_security_unusable_service_and_distribution_can_page(impact):
    # No old severity flag, popularity, latest-release boolean or repro bonus is required.
    result = score(defect(severity={}, has_repro=False, versions={}, models=[], hardware=[],
                          incident={**INCIDENT, "impact": impact}))
    assert (result.score, result.band) == (70, "page")


@pytest.mark.parametrize("changes", [
    {"exposure": "limited"}, {"exposure": "unknown"}, {"impact": "limited"},
    {"affected_context": "main_only", "release_blocker": True}, {"affected_context": "unknown"},
    {"verification": "unverified"}, {"verification": "unknown"},
    {"mitigation": "available"}, {"mitigation": "unknown"},
    {"status": "mitigated"}, {"status": "resolved"}, {"status": "unknown"},
])
def test_each_missing_criterion_prevents_p0_even_with_popularity(changes):
    result = score(defect(incident={**INCIDENT, **changes}), reactions=1000)
    assert result.band == "route"
    assert result.score == 69


@pytest.mark.parametrize("key", EVIDENCE_KEYS)
def test_each_criterion_requires_an_excerpt(key):
    incident = deepcopy(INCIDENT)
    incident["evidence"][key] = ""
    result = score(defect(incident=incident))
    assert result.band == "route"
    assert key in result.breakdown[-1].detail


def test_legacy_popular_default_repro_is_insufficient():
    result = score(defect(), reactions=1000)
    assert (result.score, result.band) == (69, "route")
    assert result.breakdown[-1].factor == "policy.p0_cap"


def test_uncertain_serious_report_stays_in_review_queue():
    result = score(defect(models=[], hardware=[], severity={}, versions={}, has_repro=False,
                          incident={**INCIDENT, "mitigation": "unknown"}))
    assert (result.score, result.band) == (40, "route")
    assert result.breakdown[-1].factor == "policy.needs_verification"


def test_security_does_not_require_public_exploit_or_default_configuration():
    result = score(defect(has_repro=False, hardware=["CPU_arm"], default_config=False,
                          incident={**INCIDENT, "impact": "serious_security", "verification": "security_advisory"}))
    assert result.band == "page"


def test_security_advisory_does_not_prove_nonsecurity_outage():
    assert score(defect(incident={**INCIDENT, "verification": "security_advisory"})).band != "page"


@pytest.mark.parametrize("item_type", ["feature", "question", "spam"])
def test_conflicting_nondefect_classification_cannot_page(item_type):
    assert score(defect(type=item_type, incident=INCIDENT), reactions=1000).band != "page"


@pytest.mark.parametrize("draft", [True, False])
def test_fix_inherits_incident_without_readiness_quality_or_social_adjustments(draft):
    f = defect(pr={"fixes_issues": [1], "has_tests": True, "hot_path": True,
                   "size": "xl", "low_effort": True}, slop_signals=["no_testing"])
    for value in (52, 69, 80):
        result = score(f, kind="pr", draft=draft, reactions=1000, linked_issue_scores={1: value})
        assert result.score == value
        assert [f.factor for f in result.breakdown] == ["pr.fixes_issue"]


def test_related_issue_does_not_confer_incident_priority():
    result = score(defect(pr={}), kind="pr", prepass={"linked_issues": [1]}, linked_issue_scores={1: 95})
    assert result.band != "page"
    assert all(f.factor != "pr.fixes_issue" for f in result.breakdown)


def test_incident_normalization_rejects_unknown_enums_and_unquoted_evidence():
    valid = normalize_incident(INCIDENT, source=REPORT)
    assert valid == INCIDENT
    invalid = normalize_incident({**INCIDENT, "impact": "P0", "exposure": "lots", "evidence": {"impact": "invented"}}, source=REPORT)
    assert invalid["impact"] == invalid["exposure"] == "unknown"
    assert not any(invalid["evidence"].values())
    facets = normalize_facets(defect(incident=INCIDENT), kind="issue", source="A completely unrelated report")
    assert score(facets).band != "page"
