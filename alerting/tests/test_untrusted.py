"""Model-written text made safe for Slack and the dashboard."""

from __future__ import annotations

import pytest

from alerting.untrusted import pull_request_number, safe_slack_mrkdwn, trusted_url


def test_trusted_links_and_formatting_survive() -> None:
    text = (
        "*Build:* <https://buildkite.com/vllm/ci/builds/97000|#97000> ❌\n"
        "• _suspicious: <https://github.com/vllm-project/vllm/pull/123|PR #123>_"
    )
    assert safe_slack_mrkdwn(text) == text


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("<!channel> CI is broken", "!channel CI is broken"),
        ("ping <@U123ABC>", "ping @U123ABC"),
        ("<https://evil.example/x|PR #123>", "PR #123 (https://evil.example/x)"),
        (
            "<https://github.com/evil/repo/pull/1|PR #1>",
            "PR #1 (https://github.com/evil/repo/pull/1)",
        ),
        (
            "<http://github.com/vllm-project/vllm/pull/1|PR #1>",
            "PR #1 (http://github.com/vllm-project/vllm/pull/1)",
        ),
        ("x < 5 && y > 2", "x &lt; 5 &amp;&amp; y &gt; 2"),
    ],
)
def test_untrusted_links_mentions_and_brackets_are_neutralized(
    text: str, expected: str
) -> None:
    assert safe_slack_mrkdwn(text) == expected


def test_trusted_url_and_pull_request_number() -> None:
    assert trusted_url("https://ci.vllm.ai/alerts")
    assert not trusted_url("https://github.com.evil.example/vllm-project/x")
    assert not trusted_url("https://user@github.com/vllm-project/x")
    assert not trusted_url("javascript:alert(1)")
    assert (
        pull_request_number("https://github.com/vllm-project/vllm/pull/63609") == 63609
    )
    assert pull_request_number("https://github.com/vllm-project/vllm/issues/1") is None
    assert pull_request_number("https://github.com/someone/vllm/pull/1") is None
