"""triage/config/maintainers/<login>.yaml validation."""

from __future__ import annotations

import pytest

from triage.maintainers import LOCAL_DIR, MaintainersFileError, load_local_dir, main, parse_maintainer_files


def test_the_checked_in_files_are_valid() -> None:
    assert main(["check", str(LOCAL_DIR)]) == 0
    logins = [m.github_login for m in parse_maintainer_files(load_local_dir())]
    assert "gau-nernst" in logins


def test_every_problem_is_reported_at_once() -> None:
    files = {
        "a.yaml": """
github_login: a
min_score: 500
colour: blue
rules: {areas: [moe, made-up], hardware: [H9000], types: [urgent]}
""",
        "b.yaml": "github_login: c\nrules: {types: [bug]}\nnotes: 7\n",
        "d.yaml": "- github_login: d\n",
        "e.yaml": "github_login: [",
    }
    with pytest.raises(MaintainersFileError) as exc:
        parse_maintainer_files(files)
    problems = "\n".join(exc.value.problems)
    for expected in ("min_score", "unknown key `colour`", "made-up", "H9000", "urgent",
                     "file name must be <github_login>.yaml",
                     "d.yaml: must be a single mapping", "e.yaml: not valid YAML", "notes: must be text"):
        assert expected in problems, expected


def test_away_dates_and_defaults() -> None:
    [m] = parse_maintainer_files({"x.yaml": """
github_login: x
away: [{start: 2026-12-20, end: 2027-01-03}]
rules: {models: ["Qwen3*"]}
"""})
    assert m.away == [{"start": "2026-12-20", "end": "2027-01-03"}]
    assert m.rules["models"] == ["qwen3*"]
    assert (m.min_score, m.capacity_per_week, m.notify_mode, m.active) == (40, 10, "digest", True)
    with pytest.raises(MaintainersFileError):
        parse_maintainer_files({"x.yaml": "github_login: x\naway: [{start: 2027-01-03, end: 2026-12-20}]\n"
                                          "rules: {areas: [moe]}\n"})


def test_file_name_is_case_insensitive_like_github() -> None:
    [m] = parse_maintainer_files({"Gau-Nernst.yaml": "github_login: gau-nernst\nrules: {areas: [moe]}\n"})
    assert m.github_login == "gau-nernst"


def test_notes_alone_are_enough_and_merge_with_natural_language() -> None:
    [m] = parse_maintainer_files({"x.yaml": "github_login: x\nnotes: |\n  I own the scheduler.\n"
                                            "rules: {natural_language: no TPU please}\n"})
    assert m.rules["natural_language"] == "I own the scheduler.\n\nno TPU please"
    assert not any(m.rules[k] for k in ("areas", "hardware", "models", "paths", "keywords"))
