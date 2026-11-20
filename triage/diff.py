"""Budgeted PR diff excerpt filtering and prioritization for Tier-1 extraction.

Turns a raw unified GitHub PR diff into a compact, high-signal excerpt capped
at `DIFF_LIMIT` characters:
  - Skips lockfiles, binaries, generated/minified files, and large data blobs.
  - Prioritizes core source code ahead of tests/benchmarks ahead of docs/config.
  - Truncates giant individual hunks so a single file cannot starve the rest.
"""

from __future__ import annotations

import re
from pathlib import PurePosixPath

DIFF_LIMIT = 8_000
DIFF_MAX_PER_FILE = 2_500
RAW_DIFF_READ_LIMIT = 256 * 1024

_DIFF_HEADER = re.compile(r"(?m)^diff --git a/(.+?) b/(.+?)$")
_LOCKFILES = frozenset({
    "uv.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "cargo.lock", "poetry.lock", "gemfile.lock", "go.sum", "composer.lock",
})
_SKIP_SUFFIXES = (
    ".min.js", ".min.css", ".snap", ".pb.go", "_pb2.py",
    ".svg", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf",
    ".woff", ".woff2", ".ttf", ".eot", ".pyc", ".so", ".whl",
)
_DATA_SUFFIXES = (".json", ".yaml", ".yml", ".csv", ".txt", ".xml")
_CODE_SUFFIXES = (
    ".py", ".cu", ".cuh", ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp",
    ".rs", ".ts", ".tsx", ".js", ".jsx", ".go", ".sh", ".cmake",
)


def _should_skip(path: str, section: str) -> bool:
    lower = path.lower()
    name = PurePosixPath(lower).name
    if name in _LOCKFILES:
        return True
    if any(lower.endswith(sfx) for sfx in _SKIP_SUFFIXES) or ".generated." in lower:
        return True
    if "Binary files " in section or "GIT binary patch" in section:
        return True
    if any(lower.endswith(sfx) for sfx in _DATA_SUFFIXES) and section.count("\n") > 250:
        return True
    return False


def _priority(path: str) -> int:
    """0 = core source code, 1 = tests/benchmarks/examples, 2 = docs/config/other."""
    lower = path.lower()
    parts = PurePosixPath(lower).parts
    name = PurePosixPath(lower).name
    is_test = (
        any(p in ("tests", "test", "benchmarks", "examples") for p in parts)
        or name.startswith("test_")
        or "_test." in name
        or ".test." in name
    )
    is_code = (
        any(lower.endswith(sfx) for sfx in _CODE_SUFFIXES)
        or name == "cmakelists.txt"
        or name.startswith("dockerfile")
    )
    if is_code and not is_test:
        return 0
    if is_test:
        return 1
    return 2


def _compact_section(section: str, max_per_file: int) -> str:
    # Drop `index abc..def 100644` noise lines to save tokens.
    lines = [line for line in section.splitlines() if not line.startswith("index ")]
    text = "\n".join(lines).strip()
    if len(text) > max_per_file:
        marker = "\n... [file truncated]"
        text = text[: max(0, max_per_file - len(marker))].rstrip() + marker
    return text


def format_diff_excerpt(
    raw_diff: str,
    *,
    max_chars: int = DIFF_LIMIT,
    max_per_file: int = DIFF_MAX_PER_FILE,
) -> str:
    """Filter, prioritize, and truncate a unified diff to at most `max_chars`."""
    if not raw_diff or not raw_diff.strip():
        return ""
    matches = list(_DIFF_HEADER.finditer(raw_diff))
    if not matches:
        return raw_diff.strip()[:max_chars]

    candidates: list[tuple[int, int, str]] = []
    skipped = 0
    for idx, match in enumerate(matches):
        start = match.start()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(raw_diff)
        section = raw_diff[start:end].strip()
        path = match.group(2) if match.group(2) != "/dev/null" else match.group(1)
        if _should_skip(path, section):
            skipped += 1
            continue
        candidates.append((_priority(path), idx, _compact_section(section, max_per_file)))

    if not candidates:
        return ""

    candidates.sort(key=lambda item: (item[0], item[1]))
    footer_reserve = 40
    budget = max(0, max_chars - footer_reserve)
    chosen: list[str] = []
    used = 0
    omitted = 0
    for _, _, chunk in candidates:
        sep = 2 if chosen else 0
        if used + sep + len(chunk) <= budget:
            chosen.append(chunk)
            used += sep + len(chunk)
        elif not chosen and budget > 30:
            marker = "\n... [diff truncated]"
            chosen.append(chunk[: max(0, budget - len(marker))].rstrip() + marker)
            used = len(chosen[0])
            omitted += 1
        else:
            omitted += 1

    out = "\n\n".join(chosen)
    if omitted or skipped:
        parts = []
        if omitted:
            parts.append(f"{omitted} more file(s) omitted")
        if skipped:
            parts.append(f"{skipped} noisy/binary file(s) skipped")
        footer = f"\n\n... [{'; '.join(parts)}]"
        if len(out) + len(footer) <= max_chars:
            out += footer
    return out[:max_chars]
