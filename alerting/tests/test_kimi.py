"""Kimi analyzer runner tool-loop behavior."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from alerting.analyzer import AnalyzerError
from alerting.kimi import KimiCodeRunner, TransientTransportError, UrllibTransport


def tool_call(
    name: str, arguments: dict[str, Any], call_id: str = "call_1"
) -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(arguments),
                            },
                        }
                    ],
                }
            }
        ]
    }


def final(text: str = "done") -> dict[str, Any]:
    return {"choices": [{"message": {"role": "assistant", "content": text}}]}


class ScriptedTransport:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self._responses = list(responses)
        self.payloads: list[dict[str, Any]] = []

    def __call__(
        self, url: str, headers: dict[str, str], payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.payloads.append({**payload, "messages": list(payload["messages"])})
        return self._responses.pop(0)


class RecordingUrllibTransport(UrllibTransport):
    def __init__(self, response: dict[str, Any]) -> None:
        super().__init__()
        self.response = response
        self.timeout_seconds: float | None = None

    def __call__(
        self,
        url: str,
        headers: dict[str, str],
        payload: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        self.timeout_seconds = timeout_seconds
        return self.response


def tool_messages(transport: ScriptedTransport) -> list[str]:
    return [
        str(message["content"])
        for payload in transport.payloads
        for message in payload["messages"]
        if message.get("role") == "tool"
    ]


def test_runner_writes_report_and_terminates(tmp_path: Path) -> None:
    transport = ScriptedTransport(
        [
            tool_call(
                "Write", {"path": ".logs/ci_report.txt", "content": "report body"}
            ),
            final(),
        ]
    )

    KimiCodeRunner(api_key="key", transport=transport).run(tmp_path)

    assert (tmp_path / ".logs/ci_report.txt").read_text() == "report body"
    assert len(transport.payloads) == 2


def test_read_returns_file_contents(tmp_path: Path) -> None:
    (tmp_path / "note.txt").write_text("hello", encoding="utf-8")
    transport = ScriptedTransport(
        [
            tool_call("Read", {"path": "note.txt"}),
            final(),
        ]
    )

    KimiCodeRunner(api_key="key", transport=transport).run(tmp_path)

    assert tool_messages(transport) == ["hello"]


def test_file_tools_reject_paths_outside_the_workdir(tmp_path: Path) -> None:
    transport = ScriptedTransport(
        [
            tool_call("Write", {"path": "../escape.txt", "content": "nope"}),
            tool_call("Read", {"path": "/etc/hostname"}, call_id="call_2"),
            final(),
        ]
    )

    KimiCodeRunner(api_key="key", transport=transport).run(tmp_path)

    assert not (tmp_path.parent / "escape.txt").exists()
    messages = tool_messages(transport)
    assert all(message.startswith("error:") for message in messages)
    assert any("../escape.txt" in message for message in messages)
    assert any("/etc/hostname" in message for message in messages)


def test_bash_rejects_non_curl_commands(tmp_path: Path) -> None:
    marker = tmp_path / "marker.txt"
    marker.write_text("keep", encoding="utf-8")
    transport = ScriptedTransport(
        [
            tool_call("Bash", {"command": "rm marker.txt"}),
            final(),
        ]
    )

    KimiCodeRunner(api_key="key", transport=transport).run(tmp_path)

    assert marker.read_text() == "keep"
    assert tool_messages(transport) == ["error: only curl commands are allowed"]


def test_edit_replaces_one_exact_string(tmp_path: Path) -> None:
    (tmp_path / "report.txt").write_text("old value", encoding="utf-8")
    transport = ScriptedTransport(
        [
            tool_call(
                "Edit",
                {"path": "report.txt", "old_string": "old", "new_string": "new"},
            ),
            final(),
        ]
    )

    KimiCodeRunner(api_key="key", transport=transport).run(tmp_path)

    assert (tmp_path / "report.txt").read_text() == "new value"


def test_task_runs_one_nested_loop_that_cannot_spawn_task(tmp_path: Path) -> None:
    transport = ScriptedTransport(
        [
            tool_call("Task", {"prompt": "investigate"}),
            tool_call("Task", {"prompt": "deeper"}),
            final("nested result"),
            final(),
        ]
    )

    KimiCodeRunner(api_key="key", transport=transport).run(tmp_path)

    assert tool_messages(transport) == [
        "error: nested Task calls are not allowed",
        "nested result",
    ]


def test_max_turns_exhaustion_raises_analyzer_error(tmp_path: Path) -> None:
    def infinite(
        url: str, headers: dict[str, str], payload: dict[str, Any]
    ) -> dict[str, Any]:
        return tool_call("Glob", {"pattern": "*"})

    runner = KimiCodeRunner(api_key="key", transport=infinite, max_turns=2)

    with pytest.raises(AnalyzerError, match="exceeded 2 turns"):
        runner.run(tmp_path)


def test_history_pruning_elides_oldest_tool_outputs(tmp_path: Path) -> None:
    (tmp_path / "big.txt").write_text("x" * 40_000)
    responses = [
        tool_call("Read", {"path": "big.txt"}, call_id=f"c{index}")
        for index in range(50)
    ]
    responses.append(final())
    transport = ScriptedTransport(responses)

    KimiCodeRunner(api_key="key", transport=transport).run(tmp_path)

    tool_contents = [
        str(message["content"])
        for message in transport.payloads[-1]["messages"]
        if message.get("role") == "tool"
    ]
    assert any("(older tool output elided" in content for content in tool_contents)
    assert tool_contents[-1].startswith("x" * 100)
    total = sum(len(content) for content in tool_contents)
    assert total <= 1_500_000 + 40_000


def test_requests_carry_an_explicit_output_token_budget(tmp_path: Path) -> None:
    transport = ScriptedTransport([final()])

    KimiCodeRunner(api_key="key", transport=transport).run(tmp_path)

    assert transport.payloads[0]["max_tokens"] == 16_384


def test_requests_default_to_low_reasoning_effort(tmp_path: Path) -> None:
    transport = ScriptedTransport([final()])

    KimiCodeRunner(api_key="key", transport=transport).run(tmp_path)

    assert transport.payloads[0]["reasoning_effort"] == "low"


class FlakyTransport:
    """Scripted transport whose entries may be exceptions to raise."""

    def __init__(self, script: list[dict[str, Any] | Exception]) -> None:
        self._script = list(script)
        self.calls = 0

    def __call__(
        self, url: str, headers: dict[str, str], payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.calls += 1
        item = self._script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def test_transient_request_failures_are_retried_with_backoff(
    tmp_path: Path,
) -> None:
    transport = FlakyTransport(
        [
            TransientTransportError("kimi API request failed: timed out"),
            TransientTransportError("kimi API request failed: timed out"),
            final(),
        ]
    )
    sleeps: list[float] = []

    KimiCodeRunner(api_key="key", transport=transport, sleep=sleeps.append).run(
        tmp_path
    )

    assert transport.calls == 3
    assert sleeps == [5.0, 15.0]


def test_transient_failures_give_up_after_max_attempts(tmp_path: Path) -> None:
    transport = FlakyTransport(
        [TransientTransportError("kimi API request failed: timed out")] * 3
    )
    sleeps: list[float] = []
    runner = KimiCodeRunner(api_key="key", transport=transport, sleep=sleeps.append)

    with pytest.raises(AnalyzerError, match=r"timed out \(after 3 attempts\)"):
        runner.run(tmp_path)

    assert transport.calls == 3
    assert sleeps == [5.0, 15.0]


def test_permanent_request_failures_are_not_retried(tmp_path: Path) -> None:
    transport = FlakyTransport(
        [AnalyzerError("kimi API request failed with HTTP 400: bad request")]
    )
    sleeps: list[float] = []
    runner = KimiCodeRunner(api_key="key", transport=transport, sleep=sleeps.append)

    with pytest.raises(AnalyzerError, match="HTTP 400"):
        runner.run(tmp_path)

    assert transport.calls == 1
    assert sleeps == []


def test_retry_does_not_outlive_the_analysis_budget(tmp_path: Path) -> None:
    transport = FlakyTransport(
        [TransientTransportError("kimi API request failed: timed out"), final()]
    )
    sleeps: list[float] = []
    ticks = iter([0.0, 7.0, 7.0, 7.0])
    runner = KimiCodeRunner(
        api_key="key",
        transport=transport,
        sleep=sleeps.append,
        timeout_seconds=10,
        clock=lambda: next(ticks),
    )

    with pytest.raises(AnalyzerError, match="no time budget left to retry"):
        runner.run(tmp_path)

    assert transport.calls == 1
    assert sleeps == []


def test_model_request_timeout_is_clamped_to_remaining_analysis_budget(
    tmp_path: Path,
) -> None:
    ticks = iter((100.0, 100.0, 104.0))
    transport = RecordingUrllibTransport(final())
    runner = KimiCodeRunner(
        api_key="key",
        transport=transport,
        timeout_seconds=10,
        clock=lambda: next(ticks),
    )

    runner.run(tmp_path)

    assert transport.timeout_seconds == 6.0


def test_curl_timeout_is_clamped_to_remaining_analysis_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    observed_timeouts: list[float] = []

    def fake_run(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        observed_timeouts.append(kwargs["timeout"])
        return subprocess.CompletedProcess(args[0], 0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    ticks = iter((100.0, 100.0, 100.0, 106.0, 106.0, 106.0))
    transport = ScriptedTransport(
        [tool_call("Bash", {"command": "curl https://example.test"}), final()]
    )
    runner = KimiCodeRunner(
        api_key="key",
        transport=transport,
        timeout_seconds=10,
        clock=lambda: next(ticks),
    )

    runner.run(tmp_path)

    assert observed_timeouts == [4.0]


def test_urllib_transport_classifies_failures() -> None:
    import io
    import urllib.error
    import urllib.request
    from email.message import Message

    from alerting.kimi import UrllibTransport

    transport = UrllibTransport(timeout_seconds=1.0)

    def failing(error: Exception) -> Any:
        def opener(request: Any, timeout: float) -> Any:
            raise error

        return opener

    def call(monkey: Any) -> None:
        urllib.request.urlopen = monkey
        transport("https://example.invalid/v1/chat/completions", {}, {})

    original = urllib.request.urlopen
    try:
        with pytest.raises(TransientTransportError, match="timed out"):
            call(failing(TimeoutError("The read operation timed out")))
        with pytest.raises(TransientTransportError, match="HTTP 503"):
            call(
                failing(
                    urllib.error.HTTPError(
                        "u",
                        503,
                        "unavailable",
                        Message(),
                        io.BytesIO(b"busy"),
                    )
                )
            )
        with pytest.raises(AnalyzerError, match="HTTP 400") as info:
            call(
                failing(
                    urllib.error.HTTPError(
                        "u",
                        400,
                        "bad",
                        Message(),
                        io.BytesIO(b"bad"),
                    )
                )
            )
        assert not isinstance(info.value, TransientTransportError)
    finally:
        urllib.request.urlopen = original
