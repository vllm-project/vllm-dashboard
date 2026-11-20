"""Direct-API LLM backends (OpenAI-compatible and Anthropic Messages API).

Stdlib-only (`urllib.request`) implementations of `LLMBackend` so extraction
(Tier 1) and relevance (Tier 2) can run against fast/cheap APIs (DeepSeek,
Gemini OpenAI endpoint, Kimi, OpenRouter, OpenAI, Anthropic, or self-hosted
vLLM) without spawning `claude -p` subprocesses or relying on expiring CLI
OAuth tokens. `ClaudeCodeBackend` remains the default when `TRIAGE_BACKEND`
is unset.
"""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable, Mapping
from http.client import HTTPException
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from triage.extract import (
    _USAGE_LIMIT_MARKERS,
    BudgetExhausted,
    ClaudeCodeBackend,
    ExtractionError,
    LLMBackend,
    LLMResult,
)

USER_AGENT = "vllm-ci-triage"
OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"
ANTHROPIC_VERSION = "2023-06-01"

_JSON_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL | re.IGNORECASE)
_SCHEMA_UNSUPPORTED_MARKERS = ("json_schema", "response_format", "structured output")
_EXTRA_LIMIT_MARKERS = (*_USAGE_LIMIT_MARKERS, "insufficient_quota", "insufficient balance", "overloaded", "credit")


def _strip_json_fences(text: str) -> str:
    match = _JSON_FENCE.match(text)
    return match.group(1) if match else text.strip()


def _is_limit_error(status: int, message: str) -> bool:
    if status in (429, 529):
        return True
    lower = message.lower()
    return any(marker in lower for marker in _EXTRA_LIMIT_MARKERS)


class OpenAICompatibleBackend:
    """Calls any OpenAI-compatible `/chat/completions` endpoint.

    Works with OpenAI, DeepSeek, Gemini (OpenAI endpoint), Kimi, OpenRouter,
    and self-hosted vLLM. Uses `response_format: json_schema` first in `auto`
    mode, automatically falling back to `json_object` + embedded schema when a
    provider rejects strict `json_schema`.
    """

    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        base_url: str = OPENAI_DEFAULT_BASE_URL,
        timeout_seconds: float = 120.0,
        structured_mode: Literal["auto", "json_schema", "json_object"] = "auto",
        extra_headers: Mapping[str, str] | None = None,
        temperature: float = 0.0,
        max_retries: int = 3,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.model = model
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_seconds
        self._structured_mode = structured_mode
        self._use_json_object = structured_mode == "json_object"
        self._extra_headers = dict(extra_headers or {})
        self._temperature = temperature
        self._max_retries = max(1, max_retries)
        self._sleep = sleep

    def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult:
        started = time.monotonic()
        try:
            payload = self._call(system=system, prompt=prompt, schema=schema, json_object=self._use_json_object)
        except _SchemaUnsupportedError:
            if self._structured_mode != "auto" or self._use_json_object:
                raise ExtractionError("OpenAI-compatible provider rejected json_schema") from None
            self._use_json_object = True
            payload = self._call(system=system, prompt=prompt, schema=schema, json_object=True)
        duration_ms = int((time.monotonic() - started) * 1000)
        return self._parse(payload, duration_ms)

    def _call(self, *, system: str, prompt: str, schema: dict[str, Any], json_object: bool) -> dict[str, Any]:
        sys_text = system
        response_format: dict[str, Any]
        if json_object:
            sys_text = f"{system}\n\nRespond ONLY with a valid JSON object matching this JSON Schema:\n{json.dumps(schema)}"
            response_format = {"type": "json_object"}
        else:
            response_format = {
                "type": "json_schema",
                "json_schema": {"name": "triage_output", "strict": True, "schema": schema},
            }
        body = {
            "model": self.model,
            "temperature": self._temperature,
            "messages": [
                {"role": "system", "content": sys_text},
                {"role": "user", "content": prompt},
            ],
            "response_format": response_format,
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            **self._extra_headers,
        }
        return _post_json(
            f"{self._base_url}/chat/completions",
            body=body,
            headers=headers,
            timeout=self._timeout,
            max_retries=self._max_retries,
            sleep=self._sleep,
            check_schema_rejection=not json_object,
        )

    def _parse(self, payload: dict[str, Any], duration_ms: int) -> LLMResult:
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ExtractionError("OpenAI-compatible response had no choices")
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise ExtractionError("OpenAI-compatible response had empty message content")
        try:
            output = json.loads(_strip_json_fences(content))
        except json.JSONDecodeError as exc:
            raise ExtractionError(f"OpenAI-compatible response was not valid JSON: {exc}") from exc
        raw_usage = payload.get("usage")
        usage: dict[str, Any] = raw_usage if isinstance(raw_usage, dict) else {}
        return LLMResult(
            output=output,
            model=str(payload.get("model") or self.model),
            input_tokens=int(usage.get("prompt_tokens") or 0) or None,
            output_tokens=int(usage.get("completion_tokens") or 0) or None,
            duration_ms=duration_ms,
        )


class AnthropicAPIBackend:
    """Direct Anthropic `/v1/messages` backend with ephemeral prompt caching
    on the system prompt and forced tool_use for structured JSON output."""

    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        base_url: str = ANTHROPIC_DEFAULT_BASE_URL,
        timeout_seconds: float = 120.0,
        max_tokens: int = 4096,
        max_retries: int = 3,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.model = model
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_seconds
        self._max_tokens = max_tokens
        self._max_retries = max(1, max_retries)
        self._sleep = sleep

    def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult:
        started = time.monotonic()
        body = {
            "model": self.model,
            "max_tokens": self._max_tokens,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": prompt}],
            "tools": [
                {
                    "name": "emit_result",
                    "description": "Emit the structured JSON output.",
                    "input_schema": schema,
                }
            ],
            "tool_choice": {"type": "tool", "name": "emit_result"},
        }
        headers = {
            "x-api-key": self._api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        }
        payload = _post_json(
            f"{self._base_url}/v1/messages",
            body=body,
            headers=headers,
            timeout=self._timeout,
            max_retries=self._max_retries,
            sleep=self._sleep,
        )
        duration_ms = int((time.monotonic() - started) * 1000)
        return self._parse(payload, duration_ms)

    def _parse(self, payload: dict[str, Any], duration_ms: int) -> LLMResult:
        blocks = payload.get("content")
        output: Any = None
        if isinstance(blocks, list):
            for block in blocks:
                if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") == "emit_result":
                    output = block.get("input")
                    break
        if output is None:
            raise ExtractionError("Anthropic API response had no emit_result tool_use block")
        raw_usage = payload.get("usage")
        usage: dict[str, Any] = raw_usage if isinstance(raw_usage, dict) else {}
        input_tokens = sum(
            int(usage.get(k) or 0)
            for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
        )
        return LLMResult(
            output=output,
            model=str(payload.get("model") or self.model),
            input_tokens=input_tokens or None,
            output_tokens=int(usage.get("output_tokens") or 0) or None,
            duration_ms=duration_ms,
        )


class _SchemaUnsupportedError(Exception):
    pass


def _post_json(
    url: str,
    *,
    body: dict[str, Any],
    headers: dict[str, str],
    timeout: float,
    max_retries: int,
    sleep: Callable[[float], None],
    check_schema_rejection: bool = False,
) -> dict[str, Any]:
    encoded = json.dumps(body).encode()
    request = Request(url, data=encoded, headers=headers, method="POST")
    for attempt in range(max_retries):
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8", errors="replace")
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ExtractionError("API returned non-object JSON")
            return parsed
        except HTTPError as exc:
            err_body = ""
            try:
                err_body = exc.read().decode("utf-8", errors="replace")[:500]
            except OSError:
                pass
            if _is_limit_error(exc.code, err_body):
                raise BudgetExhausted(f"API rate/quota limit (HTTP {exc.code}): {err_body}") from exc
            if (
                check_schema_rejection
                and exc.code in (400, 422)
                and any(marker in err_body.lower() for marker in _SCHEMA_UNSUPPORTED_MARKERS)
            ):
                raise _SchemaUnsupportedError(err_body) from exc
            if exc.code in (500, 502, 503, 504) and attempt < max_retries - 1:
                sleep(2 ** attempt)
                continue
            raise ExtractionError(f"API HTTP {exc.code}: {err_body}") from exc
        except (URLError, TimeoutError, OSError, HTTPException) as exc:
            if attempt < max_retries - 1:
                sleep(2 ** attempt)
                continue
            raise ExtractionError(f"API transport error: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise ExtractionError(f"API returned invalid JSON: {exc}") from exc
    raise ExtractionError("API retries exhausted")


def build_backend(
    *,
    role: Literal["extract", "relevance"] = "extract",
    backend: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    timeout_seconds: float | None = None,
    env: Mapping[str, str] | None = None,
) -> LLMBackend:
    """Construct an `LLMBackend` from explicit args or tiered environment vars.

    For `extract`: `TRIAGE_BACKEND` (default `claude`), `TRIAGE_MODEL`,
    `TRIAGE_API_BASE_URL`, `TRIAGE_API_KEY`.
    For `relevance`: `TRIAGE_RELEVANCE_BACKEND` -> `TRIAGE_BACKEND` -> `claude`,
    `TRIAGE_RELEVANCE_MODEL`, `TRIAGE_RELEVANCE_API_BASE_URL` -> `TRIAGE_API_BASE_URL`,
    `TRIAGE_RELEVANCE_API_KEY` -> `TRIAGE_API_KEY`.
    """
    source = os.environ if env is None else env
    if role == "relevance":
        kind = (backend or source.get("TRIAGE_RELEVANCE_BACKEND") or source.get("TRIAGE_BACKEND") or "claude").strip().lower()
        default_model = "opus" if kind == "claude" else ""
        resolved_model = (model or source.get("TRIAGE_RELEVANCE_MODEL") or default_model).strip()
        resolved_base = (base_url or source.get("TRIAGE_RELEVANCE_API_BASE_URL") or source.get("TRIAGE_API_BASE_URL") or "").strip()
        resolved_key = (api_key or source.get("TRIAGE_RELEVANCE_API_KEY") or source.get("TRIAGE_API_KEY") or "").strip()
    else:
        kind = (backend or source.get("TRIAGE_BACKEND") or "claude").strip().lower()
        default_model = "sonnet" if kind == "claude" else ""
        resolved_model = (model or source.get("TRIAGE_MODEL") or default_model).strip()
        resolved_base = (base_url or source.get("TRIAGE_API_BASE_URL") or "").strip()
        resolved_key = (api_key or source.get("TRIAGE_API_KEY") or "").strip()

    if kind == "claude":
        return ClaudeCodeBackend(model=resolved_model or default_model, timeout_seconds=timeout_seconds or 180.0)
    if kind == "openai":
        key = resolved_key or source.get("OPENAI_API_KEY", "").strip()
        if not key:
            raise ValueError(f"{role} backend 'openai' requires TRIAGE_API_KEY (or OPENAI_API_KEY)")
        if not resolved_model:
            raise ValueError(f"{role} backend 'openai' requires a model name")
        mode = source.get("TRIAGE_OPENAI_STRUCTURED_MODE", "auto").strip().lower()
        if mode not in ("auto", "json_schema", "json_object"):
            mode = "auto"
        return OpenAICompatibleBackend(
            model=resolved_model,
            api_key=key,
            base_url=resolved_base or OPENAI_DEFAULT_BASE_URL,
            timeout_seconds=timeout_seconds or 120.0,
            structured_mode=mode,  # type: ignore[arg-type]
        )
    if kind == "anthropic":
        key = resolved_key or source.get("ANTHROPIC_API_KEY", "").strip()
        if not key:
            raise ValueError(f"{role} backend 'anthropic' requires TRIAGE_API_KEY (or ANTHROPIC_API_KEY)")
        if not resolved_model:
            raise ValueError(f"{role} backend 'anthropic' requires a model name")
        return AnthropicAPIBackend(
            model=resolved_model,
            api_key=key,
            base_url=resolved_base or ANTHROPIC_DEFAULT_BASE_URL,
            timeout_seconds=timeout_seconds or 120.0,
        )
    raise ValueError(f"Unknown triage backend {kind!r}; expected 'claude', 'openai', or 'anthropic'")
