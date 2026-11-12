"""triage/config/maintainers.yaml: the source of truth for maintainer rules.

Maintainers change their rules by PR. The route consumer reads the copy on
`main` every run, validates it, and syncs it into triage_maintainers (rows it
owns carry updated_by='repo'). An invalid file is rejected as a whole and
the last good rules stay in place. CI runs `python -m triage.maintainers
check` on every PR that touches the file.
"""

from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import yaml

from triage.config import CONFIG_DIR
from triage.model import AREAS, HARDWARE, ITEM_TYPES, Maintainer

REPO_FILE = "triage/config/maintainers.yaml"
CONTENTS_URL = f"https://api.github.com/repos/vllm-project/vllm-dashboard/contents/{REPO_FILE}?ref=main"
REPO_OWNER = "repo"

_LOGIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_SLACK_USER = re.compile(r"^[UW][A-Z0-9]{6,}$")
_TOP_KEYS = {
    "github_login", "slack_user_id", "min_score", "capacity_per_week",
    "notify_mode", "away", "rules", "active",
}
_RULE_KEYS = {"areas", "hardware", "models", "paths", "keywords", "types", "exclude", "natural_language"}
_EXCLUDE_KEYS = {"types", "areas", "hardware"}


class MaintainersFileError(ValueError):
    """The file is unusable; every problem is listed."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("\n".join(problems))
        self.problems = problems


def _str_list(value: Any, where: str, problems: list[str], allowed: tuple[str, ...] | None = None) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        problems.append(f"{where}: must be a list of non-empty strings")
        return []
    if allowed is not None:
        unknown = [v for v in value if v not in allowed]
        if unknown:
            problems.append(f"{where}: unknown value(s) {unknown}; allowed: {', '.join(allowed)}")
    return [v.strip() for v in value]


def _date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    return None


def parse_maintainers(text: str) -> list[Maintainer]:
    """Validate the whole file; raise MaintainersFileError listing every problem."""
    problems: list[str] = []
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise MaintainersFileError([f"not valid YAML: {exc}"]) from exc
    if not isinstance(data, dict) or not isinstance(data.get("maintainers", []), list):
        raise MaintainersFileError(["top level must be a mapping with a `maintainers:` list"])

    out: list[Maintainer] = []
    seen: set[str] = set()
    for index, entry in enumerate(data.get("maintainers") or []):
        where = f"maintainers[{index}]"
        if not isinstance(entry, dict):
            problems.append(f"{where}: must be a mapping")
            continue
        login = entry.get("github_login")
        if not isinstance(login, str) or not _LOGIN.match(login):
            problems.append(f"{where}.github_login: must be a GitHub login")
            continue
        where = f"{login}"
        if login.lower() in seen:
            problems.append(f"{where}: listed twice")
        seen.add(login.lower())
        for key in set(entry) - _TOP_KEYS:
            problems.append(f"{where}: unknown key `{key}`")

        slack = entry.get("slack_user_id")
        if slack is not None and (not isinstance(slack, str) or not _SLACK_USER.match(slack)):
            problems.append(f"{where}.slack_user_id: must look like U0123456789")
        min_score = entry.get("min_score", 40)
        if not isinstance(min_score, int) or not 0 <= min_score <= 200:
            problems.append(f"{where}.min_score: must be an integer 0-200")
        capacity = entry.get("capacity_per_week", 10)
        if not isinstance(capacity, int) or not 1 <= capacity <= 100:
            problems.append(f"{where}.capacity_per_week: must be an integer 1-100")
        notify = entry.get("notify_mode", "digest")
        if notify not in ("immediate", "digest", "off"):
            problems.append(f"{where}.notify_mode: must be immediate, digest or off")
        active = entry.get("active", True)
        if not isinstance(active, bool):
            problems.append(f"{where}.active: must be true or false")

        away: list[dict[str, str]] = []
        for i, window in enumerate(entry.get("away") or []):
            start = _date(window.get("start")) if isinstance(window, dict) else None
            end = _date(window.get("end")) if isinstance(window, dict) else None
            if start is None or end is None or end < start:
                problems.append(f"{where}.away[{i}]: needs start and end dates (YYYY-MM-DD), end >= start")
            else:
                away.append({"start": start.isoformat(), "end": end.isoformat()})

        raw_rules = entry.get("rules") or {}
        if not isinstance(raw_rules, dict):
            problems.append(f"{where}.rules: must be a mapping")
            raw_rules = {}
        for key in set(raw_rules) - _RULE_KEYS:
            problems.append(f"{where}.rules: unknown key `{key}`")
        rules: dict[str, Any] = {
            "areas": _str_list(raw_rules.get("areas"), f"{where}.rules.areas", problems, AREAS),
            "hardware": _str_list(raw_rules.get("hardware"), f"{where}.rules.hardware", problems, HARDWARE),
            "models": [m.lower() for m in _str_list(raw_rules.get("models"), f"{where}.rules.models", problems)],
            "paths": _str_list(raw_rules.get("paths"), f"{where}.rules.paths", problems),
            "keywords": _str_list(raw_rules.get("keywords"), f"{where}.rules.keywords", problems),
            "types": _str_list(raw_rules.get("types"), f"{where}.rules.types", problems, ITEM_TYPES),
        }
        exclude = raw_rules.get("exclude") or {}
        if not isinstance(exclude, dict):
            problems.append(f"{where}.rules.exclude: must be a mapping")
            exclude = {}
        for key in set(exclude) - _EXCLUDE_KEYS:
            problems.append(f"{where}.rules.exclude: unknown key `{key}`")
        rules["exclude"] = {
            "types": _str_list(exclude.get("types"), f"{where}.rules.exclude.types", problems, ITEM_TYPES),
            "areas": _str_list(exclude.get("areas"), f"{where}.rules.exclude.areas", problems, AREAS),
            "hardware": _str_list(exclude.get("hardware"), f"{where}.rules.exclude.hardware", problems, HARDWARE),
        }
        natural = raw_rules.get("natural_language")
        if natural is not None and not isinstance(natural, str):
            problems.append(f"{where}.rules.natural_language: must be text")
        if natural:
            rules["natural_language"] = natural.strip()
        if not any(rules[k] for k in ("areas", "hardware", "models", "paths", "keywords")):
            problems.append(
                f"{where}.rules: needs at least one of areas, hardware, models, paths, keywords "
                "(types and exclude only narrow a match)"
            )
        out.append(Maintainer(
            github_login=login,
            slack_user_id=slack if isinstance(slack, str) else None,
            active=active if isinstance(active, bool) else True,
            rules=rules,
            min_score=min_score if isinstance(min_score, int) else 40,
            capacity_per_week=capacity if isinstance(capacity, int) else 10,
            away=away,
            notify_mode=notify if notify in ("immediate", "digest", "off") else "digest",
        ))
    if problems:
        raise MaintainersFileError(problems)
    return out


def fetch_main_copy(token: str | None, *, timeout: float = 15.0) -> tuple[str, str]:
    """The file on vllm-dashboard `main`, and where it came from.

    Tries the contents API with the worker's token, then anonymously (the
    repo is public), then falls back to the copy installed with the package.
    """
    for auth in ([token] if token else []) + [None]:
        headers = {"Accept": "application/vnd.github.raw+json", "User-Agent": "vllm-ci-triage"}
        if auth:
            headers["Authorization"] = f"Bearer {auth}"
        try:
            with urlopen(Request(CONTENTS_URL, headers=headers), timeout=timeout) as response:
                return response.read().decode(), "github:main"
        except (HTTPError, URLError, TimeoutError):
            continue
    return (CONFIG_DIR / "maintainers.yaml").read_text(), "packaged"


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 2 or args[0] != "check":
        print("usage: python -m triage.maintainers check <maintainers.yaml>", file=sys.stderr)
        return 2
    try:
        maintainers = parse_maintainers(Path(args[1]).read_text())
    except MaintainersFileError as exc:
        print(f"{args[1]} has {len(exc.problems)} problem(s):", file=sys.stderr)
        for problem in exc.problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print(f"{args[1]}: {len(maintainers)} maintainer(s) OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
