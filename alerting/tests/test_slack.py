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
from alerting.slack import (
    HttpResponse,
    SlackDeliveryPort,
    headed_payload,
    resolved_edit,
)

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


def _header(text: str) -> dict[str, Any]:
    return {
        "type": "header",
        "text": {"type": "plain_text", "text": text, "emoji": True},
    }


def _section(text: str) -> dict[str, Any]:
    return {"type": "section", "text": {"type": "mrkdwn", "text": text}}


def test_headed_payload_lifts_the_bold_first_line_into_a_plain_header() -> None:
    text = (
        ":rotating_light: *Infra alert* — GPU 3 on `h200_ci-4` at 89&lt;C"
        " <https://ci.vllm.ai/x|details> ~now~\n"
        "\n"
        "Last seen 21:40 UTC"
    )

    assert headed_payload(text, source="INFRA", icon="🖥️") == {
        "text": text,
        "blocks": [
            _header("🖥️ INFRA · GPU 3 on h200_ci-4 at 89<C details now"),
            _section("Last seen 21:40 UTC"),
        ],
    }


def test_headed_payload_marks_a_resolved_line_with_a_check() -> None:
    payload = headed_payload(
        ":white_check_mark: *Quarantine* — h1 is back in service",
        source="QUARANTINE",
        icon="🚧",
    )
    assert payload["blocks"] == [_header("✅ QUARANTINE · h1 is back in service")]


def test_headed_payload_keeps_a_line_without_a_bold_label_whole() -> None:
    payload = headed_payload("plain first line\nbody", source="FAST CI", icon="⚡")
    assert payload["blocks"] == [
        _header("⚡ FAST CI · plain first line"),
        _section("body"),
    ]


def test_headed_payload_cuts_a_long_header_and_keeps_the_full_line_below() -> None:
    first = ":eyes: *Quarantine (dry run)* — would quarantine h1: " + "x" * 200
    payload = headed_payload(f"{first}\nbody", source="QUARANTINE", icon="🚧")

    header = payload["blocks"][0]["text"]["text"]
    assert len(header) == 150
    assert header.startswith("🚧 QUARANTINE · would quarantine h1: xxx")
    assert header.endswith("x…")
    assert payload["blocks"][1:] == [_section(f"{first}\nbody")]


def test_headed_payload_splits_a_body_over_the_section_limit_at_lines() -> None:
    lines = ["a" * 1000, "b" * 1000, "c" * 998, "d" * 10]
    payload = headed_payload(
        "*x* — head\n" + "\n".join(lines), source="FAST CI", icon="⚡"
    )
    assert [block["text"]["text"] for block in payload["blocks"][1:]] == [
        "\n".join(lines[:3]),
        lines[3],
    ]


def test_headed_payload_cuts_a_single_line_over_the_section_limit() -> None:
    payload = headed_payload("head\n" + "z" * 3001, source="FAST CI", icon="⚡")
    assert [len(block["text"]["text"]) for block in payload["blocks"][1:]] == [
        3000,
        1,
    ]


def test_resolved_edit_strikes_each_section_line_and_checks_the_header() -> None:
    payload = headed_payload(
        ":rotating_light: *Infra alert* — host h1 stopped reporting\n"
        "Last report 21:40\n"
        "\n"
        "Runbook",
        source="INFRA",
        icon="🖥️",
    )

    assert resolved_edit(payload) == {
        "text": ":white_check_mark: ~:rotating_light: *Infra alert* — host h1"
        " stopped reporting~\n~Last report 21:40~\n\n~Runbook~",
        "blocks": [
            _header("✅ INFRA · Resolved: host h1 stopped reporting"),
            _section("~Last report 21:40~\n\n~Runbook~"),
        ],
    }


def test_resolved_edit_of_a_text_only_message_stays_text_only() -> None:
    assert resolved_edit({"text": "line one\nline two"}) == {
        "text": ":white_check_mark: ~line one~\n~line two~"
    }


def test_header_and_first_line_at_exactly_the_limit_stay_whole() -> None:
    title = "🖥️ INFRA · " + "x" * (150 - len("🖥️ INFRA · "))
    assert len(title) == 150
    payload = headed_payload(
        f"*Infra alert* — {title.split(' · ', 1)[1]}\nbody",
        source="INFRA",
        icon="🖥️",
    )
    assert payload["blocks"] == [_header(title), _section("body")]


def test_a_long_line_after_a_short_one_starts_its_own_sections() -> None:
    payload = headed_payload("head\nshort\n" + "z" * 3001, source="X", icon="⚡")
    assert [block["text"]["text"] for block in payload["blocks"][1:]] == [
        "short",
        "z" * 3000,
        "z",
    ]


def test_body_edges_keep_their_own_characters() -> None:
    payload = headed_payload("head\n\nXX ends in X\n", source="X", icon="⚡")
    assert payload["blocks"][1:] == [_section("XX ends in X")]


def test_resolved_edit_without_text_or_header_stays_text_only() -> None:
    assert resolved_edit({}) == {"text": ":white_check_mark: "}
    assert resolved_edit({"text": "t", "blocks": [_section("t")]}) == {
        "text": ":white_check_mark: ~t~"
    }


def test_resolved_edit_checks_a_header_with_no_icon() -> None:
    edit = resolved_edit({"text": "t", "blocks": [_header("ALERT")]})
    assert edit["blocks"] == [_header("✅ ALERT")]
