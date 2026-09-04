"""Production Slack delivery adapter for notification outbox records."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping, Protocol
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from alerting.ports import (
    DestinationMode,
    NotificationIntentRecord,
    SlackPermanentError,
    SlackTransientError,
)

CHAT_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage"
CHAT_UPDATE_URL = "https://slack.com/api/chat.update"
_TRANSIENT_API_ERRORS = {
    "fatal_error",
    "internal_error",
    "org_login_required",
    "rate_limited",
    "ratelimited",
    "request_timeout",
    "service_unavailable",
}


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


class HttpTransport(Protocol):
    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
    ) -> HttpResponse: ...


class UrllibHttpTransport:
    """Small JSON POST transport using Python's standard library."""

    def __init__(self, *, timeout_seconds: float = 10.0) -> None:
        self._timeout_seconds = timeout_seconds

    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
    ) -> HttpResponse:
        request = Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=dict(headers),
            method="POST",
        )
        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                return HttpResponse(
                    status=response.status,
                    headers=dict(response.headers.items()),
                    body=response.read(),
                )
        except HTTPError as exc:
            return HttpResponse(
                status=exc.code,
                headers=dict(exc.headers.items()) if exc.headers is not None else {},
                body=exc.read(),
            )


class SlackDeliveryPort:
    """Deliver outbox records through configured Slack destinations."""

    def __init__(
        self,
        *,
        bot_token: str | None,
        webhook_urls: Mapping[str, str],
        http: HttpTransport | None = None,
    ) -> None:
        self._bot_token = bot_token
        self._webhook_urls = dict(webhook_urls)
        self._http = http or UrllibHttpTransport()

    def deliver(self, record: NotificationIntentRecord) -> str | None:
        if record.destination_mode is DestinationMode.WEBHOOK:
            self._deliver_webhook(record)
            return None
        return self._deliver_bot_message(record)

    def _deliver_webhook(self, record: NotificationIntentRecord) -> None:
        webhook_url = self._webhook_urls.get(record.destination)
        if not webhook_url:
            raise SlackPermanentError(
                f"Slack webhook destination is not configured: {record.destination}"
            )
        response = self._http.post(
            webhook_url,
            headers={"Content-Type": "application/json; charset=utf-8"},
            payload=_delivery_payload(record),
        )
        _raise_for_http_failure(response)
        if response.body != b"ok":
            raise SlackPermanentError("Slack webhook rejected message")

    def _deliver_bot_message(self, record: NotificationIntentRecord) -> str | None:
        if not self._bot_token:
            raise SlackPermanentError("Slack bot token is not configured")

        payload = _delivery_payload(record)
        payload["channel"] = record.destination
        response = self._http.post(
            CHAT_POST_MESSAGE_URL,
            headers={
                "Authorization": f"Bearer {self._bot_token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            payload=payload,
        )
        _raise_for_http_failure(response)
        try:
            result = json.loads(response.body)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise SlackTransientError("Slack returned an invalid response") from exc
        if not isinstance(result, dict):
            raise SlackTransientError("Slack returned an invalid response")
        if result.get("ok") is not True:
            error = str(result.get("error", "unknown_error"))
            if error in _TRANSIENT_API_ERRORS:
                raise SlackTransientError(
                    f"Slack could not deliver message: {error}",
                    retry_after=_retry_after(response.headers),
                )
            raise SlackPermanentError(f"Slack rejected message: {error}")
        slack_ts = result.get("ts")
        return slack_ts if isinstance(slack_ts, str) else None

    def update_message(
        self, *, channel: str, ts: str, payload: Mapping[str, Any]
    ) -> None:
        """Edit a message the bot posted earlier (chat.update)."""
        if not self._bot_token:
            raise SlackPermanentError("Slack bot token is not configured")

        response = self._http.post(
            CHAT_UPDATE_URL,
            headers={
                "Authorization": f"Bearer {self._bot_token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            payload={"channel": channel, "ts": ts, **payload},
        )
        _raise_for_http_failure(response)
        try:
            result = json.loads(response.body)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise SlackTransientError("Slack returned an invalid response") from exc
        if not isinstance(result, dict):
            raise SlackTransientError("Slack returned an invalid response")
        if result.get("ok") is not True:
            error = str(result.get("error", "unknown_error"))
            if error in _TRANSIENT_API_ERRORS:
                raise SlackTransientError(
                    f"Slack could not update message: {error}",
                    retry_after=_retry_after(response.headers),
                )
            raise SlackPermanentError(f"Slack rejected update: {error}")


def _raise_for_http_failure(response: HttpResponse) -> None:
    if 200 <= response.status < 300:
        return
    diagnostic = response.body.decode("utf-8", errors="replace")[:200]
    if response.status == 429:
        raise SlackTransientError(
            f"Slack rate limited delivery: {diagnostic}",
            retry_after=_retry_after(response.headers),
        )
    if response.status == 408 or response.status >= 500:
        raise SlackTransientError(
            f"Slack delivery failed with HTTP {response.status}: {diagnostic}"
        )
    raise SlackPermanentError(
        f"Slack rejected delivery with HTTP {response.status}: {diagnostic}"
    )


def _delivery_payload(record: NotificationIntentRecord) -> dict[str, Any]:
    payload = dict(record.payload)
    payload["metadata"] = {
        "event_type": "vllm_alert_delivery",
        "event_payload": {"delivery_id": record.delivery_id},
    }
    return payload


def _retry_after(headers: Mapping[str, str]) -> float | None:
    for name, value in headers.items():
        if name.lower() == "retry-after":
            try:
                return float(value)
            except ValueError:
                return None
    return None
