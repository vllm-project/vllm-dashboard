"""Slack payloads for triage: an immediate DM for page-band items, a daily
DM digest per maintainer, and a daily team-channel digest.

Titles and summaries are untrusted (GitHub text and model output) and go
through alerting.untrusted.safe_slack_mrkdwn, which strips mentions and
non-vLLM links.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from alerting.ports import AlertPath, DeliveryMode, DestinationMode, NotificationIntent
from alerting.untrusted import safe_slack_mrkdwn, trusted_url

from triage.store import DigestEntry

DASHBOARD = "https://ci.vllm.ai/triage"
_BAND_ICON = {"page": ":rotating_light:", "route": ":large_orange_diamond:", "watch": ":small_blue_diamond:"}


def _link(url: str, text: str) -> str:
    label = safe_slack_mrkdwn(text.replace("|", "/")[:150])
    return f"<{url}|{label}>" if trusted_url(url) else label


def _item_line(entry: DigestEntry, owners: list[str] | None = None) -> str:
    icon = _BAND_ICON.get(entry.band, "")
    number = entry.item_key.rsplit("#", 1)[-1]
    parts = [f"{icon} *{entry.score}* {_link(entry.html_url, f'#{number} {entry.title}')}"]
    if entry.summary:
        parts.append(f"   _{safe_slack_mrkdwn(entry.summary[:240])}_")
    detail = []
    if entry.matched:
        detail.append("matched " + ", ".join(safe_slack_mrkdwn(m) for m in entry.matched[:4]))
    if owners is not None:
        detail.append("owner: " + (", ".join(safe_slack_mrkdwn(o) for o in owners) if owners else "*unrouted*"))
    if detail:
        parts.append("   " + " · ".join(detail))
    return "\n".join(parts)


def _payload(header: str, lines: list[str], footer: str) -> dict[str, Any]:
    body = "\n\n".join(lines)
    # Slack caps a section at 3000 chars; split long digests across sections.
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
    *, assignment_key: str, maintainer_slack: str, entry: DigestEntry, role: str, mode: DeliveryMode
) -> NotificationIntent:
    header = "Triage: high-impact item for you" if role == "primary" else "Triage: you are backup on a high-impact item"
    return NotificationIntent(
        delivery_id=f"triage:page:{assignment_key}",
        alert_ref=entry.item_key,
        alert_path=AlertPath.TRIAGE,
        delivery_mode=mode,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination=maintainer_slack,
        payload=_payload(
            header,
            [_item_line(entry)],
            f"Ack, reassign or mark not mine on <{DASHBOARD}/me|My plate>.",
        ),
    )


def maintainer_digest(
    *, maintainer: str, maintainer_slack: str, entries: list[DigestEntry], day: datetime, mode: DeliveryMode
) -> NotificationIntent:
    return NotificationIntent(
        delivery_id=f"triage:digest:{maintainer}:{day.date().isoformat()}",
        alert_ref=f"digest:{maintainer}",
        alert_path=AlertPath.TRIAGE,
        delivery_mode=mode,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination=maintainer_slack,
        payload=_payload(
            f"Triage: {len(entries)} new item{'s' if len(entries) != 1 else ''} for you",
            [_item_line(e) for e in entries[:25]],
            f"Full list and actions on <{DASHBOARD}/me|My plate>.",
        ),
    )


def team_digest(
    *, channel: str, entries: list[tuple[DigestEntry, list[str]]], day: datetime, mode: DeliveryMode
) -> NotificationIntent:
    lines = [_item_line(e, owners) for e, owners in entries[:30]] or ["Nothing above the routing threshold today."]
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
