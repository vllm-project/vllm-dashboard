"""Digest presentation from observed state, including conservative CI/readiness."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any

from alerting.ports import DeliveryMode

from triage.notify import _compact_ci, maintainer_digest
from triage.store import DigestEntry

NOW = datetime(2026, 11, 20, tzinfo=timezone.utc)
ISSUE = DigestEntry(1, "vllm-project/vllm#68575", "Responses API loses history",
                    "https://github.com/vllm-project/vllm/issues/68575", 76, "page", "", [],
                    kind="issue", created_at=NOW - timedelta(hours=33), severity={"wrong_output": True})
FIX = DigestEntry(2, "vllm-project/vllm#68597", "Fix history",
                  "https://github.com/vllm-project/vllm/pull/68597", 100, "page", "", [], kind="pr",
                  fixes=(ISSUE.item_key,), prepass={"head_sha": "abc", "waiting_on": "reviewer"},
                  ci={"head_sha": "abc", "state": "passed"})


def render(entries: list[DigestEntry], lang: str = "en") -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = maintainer_digest(
        maintainer="r", maintainer_slack="U1", entries=entries,
        day=NOW, mode=DeliveryMode.SHADOW, lang=lang,
    ).payload["blocks"]
    return blocks


def test_title_and_number_destinations_state_and_age() -> None:
    for lang, symptom, age in [("en", "⚠️ wrong output", "33h"),
                               ("vi", "⚠️ kết quả sai", "33 giờ")]:
        item = next(b for b in render([ISSUE, FIX], lang) if "accessory" in b)
        lines = item["text"]["text"].split("\n")
        assert lines[0] == "• *<https://ci.vllm.ai/triage?item=vllm-project%2Fvllm%2368575|Responses API loses history>*"
        assert lines[1] == f"<https://github.com/vllm-project/vllm/issues/68575|#68575> · {symptom} · {age}"
        assert ("✅ CI passed" if lang == "en" else "✅ CI đạt") in lines[2]
        assert "View in triage" not in item["text"]["text"] and "↗" not in item["text"]["text"]


def test_ci_never_reports_a_result_from_another_commit() -> None:
    assert _compact_ci(FIX, "en") == "✅ CI passed"
    for state in ("failed", "running", "canceled", "not_started", "unknown"):
        assert _compact_ci(replace(FIX, ci={"head_sha": "abc", "state": state}), "en") == ""
    assert _compact_ci(replace(FIX, prepass={"head_sha": "new"}), "en") == ""
    assert _compact_ci(replace(FIX, prepass={}), "vi") == ""
    assert _compact_ci(replace(FIX, state="merged"), "en") == ""
    failed = replace(FIX, ci={"head_sha": "abc", "state": "failed", "jobs_failed": 2,
                             "jobs_failed_pr_only": 0, "main_known": True})
    assert _compact_ci(failed, "en") == ""
    assert _compact_ci(replace(failed, ci={**(failed.ci or {}), "main_known": False}), "en") == ""


def test_context_fixes_are_compact_bounded_and_do_not_change_priority() -> None:
    fixes = tuple(replace(FIX, item_key=f"vllm-project/vllm#{n}", html_url=f"https://github.com/vllm-project/vllm/pull/{n}",
                          state="merged" if n == 2 else "open", draft=n == 3) for n in range(2, 6))
    item = replace(ISSUE, band="route", score=50, related_fixes=fixes)
    blocks = render([item])
    assert "1 P1" in blocks[1]["text"]["text"] and "P0" not in str(blocks)
    text = next(b for b in blocks if "accessory" in b)["text"]["text"]
    lines = text.split("\n")
    assert len(lines) == 4
    assert lines[2].count("↳ Fix") == 3
    assert "merged" not in lines[2] and "draft" not in lines[2]
    assert "1 more fix PRs" in lines[3]
    # A contextual copy of a notified fix is displayed once, with its latest state.
    refreshed = replace(FIX, state="merged")
    one = next(b for b in render([replace(ISSUE, related_fixes=(refreshed,)), FIX]) if "accessory" in b)
    assert one["text"]["text"].count("#68597>") == 1
    assert "CI" not in one["text"]["text"]


def test_new_fix_and_overdue_issue_share_one_group() -> None:
    payload = maintainer_digest(maintainer="r", maintainer_slack="U1", entries=[FIX], waiting=[ISSUE], waiting_total=1,
                                day=NOW, mode=DeliveryMode.SHADOW).payload
    assert payload["text"] == "Triage digest: 1 P0"
    assert len([b for b in payload["blocks"] if "accessory" in b]) == 1


def test_impact_is_short_single_line_and_cannot_ping() -> None:
    entry = replace(ISSUE, summary="<!channel>\nRequests lose history. " + "More details. " * 30)
    text = next(b for b in render([entry]) if "accessory" in b)["text"]["text"]
    line = text.split("\n")[2]
    assert line.startswith("_!channel Requests lose history.")
    assert line.endswith("…_") and len(line) <= 205
    assert "<!channel>" not in text
    assert len(next(b for b in render([ISSUE]) if "accessory" in b)["text"]["text"].split("\n")) == 2


def test_all_p0_groups_are_visible_and_large_digests_continue() -> None:
    from triage.notify import split_digest

    entries = [replace(ISSUE, item_key=f"vllm-project/vllm#{n}") for n in range(60)]
    entries += [replace(ISSUE, item_key=f"vllm-project/vllm#{n}", score=50, band="route") for n in range(60, 70)]
    notification = maintainer_digest(maintainer="r", maintainer_slack="U1", entries=entries,
                                    day=NOW, mode=DeliveryMode.SHADOW)
    parts = split_digest(notification)
    assert len(parts) > 1 and parts[0].delivery_id == notification.delivery_id
    assert len({p.delivery_id for p in parts}) == len(parts)
    items = [b["block_id"] for p in parts for b in p.payload["blocks"] if "accessory" in b]
    assert set(items) == {f"triage:item:vllm-project/vllm#{n}" for n in range(62)}
    assert len(items) == len(set(items))
    assert "more P0" not in str([p.payload for p in parts])
    assert "8 more P1" in str([p.payload for p in parts])
    for part in parts:
        blocks = part.payload["blocks"]
        assert len(blocks) + sum("accessory" in b for b in blocks) <= 50
        assert "Open full list" in blocks[1]["text"]["text"]
