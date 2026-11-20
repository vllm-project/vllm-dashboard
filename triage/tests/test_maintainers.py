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


def test_timezone_and_digest_hour_are_validated_and_kept_in_rules() -> None:
    [m] = parse_maintainer_files({"x.yaml": "github_login: x\ntimezone: Asia/Ho_Chi_Minh\ndigest_hour: 7\n"})
    assert m.rules["timezone"] == "Asia/Ho_Chi_Minh" and m.rules["digest_hour"] == 7
    [plain] = parse_maintainer_files({"y.yaml": "github_login: y\n"})
    assert "timezone" not in plain.rules and "digest_hour" not in plain.rules
    with pytest.raises(MaintainersFileError) as exc:
        parse_maintainer_files({
            "a.yaml": "github_login: a\ntimezone: Mars/Olympus_Mons\n",
            "b.yaml": "github_login: b\ntimezone: UTC+7\n",
            "c.yaml": "github_login: c\ntimezone: ../../etc/passwd\n",
            "d.yaml": "github_login: d\ndigest_hour: 24\n",
            "e.yaml": "github_login: e\ndigest_hour: true\n",
            "f.yaml": "github_login: f\ndigest_hour: '9'\n",
            "g.yaml": "github_login: g\ntimezone: 7\n",
        })
    assert len(exc.value.problems) == 7
    assert "a.timezone: must be an IANA time zone name like Europe/London" in exc.value.problems


def test_max_notifications_per_day_validation() -> None:
    [m] = parse_maintainer_files({"x.yaml": "github_login: x\nmax_notifications_per_day: 5\n"})
    assert m.rules["max_notifications_per_day"] == 5
    [zero] = parse_maintainer_files({"z.yaml": "github_login: z\nmax_notifications_per_day: 0\n"})
    assert zero.rules["max_notifications_per_day"] == 0
    with pytest.raises(MaintainersFileError) as exc:
        parse_maintainer_files({
            "a.yaml": "github_login: a\nmax_notifications_per_day: -1\n",
            "b.yaml": "github_login: b\nmax_notifications_per_day: 51\n",
            "c.yaml": "github_login: c\nmax_notifications_per_day: true\n",
        })
    assert len(exc.value.problems) == 3


def test_checked_in_time_zones() -> None:
    zones = {m.github_login: m.rules.get("timezone") for m in parse_maintainer_files(load_local_dir(LOCAL_DIR))}
    assert zones["gau-nernst"] == "Asia/Ho_Chi_Minh" and zones["khluu"] == "America/Los_Angeles"
    assert zones["hmellor"] == zones["markmc"] == "Europe/London"
    assert zones["robertgshaw2-redhat"] == zones["mgoin"] == zones["MatthewBonanni"] == "America/New_York"
    assert zones["njhill"] == "America/Los_Angeles" and zones["jperezdealgaba"] == "Europe/Amsterdam"
