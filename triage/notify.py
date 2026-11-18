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
from triage.store import DigestEntry

DASHBOARD = "https://ci.vllm.ai/triage"
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


def describe_reason(raw: str) -> str:
    """Router reason codes in plain words, matching the dashboard."""
    if m := re.fullmatch(r"authored #(\d+)", raw):
        return f"you wrote #{m.group(1)}, which this item names"
    if raw == "commented":
        return "you already commented on it"
    if m := re.fullmatch(r"relevance:(high|medium)(?: \(like (.+)\))?", raw):
        like = f" (like {m.group(2)})" if m.group(2) else ""
        return f"judged {m.group(1)} from your recent work{like}"
    if m := re.fullmatch(r"(area|hardware|model|path|keyword):(.+)", raw):
        return f"your rule: {m.group(1)} {m.group(2)}"
    return raw


def _item_line(entry: DigestEntry, owners: list[str] | None = None) -> str:
    icon = _BAND_ICON.get(entry.band, "")
    number = entry.item_key.rsplit("#", 1)[-1]
    level = BAND_LABELS.get(entry.band, "")
    parts = [f"{icon} *{level}* · {entry.score} {_link(entry.html_url, f'#{number} {entry.title}')}".replace("  ", " ")]
    if entry.summary:
        parts.append(f"   _{safe_slack_mrkdwn(entry.summary[:240])}_")
    detail = []
    if entry.matched:
        why = "; ".join(_pr_links(safe_slack_mrkdwn(describe_reason(m))) for m in entry.matched[:3])
        detail.append(f"why you: {why}")
    if owners is not None:
        detail.append("owner: " + (", ".join(safe_slack_mrkdwn(o) for o in owners) if owners else "*unrouted*"))
    if detail:
        parts.append("   " + " · ".join(detail))
    return "\n".join(parts)


def _item_section(entry: DigestEntry, *, menu: bool) -> dict[str, Any]:
    """One item as a section; digest lines get an overflow menu (Ack / Not mine / Open)."""
    block: dict[str, Any] = {
        "type": "section",
        "block_id": f"triage:item:{entry.item_key}",
        "text": {"type": "mrkdwn", "text": _item_line(entry)[:2900]},
    }
    if menu:
        block["accessory"] = {
            "type": "overflow",
            "action_id": "triage:menu",
            "options": [
                {"text": {"type": "plain_text", "text": "Ack"}, "value": f"ack|{entry.item_key}"},
                {"text": {"type": "plain_text", "text": "Not mine"}, "value": f"not_mine|{entry.item_key}"},
                {"text": {"type": "plain_text", "text": "Open in dashboard"}, "value": "open",
                 "url": _item_url(entry.item_key)},
            ],
        }
    return block


def _actions(entry: DigestEntry, reassign_to: list[str]) -> dict[str, Any]:
    """Ack / Not mine / Reassign / Open under a single-item DM. The click is
    handled by the dashboard (/api/triage/slack/interactions), which checks
    the request is signed by Slack and that the clicker owns the item."""
    elements: list[dict[str, Any]] = [
        {"type": "button", "action_id": "triage:ack", "style": "primary",
         "text": {"type": "plain_text", "text": "Ack"}, "value": entry.item_key},
        {"type": "button", "action_id": "triage:not_mine",
         "text": {"type": "plain_text", "text": "Not mine"}, "value": entry.item_key},
    ]
    if reassign_to:
        elements.append({
            "type": "static_select",
            "action_id": "triage:reassign",
            "placeholder": {"type": "plain_text", "text": "Reassign to…"},
            "options": [{"text": {"type": "plain_text", "text": login[:75]}, "value": login}
                        for login in sorted(reassign_to, key=str.lower)[:100]],
        })
    elements.append({"type": "button", "action_id": "triage:open", "url": _item_url(entry.item_key),
                     "text": {"type": "plain_text", "text": "Open in dashboard"}})
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
    reassign_to: list[str] | None = None,
) -> NotificationIntent:
    header = "Triage: P0 item for you" if role == "primary" else "Triage: you are backup on a P0 item"
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
                _item_section(entry, menu=False),
                _actions(entry, reassign_to or []),
            ],
            "unfurl_links": False,
            "unfurl_media": False,
        },
    )


def maintainer_digest(
    *, maintainer: str, maintainer_slack: str, entries: list[DigestEntry], day: datetime, mode: DeliveryMode
) -> NotificationIntent:
    header = f"Triage: {len(entries)} new item{'s' if len(entries) != 1 else ''} for you"
    return NotificationIntent(
        delivery_id=f"triage:digest:{maintainer}:{day.date().isoformat()}",
        alert_ref=f"digest:{maintainer}",
        alert_path=AlertPath.TRIAGE,
        delivery_mode=mode,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination=maintainer_slack,
        payload={
            "text": header,
            "blocks": [
                {"type": "header", "text": {"type": "plain_text", "text": header[:150]}},
                *[_item_section(e, menu=True) for e in entries[:25]],
                {"type": "context", "elements": [{"type": "mrkdwn",
                    "text": f"Use ⋮ on an item to ack it or say it's not yours. Everything is on <{DASHBOARD}/me|My plate>."}]},
            ],
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
