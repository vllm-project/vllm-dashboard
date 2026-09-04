"""Contract tests for configured Slack webhook and bot-token delivery."""

from datetime import datetime, timezone
from typing import Any, Mapping

import pytest

from alerting.ports import (
    AlertPath,
    DeliveryMode,
    DestinationMode,
    NotificationIntentRecord,
    OutboxStatus,
    SlackPermanentError,
    SlackTransientError,
)
from alerting.slack import HttpResponse, SlackDeliveryPort

NOW = datetime(2026, 8, 27, 19, 0, tzinfo=timezone.utc)


class StubHttpTransport:
    def __init__(self, response: HttpResponse) -> None:
        self.response = response
        self.requests: list[tuple[str, Mapping[str, str], dict[str, Any]]] = []

    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
    ) -> HttpResponse:
        self.requests.append((url, headers, dict(payload)))
        return self.response


def make_record(
    *, mode: DestinationMode, destination: str = "C0ANHBE642Y"
) -> NotificationIntentRecord:
    return NotificationIntentRecord(
        delivery_id="fast-ci:batch-1",
        alert_ref="fast_failure_event:12345",
        alert_path=AlertPath.FAST_CI,
        delivery_mode=DeliveryMode.LIVE,
        destination_mode=mode,
        destination=destination,
        payload={"text": "8 jobs failed within 30s"},
        status=OutboxStatus.PENDING,
        attempts=1,
        next_attempt_at=NOW,
    )


def test_bot_token_delivery_returns_slack_timestamp() -> None:
    http = StubHttpTransport(
        HttpResponse(
            status=200,
            headers={},
            body=b'{"ok":true,"ts":"1724900000.001"}',
        )
    )
    slack = SlackDeliveryPort(bot_token="xoxb-secret", webhook_urls={}, http=http)

    slack_ts = slack.deliver(make_record(mode=DestinationMode.BOT_TOKEN))

    assert slack_ts == "1724900000.001"
    url, headers, payload = http.requests[0]
    assert url == "https://slack.com/api/chat.postMessage"
    assert headers["Authorization"] == "Bearer xoxb-secret"
    assert payload == {
        "text": "8 jobs failed within 30s",
        "channel": "C0ANHBE642Y",
        "metadata": {
            "event_type": "vllm_alert_delivery",
            "event_payload": {"delivery_id": "fast-ci:batch-1"},
        },
    }


def test_webhook_delivery_resolves_logical_destination_without_storing_secret() -> None:
    http = StubHttpTransport(HttpResponse(status=200, headers={}, body=b"ok"))
    slack = SlackDeliveryPort(
        bot_token=None,
        webhook_urls={"fast-ci": "https://hooks.slack.com/services/secret"},
        http=http,
    )

    slack_ts = slack.deliver(
        make_record(mode=DestinationMode.WEBHOOK, destination="fast-ci")
    )

    assert slack_ts is None
    url, headers, payload = http.requests[0]
    assert url == "https://hooks.slack.com/services/secret"
    assert "Authorization" not in headers
    assert payload == {
        "text": "8 jobs failed within 30s",
        "metadata": {
            "event_type": "vllm_alert_delivery",
            "event_payload": {"delivery_id": "fast-ci:batch-1"},
        },
    }


def test_rate_limit_exposes_slack_retry_after() -> None:
    http = StubHttpTransport(
        HttpResponse(status=429, headers={"Retry-After": "120"}, body=b"ratelimited")
    )
    slack = SlackDeliveryPort(bot_token="xoxb-secret", webhook_urls={}, http=http)

    with pytest.raises(SlackTransientError) as raised:
        slack.deliver(make_record(mode=DestinationMode.BOT_TOKEN))

    assert raised.value.retry_after == 120.0


def test_slack_internal_error_is_transient() -> None:
    http = StubHttpTransport(
        HttpResponse(
            status=200,
            headers={},
            body=b'{"ok":false,"error":"internal_error"}',
        )
    )
    slack = SlackDeliveryPort(bot_token="xoxb-secret", webhook_urls={}, http=http)

    with pytest.raises(SlackTransientError, match="internal_error"):
        slack.deliver(make_record(mode=DestinationMode.BOT_TOKEN))


def test_http_request_timeout_is_transient() -> None:
    http = StubHttpTransport(
        HttpResponse(status=408, headers={}, body=b"request_timeout")
    )
    slack = SlackDeliveryPort(bot_token="xoxb-secret", webhook_urls={}, http=http)

    with pytest.raises(SlackTransientError, match="408"):
        slack.deliver(make_record(mode=DestinationMode.BOT_TOKEN))


@pytest.mark.parametrize(
    ("mode", "destination", "expected_error"),
    [
        (DestinationMode.BOT_TOKEN, "C0ANHBE642Y", "bot token"),
        (DestinationMode.WEBHOOK, "full-ci", "full-ci"),
    ],
)
def test_missing_destination_configuration_is_permanent(
    mode: DestinationMode, destination: str, expected_error: str
) -> None:
    http = StubHttpTransport(HttpResponse(status=200, headers={}, body=b"ok"))
    slack = SlackDeliveryPort(bot_token=None, webhook_urls={}, http=http)

    with pytest.raises(SlackPermanentError, match=expected_error):
        slack.deliver(make_record(mode=mode, destination=destination))

    assert http.requests == []


@pytest.mark.parametrize(
    ("mode", "status", "body", "expected_error"),
    [
        (
            DestinationMode.BOT_TOKEN,
            200,
            b'{"ok":false,"error":"invalid_blocks"}',
            "invalid_blocks",
        ),
        (DestinationMode.WEBHOOK, 400, b"invalid_payload", "invalid_payload"),
    ],
)
def test_invalid_slack_payload_is_permanent(
    mode: DestinationMode, status: int, body: bytes, expected_error: str
) -> None:
    http = StubHttpTransport(HttpResponse(status=status, headers={}, body=body))
    slack = SlackDeliveryPort(
        bot_token="xoxb-secret",
        webhook_urls={"fast-ci": "https://hooks.slack.com/services/secret"},
        http=http,
    )
    destination = "fast-ci" if mode is DestinationMode.WEBHOOK else "C0ANHBE642Y"

    with pytest.raises(SlackPermanentError, match=expected_error):
        slack.deliver(make_record(mode=mode, destination=destination))


def test_update_message_posts_to_chat_update_with_channel_and_ts() -> None:
    http = StubHttpTransport(
        HttpResponse(status=200, headers={}, body=b'{"ok":true}')
    )
    slack = SlackDeliveryPort(bot_token="xoxb-secret", webhook_urls={}, http=http)

    slack.update_message(
        channel="C0ANHBE642Y",
        ts="1724900000.001",
        payload={"text": "alert\n\nresolved"},
    )

    url, headers, payload = http.requests[0]
    assert url == "https://slack.com/api/chat.update"
    assert headers["Authorization"] == "Bearer xoxb-secret"
    assert payload == {
        "channel": "C0ANHBE642Y",
        "ts": "1724900000.001",
        "text": "alert\n\nresolved",
    }


def test_update_message_rejection_is_permanent() -> None:
    http = StubHttpTransport(
        HttpResponse(
            status=200, headers={}, body=b'{"ok":false,"error":"message_not_found"}'
        )
    )
    slack = SlackDeliveryPort(bot_token="xoxb-secret", webhook_urls={}, http=http)

    with pytest.raises(SlackPermanentError, match="message_not_found"):
        slack.update_message(
            channel="C0ANHBE642Y", ts="1724900000.001", payload={"text": "x"}
        )
