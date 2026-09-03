"""Full CI analyzer runner backed by the Kimi K3 chat-completions API.

`KimiCodeRunner` replaces the Claude Code CLI invocation: it runs bundled
analyzer instructions (by default `assets/vllm-ci-failure-analyzer.md`,
frontmatter stripped) as the system message and drives an OpenAI-compatible
tool-calling loop. File tools are sandboxed to the materialized working
directory and the shell tool only executes `curl`, so credentials stay in the
server-side environment. Tool failures are returned to the model as tool
messages so it can recover; only transport failures, turn exhaustion, or the
overall time budget raise `AnalyzerError`, which leaves the previous baseline
authoritative. Slices other than Full CI pass their own instructions and task
prompt to `run`.
"""

from __future__ import annotations

import importlib.resources
import json
import re
import shlex
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

from alerting.analyzer import AnalyzerError

KIMI_ANALYZER_PROMPT = (
    "Run CI failure analysis. Read .logs/nightly_summary.json and execute "
    "all phases (A through D) from the instructions. Read "
    ".logs/nightly_full.json only for Buildkite job ID lookups. Write "
    ".logs/ci_report.txt and keep it at or below 2800 characters, and update "
    ".logs/failed_tests_cache.json and .logs/suspicious_prs.json. "
    "Credentials are available only through the environment; never include "
    "their values in prompts, files, or output. REVERT_THRESHOLD is "
    "available in the environment (default 1)."
)

DEFAULT_INSTRUCTIONS_ASSET = "assets/vllm-ci-failure-analyzer.md"

READ_CHAR_LIMIT = 40_000
GLOB_RESULT_LIMIT = 200
GREP_RESULT_LIMIT = 200
BASH_OUTPUT_LIMIT = 40_000
BASH_TIMEOUT_SECONDS = 60
TASK_RESULT_LIMIT = 50_000
REQUEST_TIMEOUT_SECONDS = 300.0
# The inferact endpoint counts unset output budget as zero and rejects the
# request when the prompt alone approaches the context window.
MAX_OUTPUT_TOKENS = 16_384

# Rough budget for the running conversation: ~4 chars per token against a
# 1M-token context, minus headroom for system prompt, tools, and output.
# When exceeded, the oldest tool outputs are elided (pairing with their
# tool_calls stays intact; only the bulky content goes).
HISTORY_CHAR_BUDGET = 1_500_000
_ELIDED = "(older tool output elided to fit the context window)"


def _prune_history(messages: list[dict[str, Any]]) -> None:
    def total_chars() -> int:
        return sum(len(str(message.get("content") or "")) for message in messages)

    total = total_chars()
    if total <= HISTORY_CHAR_BUDGET:
        return
    for message in messages[2:]:  # system and user prompt always stay
        if total <= HISTORY_CHAR_BUDGET:
            return
        content = message.get("content")
        if (
            message.get("role") == "tool"
            and isinstance(content, str)
            and len(content) > len(_ELIDED)
        ):
            total -= len(content) - len(_ELIDED)
            message["content"] = _ELIDED

Transport = Callable[[str, dict[str, str], dict[str, Any]], dict[str, Any]]

_STRING = {"type": "string"}
_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "Read",
            "description": "Read a UTF-8 text file inside the working directory.",
            "parameters": {
                "type": "object",
                "properties": {"path": _STRING},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Write",
            "description": "Write a file inside the working directory.",
            "parameters": {
                "type": "object",
                "properties": {"path": _STRING, "content": _STRING},
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Edit",
            "description": "Replace one exact unique string in a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": _STRING,
                    "old_string": _STRING,
                    "new_string": _STRING,
                },
                "required": ["path", "old_string", "new_string"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Glob",
            "description": "List files under the working directory by pattern.",
            "parameters": {
                "type": "object",
                "properties": {"pattern": _STRING},
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Grep",
            "description": "Regex-search files under the working directory.",
            "parameters": {
                "type": "object",
                "properties": {"pattern": _STRING, "path": _STRING},
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Bash",
            "description": "Run a curl command; all other commands are rejected.",
            "parameters": {
                "type": "object",
                "properties": {"command": _STRING},
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Task",
            "description": (
                "Run a nested read-only investigation with the same tools "
                "and return its final text."
            ),
            "parameters": {
                "type": "object",
                "properties": {"prompt": _STRING},
                "required": ["prompt"],
            },
        },
    },
]
_TASK_TOOLS = [tool for tool in _TOOLS if tool["function"]["name"] != "Task"]


class UrllibTransport:
    """JSON POST transport for the Kimi API using Python's standard library."""

    def __init__(self, *, timeout_seconds: float = REQUEST_TIMEOUT_SECONDS) -> None:
        self._timeout_seconds = timeout_seconds

    def __call__(
        self,
        url: str,
        headers: dict[str, str],
        payload: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        timeout = self._timeout_seconds
        if timeout_seconds is not None:
            timeout = min(timeout, timeout_seconds)
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as resp:
                result: Any = json.load(resp)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise AnalyzerError(
                f"kimi API request failed with HTTP {exc.code}: {body[:1000]}"
            ) from exc
        except (OSError, TimeoutError, json.JSONDecodeError) as exc:
            raise AnalyzerError(f"kimi API request failed: {exc}") from exc
        if not isinstance(result, dict):
            raise AnalyzerError("kimi API returned a malformed response")
        return result


class KimiCodeRunner:
    """Runs the analyzer instructions through the Kimi tool-calling API."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://api2.inferact.dev/v1",
        model: str = "moonshotai/Kimi-K3",
        timeout_seconds: int = 3600,
        max_turns: int = 200,
        reasoning_effort: str = "low",
        transport: Transport | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._timeout_seconds = timeout_seconds
        self._max_turns = max_turns
        self._reasoning_effort = reasoning_effort
        self._transport = transport or UrllibTransport()
        self._clock = clock or time.monotonic

    def run(
        self,
        working_dir: Path,
        *,
        instructions: str | None = None,
        prompt: str | None = None,
    ) -> None:
        """Run `prompt` under `instructions` in `working_dir`.

        Both default to the bundled Full CI analyzer instructions and task
        prompt so existing callers keep their behavior; other slices supply
        their own bundled instructions and per-task prompt.
        """
        workdir = working_dir.resolve()
        deadline = self._clock() + self._timeout_seconds
        self._loop(
            workdir,
            instructions
            if instructions is not None
            else load_instructions(DEFAULT_INSTRUCTIONS_ASSET),
            prompt if prompt is not None else KIMI_ANALYZER_PROMPT,
            deadline,
            allow_task=True,
        )

    def _loop(
        self,
        workdir: Path,
        system: str,
        prompt: str,
        deadline: float,
        *,
        allow_task: bool,
    ) -> str:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]
        tools = _TOOLS if allow_task else _TASK_TOOLS
        for _ in range(self._max_turns):
            if self._clock() >= deadline:
                raise AnalyzerError("kimi analyzer exceeded its time budget")
            message = self._complete(messages, tools, deadline)
            messages.append(message)
            calls = message.get("tool_calls")
            if not calls:
                content = message.get("content")
                return content if isinstance(content, str) else ""
            for call in cast(list[dict[str, Any]], calls):
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": str(call.get("id") or ""),
                        "content": self._execute(
                            call, workdir, system, deadline, allow_task=allow_task
                        ),
                    }
                )
            _prune_history(messages)
        raise AnalyzerError(f"kimi analyzer exceeded {self._max_turns} turns")

    def _complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        deadline: float,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "max_tokens": MAX_OUTPUT_TOKENS,
            # Log triage is mechanical; low thinking effort keeps the many
            # sequential investigation calls fast enough for the time budget.
            "reasoning_effort": self._reasoning_effort,
        }
        url = f"{self._base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise AnalyzerError("kimi analyzer exceeded its time budget")
        if isinstance(self._transport, UrllibTransport):
            response = self._transport(
                url,
                headers,
                payload,
                timeout_seconds=remaining,
            )
        else:
            response = self._transport(url, headers, payload)
        try:
            message = cast(list[dict[str, Any]], response["choices"])[0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise AnalyzerError("kimi API returned a malformed response") from exc
        if not isinstance(message, dict):
            raise AnalyzerError("kimi API returned a malformed response")
        return cast(dict[str, Any], message)

    def _execute(
        self,
        call: dict[str, Any],
        workdir: Path,
        system: str,
        deadline: float,
        *,
        allow_task: bool,
    ) -> str:
        function = cast(dict[str, Any], call.get("function") or {})
        name = str(function.get("name") or "")
        raw_arguments = function.get("arguments")
        try:
            arguments = json.loads(
                raw_arguments if isinstance(raw_arguments, str) else "{}"
            )
        except json.JSONDecodeError:
            return "error: invalid tool arguments"
        if not isinstance(arguments, dict):
            return "error: invalid tool arguments"
        argument_map = cast(dict[str, Any], arguments)
        try:
            if name == "Read":
                return _tool_read(workdir, str(argument_map.get("path") or ""))
            if name == "Write":
                return _tool_write(
                    workdir,
                    str(argument_map.get("path") or ""),
                    str(argument_map.get("content") or ""),
                )
            if name == "Edit":
                return _tool_edit(
                    workdir,
                    str(argument_map.get("path") or ""),
                    str(argument_map.get("old_string") or ""),
                    str(argument_map.get("new_string") or ""),
                )
            if name == "Glob":
                return _tool_glob(workdir, str(argument_map.get("pattern") or ""))
            if name == "Grep":
                return _tool_grep(
                    workdir,
                    str(argument_map.get("pattern") or ""),
                    str(argument_map.get("path") or ""),
                )
            if name == "Bash":
                remaining = deadline - self._clock()
                if remaining <= 0:
                    raise AnalyzerError("kimi analyzer exceeded its time budget")
                return _tool_bash(
                    workdir,
                    str(argument_map.get("command") or ""),
                    timeout_seconds=remaining,
                )
            if name == "Task":
                if not allow_task:
                    return "error: nested Task calls are not allowed"
                result = self._loop(
                    workdir,
                    system,
                    str(argument_map.get("prompt") or ""),
                    deadline,
                    allow_task=False,
                )
                if len(result) > TASK_RESULT_LIMIT:
                    return result[:TASK_RESULT_LIMIT] + "\n... (truncated)"
                return result
            return f"error: unknown tool: {name}"
        except (OSError, ValueError) as exc:
            return f"error: {exc}"


def load_instructions(asset: str) -> str:
    """Bundled analyzer instructions with the frontmatter block stripped."""
    text = importlib.resources.files("alerting").joinpath(asset).read_text(
        encoding="utf-8"
    )
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            text = text[end + 4 :].lstrip("\n")
    return text


def _resolve(workdir: Path, path: str) -> Path:
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = workdir / candidate
    resolved = candidate.resolve()
    if resolved != workdir and workdir not in resolved.parents:
        raise ValueError(f"path escapes the working directory: {path}")
    return resolved


def _tool_read(workdir: Path, path: str) -> str:
    target = _resolve(workdir, path)
    if not target.is_file():
        return f"error: no such file: {path}"
    text = target.read_text(encoding="utf-8", errors="replace")
    if len(text) > READ_CHAR_LIMIT:
        return text[:READ_CHAR_LIMIT] + "\n... (truncated)"
    return text


def _tool_write(workdir: Path, path: str, content: str) -> str:
    target = _resolve(workdir, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"wrote {target.relative_to(workdir)}"


def _tool_edit(workdir: Path, path: str, old_string: str, new_string: str) -> str:
    target = _resolve(workdir, path)
    if not target.is_file():
        return f"error: no such file: {path}"
    text = target.read_text(encoding="utf-8", errors="replace")
    occurrences = text.count(old_string)
    if occurrences == 0:
        return "error: old_string not found"
    if occurrences > 1:
        return f"error: old_string is ambiguous ({occurrences} occurrences)"
    target.write_text(text.replace(old_string, new_string, 1), encoding="utf-8")
    return f"edited {target.relative_to(workdir)}"


def _tool_glob(workdir: Path, pattern: str) -> str:
    parts = Path(pattern).parts
    if Path(pattern).is_absolute() or ".." in parts:
        return f"error: pattern escapes the working directory: {pattern}"
    try:
        matches = sorted(
            entry.relative_to(workdir).as_posix() for entry in workdir.glob(pattern)
        )
    except (ValueError, OSError) as exc:
        return f"error: invalid pattern: {exc}"
    if not matches:
        return "no matches"
    if len(matches) > GLOB_RESULT_LIMIT:
        shown = matches[:GLOB_RESULT_LIMIT]
        return "\n".join(shown) + f"\n... ({len(matches) - GLOB_RESULT_LIMIT} more)"
    return "\n".join(matches)


def _tool_grep(workdir: Path, pattern: str, path: str) -> str:
    try:
        regex = re.compile(pattern)
    except re.error as exc:
        return f"error: invalid regex: {exc}"
    root = _resolve(workdir, path) if path else workdir
    if root.is_file():
        files = [root]
    else:
        try:
            files = sorted(entry for entry in root.rglob("*") if entry.is_file())
        except OSError as exc:
            return f"error: cannot search path: {exc}"
    results: list[str] = []
    for entry in files:
        try:
            text = entry.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if regex.search(line):
                results.append(f"{entry.relative_to(workdir)}:{lineno}:{line}")
                if len(results) >= GREP_RESULT_LIMIT:
                    return "\n".join(results) + "\n... (truncated)"
    return "\n".join(results) if results else "no matches"


def _tool_bash(
    workdir: Path,
    command: str,
    *,
    timeout_seconds: float = BASH_TIMEOUT_SECONDS,
) -> str:
    try:
        tokens = shlex.split(command)
    except ValueError as exc:
        return f"error: cannot parse command: {exc}"
    if not tokens or tokens[0] != "curl":
        return "error: only curl commands are allowed"
    try:
        completed = subprocess.run(
            tokens,
            cwd=workdir,
            capture_output=True,
            text=True,
            timeout=min(BASH_TIMEOUT_SECONDS, timeout_seconds),
            check=False,
        )
    except subprocess.TimeoutExpired:
        return "error: command timed out"
    except OSError as exc:
        return f"error: command failed: {exc}"
    output = (completed.stdout or "") + (completed.stderr or "")
    if len(output) > BASH_OUTPUT_LIMIT:
        # Buildkite logs put the failure at the end; keep the tail.
        output = "... (truncated)\n" + output[-BASH_OUTPUT_LIMIT:]
    return f"exit {completed.returncode}\n{output}"
