"""AI analysis sidecar for Main CI job alerts.

The deterministic reconcile slice (`alerting.main_ci`) owns the alert
lifecycle in `alerting_main_ci_job_alerts`. This slice only reads those alerts
and writes its probabilistic diagnosis to the sidecar table
`alerting_main_ci_job_analysis`; it has no code path that mutates alert state.

Each tick analyzes open alerts whose latest failure has no matching analysis
yet. The handler materializes the alert context and the tail of the failing
job's Buildkite log into a scratch directory, runs the bundled instructions
(`assets/vllm-main-ci-job-analyzer.md`) through the Kimi runner, and validates
the strict-JSON `analysis.json` the model writes. A failure at any point — LLM
error, unreadable log, invalid output — skips the alert and leaves the previous
analysis authoritative, so the next tick retries from durable state. Rows carry
`analyzed_failure_job_id`; readers treat an analysis as stale when it no longer
matches the alert's `last_failure_job_id`. Stale rows are never deleted.
"""

from __future__ import annotations

import json
import re
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol, cast

from alerting.analyzer import AnalyzerError, GitHubPort, PullRequestRef
from alerting.commands import ScheduledCommand
from alerting.kimi import load_instructions
from alerting.ports import Clock

INSTRUCTIONS_ASSET = "assets/vllm-main-ci-job-analyzer.md"
CONTEXT_FILE = Path("context.json")
JOB_LOG_FILE = Path("job_log.txt")
ANALYSIS_FILE = Path("analysis.json")

# One tick stays well inside its ten-minute cadence at typical analysis
# latency; a slow tick is fenced by the execution lease either way.
ANALYSES_PER_TICK = 5
JOB_LOG_CHAR_LIMIT = 200_000
SUMMARY_CHAR_LIMIT = 500
ACTION_CHAR_LIMIT = 300

CLASSIFICATIONS = frozenset({"infra", "flaky", "code", "test", "unknown"})
CONFIDENCES = frozenset({"high", "medium", "low"})

_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")


@dataclass(frozen=True)
class MainCIAnalysisTarget:
    """One open alert whose latest failure needs a (fresh) analysis."""

    alert_id: int
    job_key: str
    job_name: str
    opened_at: datetime
    last_failed_at: datetime
    failure_count: int
    failure_job_id: str
    failure_build_number: int
    failure_build_url: str
    failure_job_url: str
    failure_commit_sha: str


@dataclass(frozen=True)
class SuspectedFixPR:
    url: str
    number: int | None
    title: str


@dataclass(frozen=True)
class MainCIJobAnalysis:
    """One validated model diagnosis, keyed to the failure it was read from."""

    alert_id: int
    analyzed_failure_job_id: str
    classification: str
    confidence: str
    summary: str
    evidence_urls: tuple[str, ...]
    recommended_action: str
    suspected_fix_prs: tuple[SuspectedFixPR, ...]
    model_version: str


class MainCIAnalysisRunner(Protocol):
    """Runs supplied instructions in a prepared working directory."""

    def run(self, working_dir: Path, *, instructions: str, prompt: str) -> None:
        """Raise AnalyzerError on any LLM failure."""
        ...


class BuildkiteJobLogPort(Protocol):
    def job_log_text(self, *, build_number: int, job_id: str) -> str: ...


class MainCIAnalysisStore(Protocol):
    def pending_main_ci_analyses(self, *, limit: int) -> list[MainCIAnalysisTarget]:
        """Open alerts with no analysis for their latest failure, newest first."""
        ...

    def commit_main_ci_analysis(
        self, *, analysis: MainCIJobAnalysis, now: datetime
    ) -> None:
        """Upsert one alert's analysis; a newer observed failure wins."""
        ...


class BuildkiteJobLogClient:
    """Read-only fetch of one job's plain-text log from the vllm/ci pipeline."""

    def __init__(self, *, token: str, org: str = "vllm", pipeline: str = "ci") -> None:
        self._token = token
        self._org = org
        self._pipeline = pipeline

    def job_log_text(self, *, build_number: int, job_id: str) -> str:
        url = (
            f"https://api.buildkite.com/v2/organizations/{self._org}"
            f"/pipelines/{self._pipeline}/builds/{build_number}"
            f"/jobs/{job_id}/log"
        )
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Accept": "text/plain",
                "User-Agent": "vllm-ci-alerting/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, OSError) as exc:
            raise AnalyzerError(
                f"Buildkite job log fetch failed for build {build_number}: {exc}"
            ) from exc
        return _ANSI_ESCAPE.sub("", body)


def _task_prompt(target: MainCIAnalysisTarget) -> str:
    return (
        "Analyze this Main CI failure alert. Read context.json for the alert "
        f"episode and job_log.txt for the tail of the failing job's log "
        f"(job {target.job_name!r}, Buildkite job {target.failure_job_id} in "
        f"build #{target.failure_build_number}). Investigate as the "
        "instructions describe, then write analysis.json with exactly the "
        "required keys. Credentials are available only through the "
        "environment; never include their values in prompts, files, or output."
    )


def _context_payload(
    target: MainCIAnalysisTarget, pr: PullRequestRef | None
) -> dict[str, Any]:
    return {
        "alert_id": target.alert_id,
        "job_key": target.job_key,
        "job_name": target.job_name,
        "opened_at": target.opened_at.isoformat(),
        "last_failed_at": target.last_failed_at.isoformat(),
        "failure_count": target.failure_count,
        "failure": {
            "buildkite_job_id": target.failure_job_id,
            "build_number": target.failure_build_number,
            "build_url": target.failure_build_url,
            "job_url": target.failure_job_url,
            "commit_sha": target.failure_commit_sha,
        },
        "pull_request": (
            {"number": pr.number, "url": pr.url, "title": pr.title}
            if pr is not None
            else None
        ),
    }


def _require_string(payload: dict[str, Any], key: str, limit: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise AnalyzerError(f"analysis {key} is missing or not a string")
    if len(value) > limit:
        raise AnalyzerError(f"analysis {key} exceeds {limit} characters")
    return value


def _parse_fix_prs(payload: Any) -> tuple[SuspectedFixPR, ...]:
    if not isinstance(payload, list):
        raise AnalyzerError("analysis suspected_fix_prs is not a list")
    parsed: list[SuspectedFixPR] = []
    for entry in payload:
        if not isinstance(entry, dict) or not isinstance(entry.get("url"), str):
            raise AnalyzerError("analysis suspected_fix_prs entry has no url")
        item = cast(dict[str, Any], entry)
        number = item.get("number")
        if number is not None and not isinstance(number, int):
            raise AnalyzerError("analysis suspected_fix_prs number is not an int")
        title = item.get("title")
        parsed.append(
            SuspectedFixPR(
                url=str(item["url"]),
                number=number,
                title=title if isinstance(title, str) else "",
            )
        )
    return tuple(parsed)


def read_analysis(
    path: Path, *, target: MainCIAnalysisTarget, model_version: str
) -> MainCIJobAnalysis:
    """Validate the model's strict-JSON output; any defect raises."""
    if not path.is_file():
        raise AnalyzerError("analyzer wrote no analysis.json")
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise AnalyzerError(f"analyzer wrote unreadable analysis.json: {exc}") from exc
    if not isinstance(payload, dict):
        raise AnalyzerError("analysis.json is not a JSON object")
    payload = cast(dict[str, Any], payload)

    classification = payload.get("classification")
    if classification not in CLASSIFICATIONS:
        raise AnalyzerError(f"analysis classification is invalid: {classification!r}")
    confidence = payload.get("confidence")
    if confidence not in CONFIDENCES:
        raise AnalyzerError(f"analysis confidence is invalid: {confidence!r}")
    evidence = payload.get("evidence_urls")
    if not isinstance(evidence, list) or not all(
        isinstance(url, str) for url in evidence
    ):
        raise AnalyzerError("analysis evidence_urls is not a list of strings")

    return MainCIJobAnalysis(
        alert_id=target.alert_id,
        analyzed_failure_job_id=target.failure_job_id,
        classification=str(classification),
        confidence=str(confidence),
        summary=_require_string(payload, "summary", SUMMARY_CHAR_LIMIT),
        evidence_urls=tuple(str(url) for url in evidence),
        recommended_action=_require_string(
            payload, "recommended_action", ACTION_CHAR_LIMIT
        ),
        suspected_fix_prs=_parse_fix_prs(payload.get("suspected_fix_prs")),
        model_version=model_version,
    )


class MainCIAnalysisHandler:
    """Analyze every pending Main CI alert, newest failure first."""

    def __init__(
        self,
        *,
        store: MainCIAnalysisStore,
        logs: BuildkiteJobLogPort,
        github: GitHubPort,
        runner: MainCIAnalysisRunner,
        clock: Clock,
        model_version: str,
        analyses_per_tick: int = ANALYSES_PER_TICK,
    ) -> None:
        self._store = store
        self._logs = logs
        self._github = github
        self._runner = runner
        self._clock = clock
        self._model_version = model_version
        self._analyses_per_tick = analyses_per_tick

    def __call__(self, command: ScheduledCommand) -> None:
        # Each alert commits independently; the runtime completes this
        # command's execution after the handler returns, and a failed alert
        # stays pending for the next tick with its previous analysis intact.
        instructions = load_instructions(INSTRUCTIONS_ASSET)
        for target in self._store.pending_main_ci_analyses(
            limit=self._analyses_per_tick
        ):
            try:
                self._analyze(target, instructions)
            except AnalyzerError:
                continue

    def _analyze(self, target: MainCIAnalysisTarget, instructions: str) -> None:
        log_text = self._logs.job_log_text(
            build_number=target.failure_build_number,
            job_id=target.failure_job_id,
        )
        if len(log_text) > JOB_LOG_CHAR_LIMIT:
            # Buildkite logs put the failure at the end; keep the tail.
            log_text = "... (truncated)\n" + log_text[-JOB_LOG_CHAR_LIMIT:]
        try:
            pull_request = self._github.pull_for_commit(target.failure_commit_sha)
        except Exception:  # noqa: BLE001 — PR context is supplementary
            pull_request = None

        with tempfile.TemporaryDirectory(prefix="main-ci-analysis-") as tmp:
            workdir = Path(tmp)
            (workdir / CONTEXT_FILE).write_text(
                json.dumps(_context_payload(target, pull_request), indent=2)
            )
            (workdir / JOB_LOG_FILE).write_text(log_text)
            self._runner.run(
                workdir, instructions=instructions, prompt=_task_prompt(target)
            )
            analysis = read_analysis(
                workdir / ANALYSIS_FILE,
                target=target,
                model_version=self._model_version,
            )
        self._store.commit_main_ci_analysis(analysis=analysis, now=self._clock.now())
