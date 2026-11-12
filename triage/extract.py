"""LLM facet extraction: prompt rendering, the Claude Code backend, and the
budgeted extraction loop that runs on the extractor host.

The model gets no tools: it reads one item's text (already stored by the
worker) and returns schema-constrained JSON. Nothing it writes can cause an
action; scores and routing are computed from validated facets afterwards.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Protocol
from xml.sax.saxutils import escape

from triage.facets import FACETS_SCHEMA, PROMPT_VERSION, FacetsError, normalize_facets

SYSTEM_PROMPT_PATH = Path(__file__).resolve().parent / "assets" / "extractor-system.md"
DEFAULT_MODEL = "sonnet"
_USAGE_LIMIT_MARKERS = ("usage limit", "rate limit", "rate_limit", "quota", "limit reached", "429")


@dataclass(frozen=True)
class ExtractionTask:
    """What the extractor reads for one item (from triage_items)."""

    item_key: str
    kind: str
    title: str
    body: str
    comments: str
    author_association: str
    state: str
    labels: list[str]
    files: list[dict[str, Any]]
    prepass: dict[str, Any]
    content_hash: str


@dataclass(frozen=True)
class LLMResult:
    output: Any
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    duration_ms: int | None = None


class ExtractionError(Exception):
    """This item could not be extracted; try again later."""


class BudgetExhausted(Exception):
    """The plan's usage limit (or our own budget) is reached; stop the run."""


class LLMBackend(Protocol):
    def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult: ...


def render_prompt(task: ExtractionTask) -> str:
    """Untrusted item text wrapped in a delimited, escaped block."""
    files = "\n".join(
        f"{f.get('path')} (+{f.get('additions', 0)}/-{f.get('deletions', 0)})"
        for f in task.files[:150]
    )
    more = f"\n... and {len(task.files) - 150} more files" if len(task.files) > 150 else ""
    hints = {
        k: task.prepass.get(k)
        for k in ("areas", "linked_issues", "hardware_hints", "model_hints")
    }
    parts = [
        f"Classify this vLLM {'pull request' if task.kind == 'pr' else 'issue'}.",
        f"Deterministic hints (from paths and regexes, may be incomplete): {json.dumps(hints)}",
        "<item>",
        f"<kind>{task.kind}</kind>",
        f"<state>{escape(task.state)}</state>",
        f"<author_association>{escape(task.author_association)}</author_association>",
        f"<labels>{escape(', '.join(task.labels))}</labels>",
        f"<title>{escape(task.title)}</title>",
        f"<body>\n{escape(task.body)}\n</body>",
    ]
    if task.kind == "pr":
        parts.append(f"<changed_files>\n{escape(files + more)}\n</changed_files>")
    if task.comments.strip():
        parts.append(f"<comments>\n{escape(task.comments)}\n</comments>")
    parts.append("</item>")
    return "\n".join(parts)


class ClaudeCodeBackend:
    """Runs `claude -p` headless with no tools, MCP servers, or settings.

    Authentication is whatever the local Claude Code login provides (a
    Pro/Max plan login or a `CLAUDE_CODE_OAUTH_TOKEN` from
    `claude setup-token`). ANTHROPIC_API_KEY is removed from the child
    environment so usage always lands on the plan, never on an API bill.
    """

    def __init__(
        self,
        *,
        model: str = DEFAULT_MODEL,
        binary: str = "claude",
        timeout_seconds: float = 180.0,
    ) -> None:
        self.model = model
        self._binary = binary
        self._timeout = timeout_seconds

    def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult:
        env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
        command = [
            self._binary, "-p",
            "--model", self.model,
            "--tools", "",
            "--strict-mcp-config",
            "--setting-sources", "",
            "--no-session-persistence",
            "--output-format", "json",
            "--json-schema", json.dumps(schema),
            "--system-prompt", system,
        ]
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="triage-extract-") as cwd:
            try:
                completed = subprocess.run(
                    command,
                    input=prompt,
                    capture_output=True,
                    text=True,
                    timeout=self._timeout,
                    cwd=cwd,
                    env=env,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise ExtractionError(f"claude timed out after {self._timeout}s") from exc
        duration_ms = int((time.monotonic() - started) * 1000)
        return self._parse(completed.returncode, completed.stdout, completed.stderr, duration_ms)

    def _parse(self, code: int, stdout: str, stderr: str, duration_ms: int) -> LLMResult:
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError:
            payload = None
        message = ""
        if isinstance(payload, dict):
            message = str(payload.get("result") or payload.get("subtype") or "")
        combined = f"{message}\n{stderr}".lower()
        if code != 0 or not isinstance(payload, dict) or payload.get("is_error"):
            if any(marker in combined for marker in _USAGE_LIMIT_MARKERS):
                raise BudgetExhausted(f"claude usage limit: {combined.strip()[:300]}")
            raise ExtractionError(f"claude exited {code}: {combined.strip()[:300]}")
        output = payload.get("structured_output")
        if output is None:
            try:
                output = json.loads(payload.get("result") or "")
            except (TypeError, json.JSONDecodeError) as exc:
                raise ExtractionError("claude returned no structured output") from exc
        usage = payload.get("usage") or {}
        input_tokens = sum(
            int(usage.get(k) or 0)
            for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
        )
        model_usage = payload.get("modelUsage") or {}
        # Claude Code also makes small side calls (e.g. Haiku for a session
        # title); the extraction is the model that wrote the most output.
        model = self.model
        if isinstance(model_usage, dict) and model_usage:
            model = max(model_usage, key=lambda m: (model_usage[m] or {}).get("outputTokens", 0))
        return LLMResult(
            output=output,
            model=str(model),
            input_tokens=input_tokens or None,
            output_tokens=int(usage.get("output_tokens") or 0) or None,
            duration_ms=duration_ms,
        )


def system_prompt() -> str:
    return SYSTEM_PROMPT_PATH.read_text()


def extract_one(task: ExtractionTask, backend: LLMBackend, *, system: str | None = None) -> tuple[dict[str, Any], LLMResult]:
    result = backend.complete(
        system=system or system_prompt(), prompt=render_prompt(task), schema=FACETS_SCHEMA
    )
    try:
        facets = normalize_facets(result.output, kind=task.kind)
    except FacetsError as exc:
        raise ExtractionError(f"invalid facets: {exc}") from exc
    return facets, result


# --- the budgeted loop -------------------------------------------------------


@dataclass(frozen=True)
class Budget:
    """Our own ceiling, kept well under the plan's weekly cap.

    `max_items_per_day` / `max_tokens_per_day` count extractions stored in
    the last 24 hours. A run stops early when either is reached, or as soon
    as Claude reports a usage limit.
    """

    max_items_per_run: int = 40
    max_items_per_day: int = 150
    max_tokens_per_day: int = 2_000_000
    max_attempts: int = 3


class ExtractionStore(Protocol):
    def lease_extraction_batch(
        self, *, limit: int, now: datetime, lease_until: datetime, max_attempts: int
    ) -> list[ExtractionTask]: ...

    def save_extraction(
        self, task: ExtractionTask, *, facets: dict[str, Any], result: LLMResult,
        prompt_version: str, now: datetime,
    ) -> None: ...

    def mark_extraction_failed(self, item_key: str, *, error: str, now: datetime) -> None: ...

    def release_extraction(self, item_key: str) -> None: ...

    def extraction_usage_since(self, since: datetime) -> tuple[int, int]: ...


@dataclass
class ExtractRunResult:
    extracted: int = 0
    failed: int = 0
    stopped_reason: str | None = None
    errors: list[str] = field(default_factory=list)


def run_extraction(
    store: ExtractionStore,
    backend: LLMBackend,
    *,
    budget: Budget,
    now: datetime,
    workers: int = 2,
) -> ExtractRunResult:
    result = ExtractRunResult()
    items_today, tokens_today = store.extraction_usage_since(now - timedelta(days=1))
    room = min(budget.max_items_per_run, budget.max_items_per_day - items_today)
    if room <= 0 or tokens_today >= budget.max_tokens_per_day:
        result.stopped_reason = f"daily budget reached ({items_today} items, {tokens_today} tokens)"
        return result
    tasks = store.lease_extraction_batch(
        limit=room, now=now, lease_until=now + timedelta(minutes=30), max_attempts=budget.max_attempts
    )
    system = system_prompt()
    exhausted = False

    def work(task: ExtractionTask) -> tuple[ExtractionTask, Any]:
        if exhausted:
            return task, None
        try:
            return task, extract_one(task, backend, system=system)
        except (ExtractionError, BudgetExhausted) as exc:
            return task, exc

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for task, outcome in pool.map(work, tasks):
            if outcome is None:
                store.release_extraction(task.item_key)
            elif isinstance(outcome, BudgetExhausted):
                exhausted = True
                result.stopped_reason = str(outcome)
                store.release_extraction(task.item_key)
            elif isinstance(outcome, ExtractionError):
                result.failed += 1
                result.errors.append(f"{task.item_key}: {outcome}")
                store.mark_extraction_failed(task.item_key, error=str(outcome), now=now)
            else:
                facets, llm = outcome
                store.save_extraction(
                    task, facets=facets, result=llm, prompt_version=PROMPT_VERSION, now=now
                )
                result.extracted += 1
                tokens_today += (llm.input_tokens or 0) + (llm.output_tokens or 0)
                if tokens_today >= budget.max_tokens_per_day:
                    exhausted = True
                    result.stopped_reason = "daily token budget reached"
    return result
