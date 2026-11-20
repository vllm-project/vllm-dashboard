"""Slack payloads for triage: an immediate DM for page-band items, a daily
DM digest per maintainer, and a daily team-channel digest.

Titles and summaries are untrusted (GitHub text and model output) and go
through alerting.untrusted.safe_slack_mrkdwn, which strips mentions and
non-vLLM links.
"""

from __future__ import annotations

import re
from datetime import datetime
from urllib.parse import quote
from typing import Any

from alerting.ports import AlertPath, DeliveryMode, DestinationMode, NotificationIntent
from alerting.untrusted import safe_slack_mrkdwn, trusted_url

from triage.groups import GROUP_REASON, is_group_reason
from triage.model import BAND_LABELS
from triage.routing import GH_ASSIGNED
from triage.store import DigestEntry

DASHBOARD = "https://ci.vllm.ai/triage"
MAINTAINER_FILE = "https://github.com/vllm-project/vllm-dashboard/blob/main/triage/config/maintainers/{login}.yaml"
_BAND_ICON = {"page": ":rotating_light:", "route": ":large_orange_diamond:", "watch": ":small_blue_diamond:"}


def _link(url: str, text: str) -> str:
    label = safe_slack_mrkdwn(text.replace("|", "/")[:150])
    return f"<{url}|{label}>" if trusted_url(url) else label


_PR_REF = re.compile(r"#(\d{2,7})")


def _item_url(item_key: str) -> str:
    """Dashboard link that opens the item. The key must be encoded: an
    unencoded "#" would start the URL fragment and cut the key short."""
    return f"{DASHBOARD}?item={quote(item_key, safe='')}"


def _pr_links(text: str) -> str:
    """#123 -> a link to that vllm PR (text is already Slack-escaped)."""
    return _PR_REF.sub(lambda m: f"<https://github.com/vllm-project/vllm/pull/{m.group(1)}|#{m.group(1)}>", text)


# The bot's own wording. English for everyone; Vietnamese is a one-off for
# maintainers whose file says `language: vi` (gau-nernst). Item titles and
# summaries are never translated.
STRINGS: dict[str, dict[str, str]] = {
    "en": {
        "digest_top": "<{url}|Open full list →> · {counts}",
        "compact_footer": "Use ⋯ to acknowledge or pass on an item · <{file}|Preferences>",
        "more_band": "…and {n} more {band} · <{url}|Open full list>",
        "more_waiting": "…and {n} more overdue items · <{url}|Open full list>",
        "more_fixes": "…and {n} more fix PRs · <{url}|View issue>",
        "compact_fix": "↳ Fix {ref}",
        "needs_ack": "needs your ack",
        "acked": "acked",
        "done": "Done",
        "merged": "merged",
        "closed": "closed",
        "draft": "draft",
        "waiting_author": "waiting on author",
        "ready_review": "ready for review",
        "ready_merge": "ready to merge",
        "approved": "approved",
        "check_status": "check PR status",
        "ci_unknown": "CI unknown",
        "ci_in_progress": "CI running",
        "ci_failed_main": "CI ✗ (also on main)",
        "age_minutes": "{n}m",
        "age_hours": "{n}h",
        "age_days": "{n}d",
        "age_weeks": "{n}w",
        "symptom_serving_broken": "serving broken",
        "symptom_crash": "crash",
        "symptom_wrong_output": "wrong output",
        "symptom_security": "security",
        "symptom_hang": "hang",
        "symptom_regression": "regression",
        "symptom_perf": "performance regression",
        "symptom_memory": "memory regression",
        "authored": "you wrote #{n}, which this item names",
        "gh_assigned": "it is assigned to you on GitHub",
        "commented": "you already commented on it",
        "group_fixes": "it fixes #{n}, which you own",
        "group_fixed_by": "it is fixed by #{n}, which you own",
        "fix_line": "↳ fix: {link}",
        "relevance": "judged {level} from your recent work{like}",
        "like": " (like {prs})",
        "rule": "your rule: {kind} {value}",
        "why_you": "Why you",
        "owner": "Owner",
        "unrouted": "unrouted",
        "ack": "Ack",
        "not_mine": "Not mine",
        "reassign": "Reassign to…",
        "open": "Open in dashboard",
        "page_primary": "Triage: P0 item for you",
        "page_backup": "Triage: you are backup on a P0 item",
        "route_primary": "Triage: P1 item for you",
        "route_backup": "Triage: you are backup on a P1 item",
        "digest_header": "📬 Daily triage digest · {date}",
        "digest_text": "Triage digest: {counts}",
        "ci_not_started": "CI: not started",
        "ci_canceled": "CI: canceled",
        "ci_running": "{n} running",
        "ci_all_main": "also failing on main",
        "ci_some_main": "{m} also failing on main",
        "ci_recent_main": "{r} flaky on main",
        "ci_none_main": "only on this PR",
    },
    "vi": {
        "digest_top": "<{url}|Mở toàn bộ danh sách →> · {counts}",
        "compact_footer": "Dùng ⋯ để nhận hoặc chuyển mục · <{file}|Tùy chỉnh>",
        "more_band": "…và {n} mục {band} khác · <{url}|Mở toàn bộ danh sách>",
        "more_waiting": "…và {n} mục quá hạn khác · <{url}|Mở toàn bộ danh sách>",
        "more_fixes": "…và {n} PR sửa lỗi khác · <{url}|Xem issue>",
        "compact_fix": "↳ Bản sửa {ref}",
        "needs_ack": "chờ bạn nhận",
        "acked": "đã nhận",
        "done": "Hoàn thành",
        "merged": "đã hợp nhất",
        "closed": "đã đóng",
        "draft": "bản nháp",
        "waiting_author": "chờ tác giả",
        "ready_review": "sẵn sàng review",
        "ready_merge": "sẵn sàng hợp nhất",
        "approved": "đã duyệt",
        "check_status": "kiểm tra trạng thái PR",
        "ci_unknown": "chưa rõ CI",
        "ci_in_progress": "CI đang chạy",
        "ci_failed_main": "CI ✗ (cũng lỗi trên main)",
        "age_minutes": "{n} phút",
        "age_hours": "{n} giờ",
        "age_days": "{n} ngày",
        "age_weeks": "{n} tuần",
        "symptom_serving_broken": "không phục vụ được",
        "symptom_crash": "bị crash",
        "symptom_wrong_output": "kết quả sai",
        "symptom_security": "bảo mật",
        "symptom_hang": "bị treo",
        "symptom_regression": "lỗi hồi quy",
        "symptom_perf": "giảm hiệu năng",
        "symptom_memory": "tăng bộ nhớ",
        "authored": "bạn đã viết #{n}, PR được nhắc tới trong mục này",
        "gh_assigned": "mục này được giao cho bạn trên GitHub",
        "commented": "bạn đã bình luận trong mục này",
        "group_fixes": "đây là bản sửa cho #{n}, mục bạn đang phụ trách",
        "group_fixed_by": "mục này được sửa bởi #{n}, PR bạn đang phụ trách",
        "fix_line": "↳ bản sửa: {link}",
        "relevance": "được đánh giá {level} dựa trên công việc gần đây của bạn{like}",
        "like": " (giống {prs})",
        "rule": "quy tắc của bạn: {kind} {value}",
        "why_you": "Vì sao là bạn",
        "owner": "Người phụ trách",
        "unrouted": "chưa có người",
        "ack": "Nhận việc",
        "not_mine": "Không phải của tôi",
        "reassign": "Chuyển cho…",
        "open": "Mở trên dashboard",
        "page_primary": "Triage: một P0 thuộc mảng của bạn",
        "page_backup": "Triage: bạn là người dự phòng cho một P0",
        "route_primary": "Triage: một P1 thuộc mảng của bạn",
        "route_backup": "Triage: bạn là người dự phòng cho một P1",
        "digest_header": "📬 Digest triage hằng ngày · {date}",
        "digest_text": "Digest triage: {counts}",
        "ci_not_started": "CI: chưa chạy",
        "ci_canceled": "CI: đã hủy",
        "ci_running": "{n} đang chạy",
        "ci_all_main": "cũng lỗi trên main",
        "ci_some_main": "{m} cũng lỗi trên main",
        "ci_recent_main": "{r} chập chờn trên main",
        "ci_none_main": "chỉ lỗi ở PR này",
    },
}
_LEVELS_VI = {"high": "cao", "medium": "trung bình"}


def _t(lang: str, key: str, **kw: object) -> str:
    table = STRINGS.get(lang, STRINGS["en"])
    return table.get(key, STRINGS["en"][key]).format(**kw)


def describe_reason(raw: str, lang: str = "en") -> str:
    """Router reason codes in plain words, matching the dashboard."""
    if m := re.fullmatch(r"authored #(\d+)", raw):
        return _t(lang, "authored", n=m.group(1))
    if raw == "commented":
        return _t(lang, "commented")
    if raw == GH_ASSIGNED:
        return _t(lang, "gh_assigned")
    if m := GROUP_REASON.fullmatch(raw):
        return _t(lang, "group_fixes" if m.group(1) == "fixes" else "group_fixed_by", n=m.group(2))
    if m := re.fullmatch(r"relevance:(high|medium)(?: \(like (.+)\))?", raw):
        like = _t(lang, "like", prs=m.group(2)) if m.group(2) else ""
        level = _LEVELS_VI.get(m.group(1), m.group(1)) if lang == "vi" else m.group(1)
        return _t(lang, "relevance", level=level, like=like)
    if m := re.fullmatch(r"(area|hardware|model|path|keyword):(.+)", raw):
        return _t(lang, "rule", kind=m.group(1), value=m.group(2))
    return raw


def _why(entry: DigestEntry, lang: str, *, in_group: bool = False) -> str:
    """Why this person: involvement in plain words, then Claude's own
    one-liner in their language when there is one, else the reason codes.
    `in_group` drops "fixes #N, which you own": the group already shows it."""
    matched = [m for m in entry.matched if not (in_group and is_group_reason(m))]
    involved = [m for m in matched
                if m in ("commented", GH_ASSIGNED) or m.startswith("authored ") or is_group_reason(m)]
    others = [m for m in matched if m not in involved]
    phrases = [describe_reason(m, lang) for m in involved]
    if lang != "en" and entry.why_local:
        phrases.append(entry.why_local[:300])
    else:
        phrases += [describe_reason(m, lang) for m in others]
    return "; ".join(_pr_links(safe_slack_mrkdwn(p)) for p in phrases[:3])


_BAND_RANK = {"page": 0, "route": 1, "watch": 2, "ignore": 3}


def group_entries(entries: list[DigestEntry]) -> list[tuple[DigestEntry, list[DigestEntry]]]:
    """Issue + fix PR groups (triage/groups.py) among `entries`, in order of
    first appearance: each PR whose fixed issue is also listed goes under
    that issue (the highest-scored one when it fixes several). Other entries
    stand alone."""
    issues = {e.item_key: e for e in entries if e.kind == "issue"}
    parent: dict[str, str] = {}
    for e in entries:
        targets = [issues[k] for k in e.fixes if k in issues] if e.kind == "pr" else []
        if targets:
            parent[e.item_key] = max(targets, key=lambda t: t.score).item_key
    by_key = {e.item_key: e for e in entries}
    groups: dict[str, list[DigestEntry]] = {}
    for e in entries:
        main = parent.get(e.item_key, e.item_key)
        members = groups.setdefault(main, [])
        if main != e.item_key and all(m.item_key != e.item_key for m in members):
            members.append(e)
    return [(by_key[k], fixes) for k, fixes in groups.items()]


def group_band(main: DigestEntry, fixes: list[DigestEntry]) -> str:
    """A group is as urgent as its most urgent member."""
    return min((main, *fixes), key=lambda e: _BAND_RANK.get(e.band, 9)).band


def _why_source(main: DigestEntry, fixes: list[DigestEntry]) -> DigestEntry:
    """Whose "why you" a group shows: the first member routed on its own
    merits (the others just followed it)."""
    for e in (main, *fixes):
        if e.why_local or any(not is_group_reason(m) for m in e.matched):
            return e
    return main


def _fix_lines(fixes: list[DigestEntry], lang: str) -> list[str]:
    """"↳ fix: #123 title", then the fix PR's CI when known."""
    return [_t(lang, "fix_line", link=_link(f.html_url, f"#{f.item_key.rsplit('#', 1)[-1]} {f.title}"))
            + (f" · {ci_fragment(f.ci, lang)}" if f.ci else "")
            for f in fixes]
def ci_fragment(ci: dict[str, Any] | None, lang: str = "en") -> str:
    """The PR's CI in a few plain words: "CI: 38/41 ✓, 1 ✗ (also failing on
    main)"; "flaky on main": failed on main in the last MAIN_RECENT_DAYS but
    not now. Counts only; job names stay on the dashboard."""
    if not ci:
        return ""
    state = ci.get("state")
    if state == "not_started":
        return _t(lang, "ci_not_started")
    if state == "canceled":
        return _t(lang, "ci_canceled")
    total, passed = int(ci.get("jobs_total") or 0), int(ci.get("jobs_passed") or 0)
    running, failed = int(ci.get("jobs_running") or 0), int(ci.get("jobs_failed") or 0)
    parts = [f"{passed}/{total} ✓"]
    if running:
        parts.append(_t(lang, "ci_running", n=running))
    if failed:
        on_main = int(ci.get("jobs_failed_on_main") or 0)
        recent = int(ci.get("jobs_failed_recent_on_main") or 0)
        notes: list[str] = []
        if ci.get("main_known"):
            if on_main >= failed:
                notes.append(_t(lang, "ci_all_main"))
            else:
                if on_main:
                    notes.append(_t(lang, "ci_some_main", m=on_main))
                if recent:
                    notes.append(_t(lang, "ci_recent_main", r=recent))
                if not notes:
                    notes.append(_t(lang, "ci_none_main"))
        parts.append(f"{failed} ✗" + (f" ({', '.join(notes)})" if notes else ""))
    return "CI: " + ", ".join(parts)


def _item_line(
    entry: DigestEntry, owners: list[str] | None = None, lang: str = "en", *, summary: bool = True, level: bool = True,
    fixes: list[DigestEntry] | None = None,
) -> str:
    """Bold title (the link), then a "↳ fix:" line per fix PR in its group,
    then the summary, then a bold "Why you:" line (one for the group).
    No score: "P0 · 99" means nothing in Slack; the P-level says how urgent it
    is and the dashboard explains the number. `level=False` drops the
    "🚨 P0" prefix where a group heading already says it."""
    fixes = fixes or []
    number = entry.item_key.rsplit("#", 1)[-1]
    band = group_band(entry, fixes)
    prefix = f"{_BAND_ICON.get(band, '')} *{BAND_LABELS.get(band, '')}* ".lstrip() if level else ""
    parts = [f"{prefix}*{_link(entry.html_url, f'#{number} {entry.title}')}*", *_fix_lines(fixes, lang)]
    if summary and entry.summary:
        parts.append(f"_{safe_slack_mrkdwn(entry.summary[:240])}_")
    if entry.ci:
        parts.append(ci_fragment(entry.ci, lang))
    source = _why_source(entry, fixes)
    why = _why(source, lang, in_group=bool(fixes))
    if why:
        parts.append(f"*{_t(lang, 'why_you')}:* {why}")
    if owners is not None:
        unrouted = _t(lang, "unrouted")
        parts.append(f"*{_t(lang, 'owner')}:* " + (", ".join(safe_slack_mrkdwn(o) for o in owners) if owners else f"_{unrouted}_"))
    return "\n".join(parts)


def _item_section(
    entry: DigestEntry, *, menu: bool, lang: str = "en", summary: bool = True, level: bool = True,
    fixes: list[DigestEntry] | None = None,
) -> dict[str, Any]:
    """One item (or group: its issue with the fix PRs under it) as a
    section; `menu` adds the older overflow menu (Ack / Not mine / Open)."""
    block: dict[str, Any] = {
        "type": "section",
        "block_id": f"triage:item:{entry.item_key}",
        "text": {"type": "mrkdwn",
                 "text": _item_line(entry, lang=lang, summary=summary, level=level, fixes=fixes)[:2900]},
    }
    if menu:
        block["accessory"] = {
            "type": "overflow",
            "action_id": "triage:menu",
            "options": [
                {"text": {"type": "plain_text", "text": _t(lang, "ack")}, "value": f"ack|{entry.item_key}"},
                {"text": {"type": "plain_text", "text": _t(lang, "not_mine")}, "value": f"not_mine|{entry.item_key}"},
                {"text": {"type": "plain_text", "text": _t(lang, "open")}, "value": "open",
                 "url": _item_url(entry.item_key)},
            ],
        }
    return block


def _actions(entry: DigestEntry, reassign_to: list[str], lang: str = "en", *, open_button: bool = True) -> dict[str, Any]:
    """Ack / Not mine / Reassign / Open under a single-item DM. The click is
    handled by the dashboard (/api/triage/slack/interactions), which checks
    the request is signed by Slack and that the clicker owns the item. For a
    group the buttons carry its main item (the issue); the dashboard applies
    the action to the group's fix PRs the same person holds too."""
    elements: list[dict[str, Any]] = [
        {"type": "button", "action_id": "triage:ack", "style": "primary",
         "text": {"type": "plain_text", "text": _t(lang, "ack")}, "value": entry.item_key},
        {"type": "button", "action_id": "triage:not_mine",
         "text": {"type": "plain_text", "text": _t(lang, "not_mine")}, "value": entry.item_key},
    ]
    if reassign_to:
        elements.append({
            "type": "static_select",
            "action_id": "triage:reassign",
            "placeholder": {"type": "plain_text", "text": _t(lang, "reassign")},
            "options": [{"text": {"type": "plain_text", "text": login[:75]}, "value": login}
                        for login in sorted(reassign_to, key=str.lower)[:100]],
        })
    if open_button:
        elements.append({"type": "button", "action_id": "triage:open", "url": _item_url(entry.item_key),
                         "text": {"type": "plain_text", "text": _t(lang, "open")}})
    return {"type": "actions", "block_id": f"triage:actions:{entry.item_key}", "elements": elements}


def _payload(header: str, lines: list[str], footer: str) -> dict[str, Any]:
    """Plain line-based message (team digest): sections of <= ~2900 chars."""
    body = "\n\n".join(lines)
    sections: list[dict[str, Any]] = []
    chunk = ""
    for line in lines:
        if len(chunk) + len(line) + 2 > 2900:
            sections.append({"type": "section", "text": {"type": "mrkdwn", "text": chunk}})
            chunk = ""
        chunk = f"{chunk}\n\n{line}" if chunk else line
    if chunk:
        sections.append({"type": "section", "text": {"type": "mrkdwn", "text": chunk}})
    return {
        "text": f"{header}\n{body}"[:3900],
        "blocks": [
            {"type": "header", "text": {"type": "plain_text", "text": header[:150]}},
            *sections[:45],
            {"type": "context", "elements": [{"type": "mrkdwn", "text": footer}]},
        ],
        "unfurl_links": False,
        "unfurl_media": False,
    }


def page_dm(
    *, assignment_key: str, maintainer_slack: str, entry: DigestEntry, role: str, mode: DeliveryMode,
    reassign_to: list[str] | None = None, lang: str = "en", fixes: list[DigestEntry] | None = None,
) -> NotificationIntent:
    """The immediate DM; with `fixes`, `entry` is the group's issue and the
    fix PRs routed with it are listed under it."""
    band = group_band(entry, fixes or [])
    key = ("page_" if band == "page" else "route_") + ("primary" if role == "primary" else "backup")
    header = _t(lang, key)
    return NotificationIntent(
        delivery_id=f"triage:page:{assignment_key}",
        alert_ref=entry.item_key,
        alert_path=AlertPath.TRIAGE,
        delivery_mode=mode,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination=maintainer_slack,
        payload={
            "text": f"{header}: {entry.title}"[:3900],
            "blocks": [
                {"type": "header", "text": {"type": "plain_text", "text": header[:150]}},
                _item_section(entry, menu=False, lang=lang, fixes=fixes),
                _actions(entry, reassign_to or [], lang),
            ],
            "unfurl_links": False,
            "unfurl_media": False,
        },
    )


# Bound visual length, not just Slack's 50-block API limit.
SLACK_MAX_BLOCKS = 50
DIGEST_MAX_ITEMS = 5
DIGEST_MAX_PER_BAND = 3
DIGEST_MAX_FIXES = 3
WAITING_AFTER_DAYS = 3
WAITING_MAX_ITEMS = 5


def _age(entry: DigestEntry, now: datetime, lang: str) -> str:
    if entry.created_at is None:
        return ""
    seconds = max(0, int((now - entry.created_at).total_seconds()))
    if seconds < 3600:
        return _t(lang, "age_minutes", n=seconds // 60)
    if seconds < 48 * 3600:
        return _t(lang, "age_hours", n=seconds // 3600)
    if seconds < 14 * 86400:
        return _t(lang, "age_days", n=seconds // 86400)
    return _t(lang, "age_weeks", n=seconds // (7 * 86400))


def _symptom(entry: DigestEntry, lang: str) -> str:
    # Same precedence as the dashboard's worstSymptom.
    for key in ("serving_broken", "crash", "wrong_output", "security", "hang"):
        if entry.severity.get(key) is True:
            return _t(lang, "symptom_" + key)
    if entry.item_type in ("regression", "perf_regression"):
        return _t(lang, "symptom_regression")
    if entry.severity.get("perf_regression_pct"):
        return _t(lang, "symptom_perf")
    if entry.severity.get("memory_regression") is True:
        return _t(lang, "symptom_memory")
    return ""


def _pr_status(entry: DigestEntry, now: datetime, lang: str) -> str:
    if entry.state in ("merged", "closed"):
        return _t(lang, entry.state)
    if entry.draft:
        return _t(lang, "draft")
    prepass = entry.prepass
    if prepass.get("waiting_on") == "author":
        return _t(lang, "waiting_author")
    checked = prepass.get("merge_checked_at")
    try:
        fresh = isinstance(checked, str) and 0 <= (now - datetime.fromisoformat(checked)).total_seconds() < 3600
    except (ValueError, TypeError):
        fresh = False
    if prepass.get("waiting_on") == "reviewer":
        ci = entry.ci or {}
        if (prepass.get("merge_ready") is True and fresh and prepass.get("head_sha")
                and ci.get("head_sha") == prepass["head_sha"] and ci.get("state") == "passed"):
            return _t(lang, "ready_merge")
        if prepass.get("review_decision") == "APPROVED":
            return _t(lang, "approved")
        return _t(lang, "ready_review")
    return _t(lang, "check_status")


def _compact_ci(entry: DigestEntry, lang: str) -> str:
    if entry.state != "open":
        return ""
    ci = entry.ci or {}
    head = entry.prepass.get("head_sha")
    if not head or ci.get("head_sha") != head:
        return _t(lang, "ci_unknown")
    state = ci.get("state")
    if state == "passed":
        return "CI ✓"
    if state == "failed" or ci.get("jobs_failed", 0):
        if ci.get("main_known") and ci.get("jobs_failed", 0) and ci.get("jobs_failed_pr_only") == 0:
            return _t(lang, "ci_failed_main")
        return "CI ✗"
    return _t(lang, {"running": "ci_in_progress", "not_started": "ci_not_started",
                    "canceled": "ci_canceled"}.get(str(state), "ci_unknown"))


def _digest_section(
    entry: DigestEntry, fixes: list[DigestEntry], now: datetime, lang: str,
) -> dict[str, Any]:
    # The title opens triage; only the plain number opens GitHub.
    number = entry.item_key.rsplit("#", 1)[-1]
    status = _t(lang, "needs_ack" if entry.assignment_status == "open" else "acked")
    if entry.state != "open":
        status = _t(lang, "merged" if entry.state == "merged" else "closed")
    elif entry.kind == "pr":
        status += " · " + _pr_status(entry, now, lang)
    metadata = [_link(entry.html_url, f"#{number}"), _symptom(entry, lang), _age(entry, now, lang), status]
    if entry.kind == "pr":
        metadata.append(_compact_ci(entry, lang))
    lines = [f"*{_link(_item_url(entry.item_key), entry.title)}*", " · ".join(p for p in metadata if p)]
    # Context can include a merged or unassigned fix that isn't a notification.
    linked = {f.item_key: f for f in fixes}
    linked.update({f.item_key: f for f in entry.related_fixes})
    fix_entries = list(linked.values())
    parts = []
    for fix in fix_entries[:DIGEST_MAX_FIXES]:
        ref = _link(fix.html_url, "#" + fix.item_key.rsplit("#", 1)[-1])
        parts.append(" · ".join(p for p in [
            _t(lang, "compact_fix", ref=ref), _pr_status(fix, now, lang), _compact_ci(fix, lang),
        ] if p))
    if parts:
        lines.append("   ·   ".join(parts))
    if len(fix_entries) > DIGEST_MAX_FIXES:
        lines.append(_t(lang, "more_fixes", n=len(fix_entries) - DIGEST_MAX_FIXES, url=_item_url(entry.item_key)))
    options: list[dict[str, Any]] = []
    if entry.state == "open" and entry.assignment_status in ("open", "acked"):
        action = "ack" if entry.assignment_status == "open" else "done"
        options += [
            {"text": {"type": "plain_text", "text": _t(lang, action)}, "value": f"{action}|{entry.item_key}"},
            {"text": {"type": "plain_text", "text": _t(lang, "not_mine")}, "value": f"not_mine|{entry.item_key}"},
        ]
    options.append({"text": {"type": "plain_text", "text": _t(lang, "open")}, "value": "open",
                    "url": _item_url(entry.item_key)})
    return {
        "type": "section", "block_id": f"triage:item:{entry.item_key}",
        "text": {"type": "mrkdwn", "text": "\n".join(lines)},
        "accessory": {"type": "overflow", "action_id": "triage:menu", "options": options},
    }


def maintainer_digest(
    *, maintainer: str, maintainer_slack: str, entries: list[DigestEntry], day: datetime, mode: DeliveryMode,
    lang: str = "en", reassign_to: list[str] | None = None,
    waiting: list[DigestEntry] | None = None, waiting_total: int = 0,
) -> NotificationIntent:
    """A compact, priority-grouped digest. Titles open triage, numbers open
    GitHub, and one menu acts on each issue/fix group. At most five groups
    (three per band) are shown; overflow always links to the full list.
    New assignments and overdue unacked reminders share the same layout.
    Context-only fixes never become notifications or change a group's band.
    """
    unique = {e.item_key: e for e in entries}
    for entry in waiting or []:
        unique.setdefault(entry.item_key, entry)
    groups = group_entries(sorted(unique.values(), key=lambda e: -e.score))
    me = f"{DASHBOARD}/me?view=all"
    date = f"{day.day}/{day.month}" if lang == "vi" else f"{day:%b} {day.day}"
    counts = {band: sum(group_band(m, f) == band for m, f in groups) for band in _BAND_RANK}
    summary = ", ".join(f"{n} {BAND_LABELS[b]}" for b, n in counts.items() if n)
    blocks: list[dict[str, Any]] = [
        {"type": "header", "text": {"type": "plain_text", "text": _t(lang, "digest_header", date=date)}},
        {"type": "section", "text": {"type": "mrkdwn", "text":
            _t(lang, "digest_top", url=me, counts=summary)}},
    ]
    remaining = DIGEST_MAX_ITEMS
    for band in _BAND_RANK:
        in_band = [(m, f) for m, f in groups if group_band(m, f) == band]
        if not in_band:
            continue
        label = BAND_LABELS[band]
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text":
                       "*" + " ".join(p for p in (_BAND_ICON.get(band, ""), label) if p) + "*"}})
        shown = in_band[:min(remaining, DIGEST_MAX_PER_BAND)]
        blocks.extend(_digest_section(m, f, day, lang) for m, f in shown)
        remaining -= len(shown)
        if len(shown) < len(in_band):
            blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text":
                _t(lang, "more_band", n=len(in_band) - len(shown), band=label, url=me)}]})
    # The store bounds the reminder query. Do not silently drop its unseen tail.
    extra_waiting = max(0, waiting_total - len({e.item_key for e in waiting or []}))
    if extra_waiting:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text":
            _t(lang, "more_waiting", n=extra_waiting, url=me)}]})
    blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text":
        _t(lang, "compact_footer", file=MAINTAINER_FILE.format(login=quote(maintainer)))}]})
    return NotificationIntent(
        delivery_id=f"triage:digest:{maintainer}:{day.date().isoformat()}",
        alert_ref=f"digest:{maintainer}", alert_path=AlertPath.TRIAGE, delivery_mode=mode,
        destination_mode=DestinationMode.BOT_TOKEN, destination=maintainer_slack,
        payload={"text": _t(lang, "digest_text", counts=summary), "blocks": blocks,
                 "unfurl_links": False, "unfurl_media": False},
    )


def team_digest(
    *, channel: str, entries: list[tuple[DigestEntry, list[str]]], day: datetime, mode: DeliveryMode,
    suppression: list[tuple[str, int, int]] | None = None,
) -> NotificationIntent:
    owners_of = {e.item_key: owners for e, owners in entries}
    lines = [_item_line(main, owners_of[main.item_key], fixes=fixes)
             for main, fixes in group_entries([e for e, _ in entries])[:30]]
    lines = lines or ["Nothing above the routing threshold today."]
    if suppression:
        who = "; ".join(f"{safe_slack_mrkdwn(a)}: {d} dropped, {s} slop" for a, d, s in suppression)
        lines.insert(0, f":warning: *Unusual number of items hidden in the last 24h* ({who}). "
                        f"Dropped and slop items are never routed again; check <{DASHBOARD}|the queue>.")
    return NotificationIntent(
        delivery_id=f"triage:team-digest:{day.date().isoformat()}",
        alert_ref="team-digest",
        alert_path=AlertPath.TRIAGE,
        delivery_mode=mode,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination=channel,
        payload=_payload(
            f"Triage: top new issues and PRs ({day.date().isoformat()})",
            lines,
            f"Scores are computed from LLM-extracted facets; see <{DASHBOARD}|the triage queue> for breakdowns.",
        ),
    )
