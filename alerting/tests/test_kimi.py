"""Kimi analyzer runner tool-loop behavior."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from alerting.analyzer import AnalyzerError
from alerting.kimi import KimiCodeRunner


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
