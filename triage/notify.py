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
        "authored": "you wrote #{n}, which this item names",
        "gh_assigned": "it is assigned to you on GitHub",
        "commented": "you already commented on it",
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
        "digest_header": "📬 Daily triage digest · {date}",
        "digest_text": "Triage digest: {counts}",
        "digest_hello": "Hi <@{slack}> 👋 Today you have {parts}. <{url}|📋 Open your list>",
        "hello_page": "*{n} P0* to look at soon",
        "hello_route": "*{n} P1* for when you have time",
        "hello_join": " and ",
        "group_page": "🚨 P0: look soon ({n})",
        "group_route": "🔶 P1: when you have time ({n})",
        "digest_more": "…and {m} more on <{url}|My list>.",
        "digest_footer": "Press *Ack* to take an item, or *Not mine* to pass it on. "
                         "Everything is on <{url}|My list> · <{file}|Change what you get>",
    },
    "vi": {
        "authored": "bạn đã viết #{n}, PR được nhắc tới trong mục này",
        "gh_assigned": "mục này được giao cho bạn trên GitHub",
        "commented": "bạn đã bình luận trong mục này",
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
        "digest_header": "📬 Digest triage hằng ngày · {date}",
        "digest_text": "Digest triage: {counts}",
        "digest_hello": "Chào <@{slack}> 👋 Hôm nay bạn có {parts} nhé. <{url}|📋 Mở danh sách của bạn>",
        "hello_page": "*{n} P0* cần xem sớm",
        "hello_route": "*{n} P1* xem khi rảnh",
        "hello_join": " và ",
        "group_page": "🚨 P0: cần xem sớm ({n})",
        "group_route": "🔶 P1: xem khi rảnh ({n})",
        "digest_more": "…và {m} mục khác trong <{url}|My list>.",
        "digest_footer": "Bấm *Nhận việc* nếu bạn nhận, hoặc *Không phải của tôi* để chuyển cho người khác. "
                         "Tất cả ở <{url}|My list> · <{file}|Đổi mảng nhận việc>",
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
    if m := re.fullmatch(r"relevance:(high|medium)(?: \(like (.+)\))?", raw):
        like = _t(lang, "like", prs=m.group(2)) if m.group(2) else ""
        level = _LEVELS_VI.get(m.group(1), m.group(1)) if lang == "vi" else m.group(1)
        return _t(lang, "relevance", level=level, like=like)
    if m := re.fullmatch(r"(area|hardware|model|path|keyword):(.+)", raw):
        return _t(lang, "rule", kind=m.group(1), value=m.group(2))
    return raw


def _why(entry: DigestEntry, lang: str) -> str:
    """Why this person: involvement in plain words, then Claude's own
    one-liner in their language when there is one, else the reason codes."""
    involved = [m for m in entry.matched if m in ("commented", GH_ASSIGNED) or m.startswith("authored ")]
    others = [m for m in entry.matched if m not in involved]
    phrases = [describe_reason(m, lang) for m in involved]
    if lang != "en" and entry.why_local:
        phrases.append(entry.why_local[:300])
    else:
        phrases += [describe_reason(m, lang) for m in others]
    return "; ".join(_pr_links(safe_slack_mrkdwn(p)) for p in phrases[:3])


def _item_line(
    entry: DigestEntry, owners: list[str] | None = None, lang: str = "en", *, summary: bool = True, level: bool = True,
) -> str:
    """Bold title (the link), then the summary, then a bold "Why you:" line.
    No score: "P0 · 99" means nothing in Slack; the P-level says how urgent it
    is and the dashboard explains the number. `level=False` drops the
    "🚨 P0" prefix where a group heading already says it."""
    number = entry.item_key.rsplit("#", 1)[-1]
    prefix = f"{_BAND_ICON.get(entry.band, '')} *{BAND_LABELS.get(entry.band, '')}* ".lstrip() if level else ""
    parts = [f"{prefix}*{_link(entry.html_url, f'#{number} {entry.title}')}*"]
    if summary and entry.summary:
        parts.append(f"_{safe_slack_mrkdwn(entry.summary[:240])}_")
    if entry.matched or entry.why_local:
        parts.append(f"*{_t(lang, 'why_you')}:* {_why(entry, lang)}")
    if owners is not None:
        unrouted = _t(lang, "unrouted")
        parts.append(f"*{_t(lang, 'owner')}:* " + (", ".join(safe_slack_mrkdwn(o) for o in owners) if owners else f"_{unrouted}_"))
    return "\n".join(parts)


def _item_section(
    entry: DigestEntry, *, menu: bool, lang: str = "en", summary: bool = True, level: bool = True,
) -> dict[str, Any]:
    """One item as a section; `menu` adds the older overflow menu (Ack / Not mine / Open)."""
    block: dict[str, Any] = {
        "type": "section",
        "block_id": f"triage:item:{entry.item_key}",
        "text": {"type": "mrkdwn", "text": _item_line(entry, lang=lang, summary=summary, level=level)[:2900]},
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
    the request is signed by Slack and that the clicker owns the item."""
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
    reassign_to: list[str] | None = None, lang: str = "en",
) -> NotificationIntent:
    header = _t(lang, "page_primary" if role == "primary" else "page_backup")
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
                _item_section(entry, menu=False, lang=lang),
                _actions(entry, reassign_to or [], lang),
            ],
            "unfurl_links": False,
            "unfurl_media": False,
        },
    )


# Each digest item is two blocks (line + buttons); Slack allows 50 per message.
DIGEST_MAX_ITEMS = 20


def maintainer_digest(
    *, maintainer: str, maintainer_slack: str, entries: list[DigestEntry], day: datetime, mode: DeliveryMode,
    lang: str = "en", reassign_to: list[str] | None = None,
) -> NotificationIntent:
    """The daily DM, laid out to scan in Slack:

      header      "📬 Daily triage digest · Nov 18" (the date tells days apart)
      hello       counts per level, so you know the size before scrolling
      ── P0 (n) / ── P1 (n), each group behind a divider
        bold linked title, then a bold "Why you:" line
        [Ack] [Not mine] [Reassign ▾]   (the title already opens GitHub)
      footer      My list and the maintainer's own file

    No summaries or per-line P-levels (the group says it). Titles are never
    translated. At most DIGEST_MAX_ITEMS items fit Slack's 50-block limit."""
    more = max(0, len(entries) - DIGEST_MAX_ITEMS)
    shown = entries[:DIGEST_MAX_ITEMS]
    date = f"{day.day}/{day.month}" if lang == "vi" else f"{day:%b} {day.day}"
    header = _t(lang, "digest_header", date=date)
    counts = {band: sum(1 for e in entries if e.band == band) for band in ("page", "route")}
    hello_parts = [_t(lang, f"hello_{band}", n=n) for band, n in counts.items() if n]
    hello = _t(lang, "digest_hello", slack=maintainer_slack, url=f"{DASHBOARD}/me",
               parts=_t(lang, "hello_join").join(hello_parts) or str(len(entries)))
    text = _t(lang, "digest_text", counts=", ".join(f"{n} {BAND_LABELS[b]}" for b, n in counts.items() if n))
    blocks: list[dict[str, Any]] = [
        {"type": "header", "text": {"type": "plain_text", "text": header[:150]}},
        {"type": "section", "text": {"type": "mrkdwn", "text": hello}},
    ]
    for band in ("page", "route", "watch", "ignore"):
        group = [e for e in shown if e.band == band]
        if not group:
            continue
        key = f"group_{band}"
        title = _t(lang, key, n=counts.get(band, len(group))) if key in STRINGS["en"] else BAND_LABELS.get(band, band)
        blocks.append({"type": "divider"})
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": f"*{title}*"}})
        for e in group:
            blocks.append(_item_section(e, menu=False, lang=lang, summary=False, level=False))
            blocks.append(_actions(e, reassign_to or [], lang, open_button=False))
    if more:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn",
                       "text": _t(lang, "digest_more", m=more, url=f"{DASHBOARD}/me")}]})
    blocks.append({"type": "divider"})
    blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": _t(
        lang, "digest_footer", url=f"{DASHBOARD}/me", file=MAINTAINER_FILE.format(login=quote(maintainer)))}]})
    return NotificationIntent(
        delivery_id=f"triage:digest:{maintainer}:{day.date().isoformat()}",
        alert_ref=f"digest:{maintainer}",
        alert_path=AlertPath.TRIAGE,
        delivery_mode=mode,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination=maintainer_slack,
        payload={
            "text": text,
            "blocks": blocks[:50],
            "unfurl_links": False,
            "unfurl_media": False,
        },
    )


def team_digest(
    *, channel: str, entries: list[tuple[DigestEntry, list[str]]], day: datetime, mode: DeliveryMode,
    suppression: list[tuple[str, int, int]] | None = None,
) -> NotificationIntent:
    lines = [_item_line(e, owners) for e, owners in entries[:30]] or ["Nothing above the routing threshold today."]
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
