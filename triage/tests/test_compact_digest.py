"""Digest presentation from observed state, including conservative CI/readiness."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any

from alerting.ports import DeliveryMode

from triage.notify import _compact_ci, _pr_status, maintainer_digest
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
    for lang, symptom, age, action in [("en", "⚠️ wrong output", "33h", "🔔 needs your ack"),
                                     ("vi", "⚠️ kết quả sai", "33 giờ", "🔔 chờ bạn nhận")]:
        item = next(b for b in render([ISSUE, FIX], lang) if "accessory" in b)
        lines = item["text"]["text"].split("\n")
        assert lines[0] == "*<https://ci.vllm.ai/triage?item=vllm-project%2Fvllm%2368575|Responses API loses history>*"
        assert lines[1] == f"<https://github.com/vllm-project/vllm/issues/68575|#68575> · {symptom} · {age} · {action}"
        assert "CI ✓" in lines[2]
        assert "View in triage" not in item["text"]["text"] and "↗" not in item["text"]["text"]


def test_ci_never_reports_a_result_from_another_commit() -> None:
    assert _compact_ci(FIX, "en") == "✅ CI ✓"
    assert _compact_ci(replace(FIX, prepass={"head_sha": "new"}), "en") == "⚪ CI unknown"
    assert _compact_ci(replace(FIX, prepass={}), "vi") == "⚪ chưa rõ CI"
    assert _compact_ci(replace(FIX, state="merged"), "en") == ""
    failed = replace(FIX, ci={"head_sha": "abc", "state": "failed", "jobs_failed": 2,
                             "jobs_failed_pr_only": 0, "main_known": True})
    assert _compact_ci(failed, "en") == "🔴 CI ✗ (also on main)"
    assert _compact_ci(replace(failed, ci={**(failed.ci or {}), "main_known": False}), "en") == "🔴 CI ✗"


def test_pr_state_precedence_and_readiness_freshness() -> None:
    ready = replace(FIX, prepass={**FIX.prepass, "merge_ready": True, "merge_checked_at": NOW.isoformat(),
                                 "review_decision": "APPROVED"})
    assert _pr_status(ready, NOW, "en") == "🟢 ready to merge"
    assert _pr_status(ready, NOW + timedelta(hours=1), "en") == "✅ approved"
    assert _pr_status(replace(ready, ci={"head_sha": "abc", "state": "failed"}), NOW, "en") == "✅ approved"
    assert _pr_status(replace(ready, draft=True), NOW, "en") == "📝 draft"
    assert _pr_status(replace(ready, state="merged", draft=True), NOW, "vi") == "🟣 đã hợp nhất"
    assert _pr_status(replace(ready, prepass={**ready.prepass, "waiting_on": "author"}), NOW, "en") == "🟡 waiting on author"
    assert _pr_status(replace(FIX, prepass={}), NOW, "en") == "❔ check PR status"
    for bad in (None, "junk", "2026-11-20", (NOW + timedelta(hours=1)).isoformat()):
        assert _pr_status(replace(ready, prepass={**ready.prepass, "merge_checked_at": bad}), NOW, "en") == "✅ approved"


def test_context_fixes_are_compact_bounded_and_do_not_change_priority() -> None:
    fixes = tuple(replace(FIX, item_key=f"vllm-project/vllm#{n}", html_url=f"https://github.com/vllm-project/vllm/pull/{n}",
                          state="merged" if n == 2 else "open", draft=n == 3) for n in range(2, 6))
    item = replace(ISSUE, band="route", score=50, related_fixes=fixes)
    blocks = render([item])
    assert "1 P1" in blocks[1]["text"]["text"] and "P0" not in str(blocks)
    text = next(b for b in blocks if "accessory" in b)["text"]["text"]
    lines = text.split("\n")
    assert len(lines) == 4
    assert lines[2].count("↳ Fix") == 3 and "merged" in lines[2] and "draft" in lines[2]
    assert "1 more fix PRs" in lines[3]
    # A contextual copy of a notified fix is displayed once, with its latest state.
    refreshed = replace(FIX, state="merged")
    one = next(b for b in render([replace(ISSUE, related_fixes=(refreshed,)), FIX]) if "accessory" in b)
    assert one["text"]["text"].count("#68597>") == 1
    assert "merged" in one["text"]["text"]


def test_new_fix_and_overdue_issue_share_one_group() -> None:
    payload = maintainer_digest(maintainer="r", maintainer_slack="U1", entries=[FIX], waiting=[ISSUE], waiting_total=1,
                                day=NOW, mode=DeliveryMode.SHADOW).payload
    assert payload["text"] == "Triage digest: 1 P0"
    assert len([b for b in payload["blocks"] if "accessory" in b]) == 1


def test_impact_is_short_single_line_and_cannot_ping() -> None:
    entry = replace(ISSUE, summary="<!channel>\nRequests lose history. " + "More details. " * 30)
    text = next(b for b in render([entry]) if "accessory" in b)["text"]["text"]
    line = text.split("\n")[2]
    assert line.startswith("💡 _Why it matters: !channel Requests lose history.")
    assert line.endswith("…_") and len(line) <= 205
    assert "<!channel>" not in text
    assert "Why it matters" not in next(b for b in render([ISSUE]) if "accessory" in b)["text"]["text"]
