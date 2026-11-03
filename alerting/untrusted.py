"""Make model-written text safe to show: links only to our own places, no
Slack mentions.

The analyzers read CI logs and GitHub content that anyone can influence, so
what they write is untrusted. These helpers run on it before it reaches
Slack or the dashboard.
"""

from __future__ import annotations

import html
import re
from urllib.parse import urlsplit

_TRUSTED_PREFIXES = (
    ("github.com", "/vllm-project/"),
    ("buildkite.com", "/vllm/"),
    ("ci.vllm.ai", "/"),
)
_SLACK_ANGLE = re.compile(r"<([^<>\n]*)>")
_PR_PATH = re.compile(r"^/vllm-project/[\w.-]+/pull/(\d+)/?$")


def trusted_url(url: str) -> bool:
    """An https link into vLLM's GitHub org, its Buildkite org, or the
    dashboard."""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return False
    if parts.scheme != "https" or parts.username or parts.password:
        return False
    host = (parts.hostname or "").lower()
    return any(
        host == trusted_host and (parts.path or "/").startswith(prefix)
        for trusted_host, prefix in _TRUSTED_PREFIXES
    )


def pull_request_number(url: str) -> int | None:
    """The number of a vllm-project pull request URL, else None."""
    if not trusted_url(url):
        return None
    match = _PR_PATH.match(urlsplit(url.strip()).path)
    return int(match.group(1)) if match else None


def safe_slack_mrkdwn(text: str) -> str:
    """Keep the model's Slack formatting, minus what can mislead or ping.

    `<url|label>` links stay when the URL is trusted; any other link becomes
    plain text that shows its real URL. Mentions (`<!channel>`, `<@U…>`,
    `<#C…>`) lose their brackets so they render as text. Every other `<`,
    `>` and `&` is escaped.
    """
    out: list[str] = []
    last = 0
    for match in _SLACK_ANGLE.finditer(text):
        out.append(html.escape(text[last : match.start()], quote=False))
        inner = match.group(1)
        url, _, label = inner.partition("|")
        if inner[:1] in ("!", "@", "#"):
            out.append(html.escape(inner, quote=False))
        elif "://" not in url and not url.startswith("mailto:"):
            # Not a link at all, e.g. "x < 5 and y > 2".
            out.append(html.escape(match.group(0), quote=False))
        elif trusted_url(url):
            out.append(
                f"<{url}|{html.escape(label, quote=False)}>" if label else f"<{url}>"
            )
        else:
            shown = f"{label} ({url})" if label else url
            out.append(html.escape(shown, quote=False))
        last = match.end()
    out.append(html.escape(text[last:], quote=False))
    return "".join(out)
