"""Tests for direct-API LLM backends (OpenAI-compatible and Anthropic Messages API)."""

from __future__ import annotations

import io
import json
from typing import Any
from urllib.error import HTTPError

import pytest

from triage.backends import AnthropicAPIBackend, OpenAICompatibleBackend, build_backend
from triage.extract import Budget, BudgetExhausted, ClaudeCodeBackend, ExtractionError, LLMResult, run_extraction


class FakeResponse:
    def __init__(self, body: dict[str, Any]) -> None:
        self._data = json.dumps(body).encode()

    def read(self) -> bytes:
        return self._data

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: Any) -> None:
        return None


def _http_error(code: int, message: str) -> HTTPError:
    return HTTPError("https://api.example.test", code, "err", {}, io.BytesIO(message.encode()))  # type: ignore[arg-type]


SCHEMA = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}


def test_openai_backend_json_schema_and_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict[str, Any]] = []

    def fake_urlopen(req: Any, timeout: float = 0) -> FakeResponse:
        seen.append({"url": req.full_url, "headers": dict(req.header_items()), "body": json.loads(req.data)})
        return FakeResponse({
            "model": "deepseek-chat",
            "choices": [{"message": {"content": '{"ok": true}'}}],
            "usage": {"prompt_tokens": 300, "completion_tokens": 25},
        })

    monkeypatch.setattr("triage.backends.urlopen", fake_urlopen)
    backend = OpenAICompatibleBackend(model="deepseek-chat", api_key="sk-test", base_url="https://api.deepseek.com/v1")
    res = backend.complete(system="sys", prompt="user", schema=SCHEMA)
    assert res.output == {"ok": True}
    assert (res.model, res.input_tokens, res.output_tokens) == ("deepseek-chat", 300, 25)
    assert seen[0]["url"] == "https://api.deepseek.com/v1/chat/completions"
    assert seen[0]["body"]["response_format"]["type"] == "json_schema"


def test_openai_backend_falls_back_to_json_object_and_strips_fences(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fake_urlopen(req: Any, timeout: float = 0) -> FakeResponse:
        body = json.loads(req.data)
        fmt = body["response_format"]["type"]
        calls.append(fmt)
        if fmt == "json_schema":
            raise _http_error(400, '{"error": "response_format json_schema is not supported"}')
        return FakeResponse({
            "choices": [{"message": {"content": "```json\n{\"ok\": true}\n```"}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10},
        })

    monkeypatch.setattr("triage.backends.urlopen", fake_urlopen)
    backend = OpenAICompatibleBackend(model="m", api_key="k", sleep=lambda _: None)
    assert backend.complete(system="sys", prompt="p1", schema=SCHEMA).output == {"ok": True}
    # Fallback is sticky: second call goes straight to json_object.
    assert backend.complete(system="sys", prompt="p2", schema=SCHEMA).output == {"ok": True}
    assert calls == ["json_schema", "json_object", "json_object"]


def test_openai_backend_maps_429_to_budget_exhausted_and_retries_503(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = 0

    def fake_urlopen(req: Any, timeout: float = 0) -> FakeResponse:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise _http_error(503, "temporarily unavailable")
        return FakeResponse({"choices": [{"message": {"content": '{"ok": true}'}}]})

    monkeypatch.setattr("triage.backends.urlopen", fake_urlopen)
    backend = OpenAICompatibleBackend(model="m", api_key="k", sleep=lambda _: None)
    assert backend.complete(system="s", prompt="p", schema=SCHEMA).output == {"ok": True}
    assert attempts == 2

    def fake_429(req: Any, timeout: float = 0) -> FakeResponse:
        raise _http_error(429, "rate limit exceeded")

    monkeypatch.setattr("triage.backends.urlopen", fake_429)
    with pytest.raises(BudgetExhausted):
        backend.complete(system="s", prompt="p", schema=SCHEMA)


def test_anthropic_backend_uses_prompt_caching_and_tool_choice(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict[str, Any]] = []

    def fake_urlopen(req: Any, timeout: float = 0) -> FakeResponse:
        seen.append({"url": req.full_url, "body": json.loads(req.data)})
        return FakeResponse({
            "model": "claude-sonnet-4-6",
            "content": [{"type": "tool_use", "name": "emit_result", "input": {"ok": True}}],
            "usage": {
                "input_tokens": 100,
                "cache_creation_input_tokens": 200,
                "cache_read_input_tokens": 500,
                "output_tokens": 40,
            },
        })

    monkeypatch.setattr("triage.backends.urlopen", fake_urlopen)
    backend = AnthropicAPIBackend(model="claude-sonnet-4-6", api_key="sk-ant", sleep=lambda _: None)
    res = backend.complete(system="big sys", prompt="item", schema=SCHEMA)
    assert res.output == {"ok": True}
    assert (res.input_tokens, res.output_tokens) == (800, 40)
    assert seen[0]["body"]["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert seen[0]["body"]["tool_choice"] == {"type": "tool", "name": "emit_result"}

    def fake_529(req: Any, timeout: float = 0) -> FakeResponse:
        raise _http_error(529, "overloaded")

    monkeypatch.setattr("triage.backends.urlopen", fake_529)
    with pytest.raises(BudgetExhausted):
        backend.complete(system="big sys", prompt="item", schema=SCHEMA)

    def fake_400(req: Any, timeout: float = 0) -> FakeResponse:
        raise _http_error(400, "bad request")

    monkeypatch.setattr("triage.backends.urlopen", fake_400)
    with pytest.raises(ExtractionError):
        backend.complete(system="big sys", prompt="item", schema=SCHEMA)


def test_build_backend_tiered_env_resolution() -> None:
    assert isinstance(build_backend(role="extract", env={}), ClaudeCodeBackend)
    env = {
        "TRIAGE_BACKEND": "openai",
        "TRIAGE_API_BASE_URL": "https://api.deepseek.com/v1",
        "TRIAGE_API_KEY": "sk-ds",
        "TRIAGE_MODEL": "deepseek-chat",
        "TRIAGE_RELEVANCE_BACKEND": "anthropic",
        "TRIAGE_RELEVANCE_API_KEY": "sk-ant",
        "TRIAGE_RELEVANCE_MODEL": "claude-sonnet-4-6",
    }
    ext = build_backend(role="extract", env=env)
    rel = build_backend(role="relevance", env=env)
    assert isinstance(ext, OpenAICompatibleBackend) and ext.model == "deepseek-chat"
    assert isinstance(rel, AnthropicAPIBackend) and rel.model == "claude-sonnet-4-6"

    with pytest.raises(ValueError, match="TRIAGE_API_KEY"):
        build_backend(role="extract", backend="openai", model="m", env={})


def test_budget_zero_means_unlimited_daily_caps() -> None:
    from datetime import datetime, timezone
    from triage.extract import ExtractionTask

    class FakeStore:
        def __init__(self) -> None:
            self.saved = 0

        def extraction_usage_since(self, since: datetime) -> tuple[int, int]:
            return (10_000, 99_000_000)

        def lease_extraction_batch(self, *, limit: int, now: datetime, lease_until: datetime, max_attempts: int) -> list[ExtractionTask]:
            assert limit == 5
            return [ExtractionTask("r#1", "issue", "t", "b", "", "NONE", "open", [], [], {}, "h")]

        def save_extraction(self, task: ExtractionTask, **_: Any) -> None:
            self.saved += 1

        def mark_extraction_failed(self, item_key: str, *, error: str, now: datetime) -> None:
            raise AssertionError(error)

        def release_extraction(self, item_key: str) -> None:
            pass

    class OkBackend:
        def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult:
            return LLMResult(output={
                "type": "bug", "summary": "s", "models": [], "model_traits": [], "hardware": [],
                "serving": [], "areas": ["other"],
                "severity": {"serving_broken": False, "crash": False, "wrong_output": False,
                             "hang": False, "perf_regression_pct": None, "memory_regression": False, "security": False},
                "default_config": None,
                "versions": {"good": None, "bad": None, "affects_main": None, "affects_latest_release": None},
                "has_repro": False, "pr": None, "slop_signals": [], "confidence": 0.8, "notes": "",
            }, model="deepseek-chat", input_tokens=500, output_tokens=100)

    store = FakeStore()
    res = run_extraction(
        store, OkBackend(),
        budget=Budget(max_items_per_run=5, max_items_per_day=0, max_tokens_per_day=0),
        now=datetime(2026, 11, 20, tzinfo=timezone.utc), workers=1,
    )
    assert res.extracted == 1 and store.saved == 1


def test_worker_rejects_claude_backend_for_extract_and_relevance(monkeypatch: pytest.MonkeyPatch) -> None:
    from triage import worker

    monkeypatch.setenv("DATABASE_URL", "postgres://fake")
    monkeypatch.delenv("TRIAGE_BACKEND", raising=False)
    monkeypatch.delenv("TRIAGE_RELEVANCE_BACKEND", raising=False)
    monkeypatch.setattr(worker, "_slack", lambda: object())
    monkeypatch.setattr(worker, "PostgresTriageStore", lambda url: object())
    for consumer in ("triage-extract", "triage-relevance"):
        with pytest.raises(ValueError, match="direct API backend"):
            worker.build_runtime(consumer)
    # Direct API backend is accepted on the worker.
    monkeypatch.setenv("TRIAGE_BACKEND", "openai")
    monkeypatch.setenv("TRIAGE_API_KEY", "sk-test")
    monkeypatch.setenv("TRIAGE_MODEL", "deepseek-chat")
    monkeypatch.setenv("TRIAGE_RELEVANCE_MODEL", "deepseek-chat")
    for consumer in ("triage-extract", "triage-relevance"):
        rt, cmd = worker.build_runtime(consumer)
        assert cmd.command_type == worker.CONSUMERS[consumer] and rt is not None
