"""Incident eligibility, narrow backend reach, and non-additive fix priority."""
from copy import deepcopy

import pytest

from triage.config import default_config
from triage.scoring import score_item


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


def test_cpu_deepseek_incident_and_fix_no_longer_page():
    cpu = defect(hardware=["CPU_x86"], areas=["cpu", "attention"])
    incident = score(cpu)
    assert (incident.score, incident.band) == (52, "route")
    fix = score({**cpu, "pr": {"fixes_issues": [65364], "has_tests": True,
                              "hot_path": True, "size": "s"}},
                kind="pr", linked_issue_scores={65364: incident.score})
    assert (fix.score, fix.band) == (52, "route")
    assert [f.factor for f in fix.breakdown] == ["pr.fixes_issue"]


@pytest.mark.parametrize("changes", [
    {"has_repro": False}, {"confidence": 0.5}, {"versions": {}},
    {"default_config": False}, {"default_config": None},
    {"hardware": []}, {"models": []}, {"severity": {"crash": True}},
    {"type": "feature"},
])
def test_popularity_cannot_replace_incident_evidence(changes):
    result = score(defect(**changes), reactions=1000)
    assert result.band != "page"
    assert result.score < 70


def test_clear_primary_serving_regression_pages():
    assert score(defect()).band == "page"


def test_cpu_cannot_page_through_social_points():
    result = score(defect(hardware=["CPU_arm"], areas=["cpu"]), reactions=1000)
    assert result.band == "route"


def test_shared_frontend_cpu_reproduction_is_not_cpu_backend_only():
    result = score(defect(hardware=["CPU_x86"], areas=["frontend_api"]), reactions=1000)
    assert result.band == "page"
    assert "hw tier2" in result.breakdown[0].detail


def test_multi_backend_issue_not_restricted_to_cpu():
    assert score(defect(hardware=["CPU_x86", "H100"], areas=["cpu", "attention"])).band == "page"


def test_security_exception_does_not_discount_cpu_or_exotic_config():
    result = score(defect(hardware=["CPU_arm"], areas=["cpu"], default_config=False,
                          severity={"security": True}), reactions=1000)
    assert result.band == "page"
    assert result.breakdown[0].points == 50


def test_cap_has_explanation_and_preserves_score_sum():
    result = score(defect(has_repro=False), reactions=1000)
    assert (result.score, result.band) == (69, "route")
    assert result.breakdown[-1].factor == "policy.p0_cap"
    assert "reproduction" in result.breakdown[-1].detail


def test_ready_fix_of_p1_does_not_become_p0():
    f = defect(pr={"fixes_issues": [1], "has_tests": True, "hot_path": True, "size": "xs"})
    result = score(f, kind="pr", reactions=1000, linked_issue_scores={1: 69})
    assert (result.score, result.band) == (69, "route")
    assert score(f, kind="pr", draft=True, linked_issue_scores={1: 80}).score == 65


def test_tests_small_size_and_hot_path_do_not_raise_standalone_impact():
    f = defect(pr={"size": "m"})
    plain = score(f, kind="pr")
    ready = deepcopy(f)
    ready["pr"] = {"size": "xs", "hot_path": True, "has_tests": True}
    assert score(ready, kind="pr").score == plain.score
