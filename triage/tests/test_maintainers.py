"""triage/config/maintainers.yaml validation."""

from __future__ import annotations

from pathlib import Path

import pytest

from triage.maintainers import MaintainersFileError, main, parse_maintainers

REAL_FILE = Path(__file__).resolve().parents[1] / "config" / "maintainers.yaml"


def test_the_checked_in_file_is_valid() -> None:
    assert main(["check", str(REAL_FILE)]) == 0
    logins = [m.github_login for m in parse_maintainers(REAL_FILE.read_text())]
    assert "gau-nernst" in logins


def test_every_problem_is_reported_at_once() -> None:
    text = """
maintainers:
  - github_login: a
    min_score: 500
    colour: blue
    rules: {areas: [moe, made-up], hardware: [H9000], types: [urgent]}
  - github_login: a
    rules: {types: [bug]}
  - github_login: "not a login!"
"""
    with pytest.raises(MaintainersFileError) as exc:
        parse_maintainers(text)
    problems = "\n".join(exc.value.problems)
    for expected in ("min_score", "unknown key `colour`", "made-up", "H9000", "urgent",
                     "listed twice", "needs at least one of", "github_login"):
        assert expected in problems


def test_away_dates_and_defaults() -> None:
    [m] = parse_maintainers("""
maintainers:
  - github_login: x
    away: [{start: 2026-12-20, end: 2027-01-03}]
    rules: {models: ["Qwen3*"]}
""")
    assert m.away == [{"start": "2026-12-20", "end": "2027-01-03"}]
    assert m.rules["models"] == ["qwen3*"]
    assert (m.min_score, m.capacity_per_week, m.notify_mode, m.active) == (40, 10, "digest", True)
    with pytest.raises(MaintainersFileError):
        parse_maintainers("maintainers:\n  - github_login: x\n    away: [{start: 2027-01-03, end: 2026-12-20}]\n"
                          "    rules: {areas: [moe]}\n")


def test_not_yaml() -> None:
    with pytest.raises(MaintainersFileError):
        parse_maintainers("maintainers: [")
