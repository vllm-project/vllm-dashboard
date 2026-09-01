"""Main CI analysis sidecar behavior through the scheduled-command seam."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from alerting.analyzer import AnalyzerError, PullRequestRef
from alerting.commands import ScheduledCommand
from alerting.main_ci import MainCIJobObservation
from alerting.main_ci_analysis import (
    ACTION_CHAR_LIMIT,
    ANALYSES_PER_TICK,
    SUMMARY_CHAR_LIMIT,
    MainCIAnalysisHandler,
    MainCIAnalysisTarget,
    MainCIJobAnalysis,
    read_analysis,
)
from alerting.memory import (
    FixedClock,
    InMemoryAutomationExecutionStore,
    InMemoryMainCIAnalysisStore,
    InMemoryMainCIStore,
    InMemoryOutboxStore,
    RecordingSlackPort,
)
from alerting.runtime import AlertingRuntime, ProcessStatus

START = datetime(2026, 8, 29, 10, 0, tzinfo=timezone.utc)

VALID_PAYLOAD: dict[str, Any] = {
    "classification": "infra",
    "confidence": "high",
    "summary": "The runner lost its GPU agent before the test binary started.",
    "evidence_urls": ["https://buildkite.com/vllm/ci/builds/101#job-2"],
    "recommended_action": "Re-run the job on a fresh agent.",
    "suspected_fix_prs": [
        {
            "url": "https://github.com/vllm-project/vllm/pull/123",
            "number": 123,
            "title": "Guard against agent loss",
        }
    ],
}


def observation(
    *,
    build_number: int,
    state: str,
    minutes: int,
    job_name: str = "GPU correctness",
) -> MainCIJobObservation:
    job_id = f"job-{build_number}-{state}"
    return MainCIJobObservation(
        job_key=f"step:gpu-test|name:{job_name}",
        job_id=job_id,
        job_name=job_name,
        job_url=f"https://buildkite.com/vllm/ci/builds/{build_number}#{job_id}",
        state=state,
        finished_at=START + timedelta(minutes=minutes),
        build_id=f"build-{build_number}",
        build_number=build_number,
        build_url=f"https://buildkite.com/vllm/ci/builds/{build_number}",
        commit_sha=f"commit-{build_number}",
    )


class FixtureLogs:
    def __init__(self, text: str = "log tail with the error") -> None:
        self.text = text
        self.calls: list[tuple[int, str]] = []

    def job_log_text(self, *, build_number: int, job_id: str) -> str:
        self.calls.append((build_number, job_id))
        return self.text


class FixtureGitHub:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def pull_for_commit(self, commit_sha: str) -> PullRequestRef | None:
        self.calls.append(commit_sha)
        return PullRequestRef(
            number=123,
            url="https://github.com/vllm-project/vllm/pull/123",
            title="Guard against agent loss",
        )

    def find_merged_revert(self, pr_number: int) -> PullRequestRef | None:
        return None


class FixtureRunner:
    """Records each invocation and writes a scripted analysis.json."""

    def __init__(self, payload: dict[str, Any] | None = None) -> None:
        self.payload = VALID_PAYLOAD if payload is None else payload
        self.runs: list[dict[str, Any]] = []
        self._failures = 0

    def fail_next(self, count: int = 1) -> None:
        self._failures += count

    def run(self, working_dir: Path, *, instructions: str, prompt: str) -> None:
        if self._failures > 0:
            self._failures -= 1
            raise AnalyzerError("scripted runner failure")
        context = json.loads((working_dir / "context.json").read_text())
        self.runs.append(
            {
                "context": context,
                "log": (working_dir / "job_log.txt").read_text(),
                "instructions": instructions,
                "prompt": prompt,
            }
        )
        if self.payload is not None:
            (working_dir / "analysis.json").write_text(json.dumps(self.payload))


def seed_alert(
    store: InMemoryMainCIStore,
    executions: InMemoryAutomationExecutionStore,
    *,
    build_number: int = 101,
    state: str = "failed",
    minutes: int = 1,
    job_name: str = "GPU correctness",
) -> None:
    command = ScheduledCommand(
        command_type="main_ci_reconcile",
        target_time=START + timedelta(minutes=minutes + 1),
    )
    executions.claim(
        command,
        now=START,
        lease_until=START + timedelta(minutes=30),
    )
    store.commit_main_ci_scan(
        command=command,
        observations=[
            observation(
                build_number=build_number,
                state=state,
                minutes=minutes,
                job_name=job_name,
            )
        ],
        scanned_through=START + timedelta(minutes=minutes + 1),
        now=START,
    )


def fixture() -> tuple[
    AlertingRuntime,
    InMemoryAutomationExecutionStore,
    InMemoryMainCIStore,
    InMemoryMainCIAnalysisStore,
    FixtureLogs,
    FixtureRunner,
]:
    clock = FixedClock(START)
    executions = InMemoryAutomationExecutionStore()
    main_ci = InMemoryMainCIStore(executions=executions)
    store = InMemoryMainCIAnalysisStore(main_ci=main_ci)
    logs = FixtureLogs()
    runner = FixtureRunner()
    runtime = AlertingRuntime(
        executions=executions,
        outbox=InMemoryOutboxStore(),
        slack=RecordingSlackPort(),
        clock=clock,
        handlers={
            "main_ci_analyze": MainCIAnalysisHandler(
                store=store,
                logs=logs,
                github=FixtureGitHub(),
                runner=runner,
                clock=clock,
                model_version="moonshotai/Kimi-K3",
            )
        },
    )
    return runtime, executions, main_ci, store, logs, runner


def analyze(runtime: AlertingRuntime, target: datetime = START) -> None:
    result = runtime.process_command(
        ScheduledCommand(command_type="main_ci_analyze", target_time=target)
    )
    assert result.status is ProcessStatus.COMPLETED


def test_open_alert_is_analyzed_and_the_sidecar_row_is_stored() -> None:
    runtime, executions, main_ci, store, logs, runner = fixture()
    seed_alert(main_ci, executions)

    analyze(runtime)

    assert logs.calls == [(101, "job-101-failed")]
    assert len(runner.runs) == 1
    run = runner.runs[0]
    assert "CI triage analyst" in run["instructions"]
    assert "job-101-failed" in run["prompt"]
    assert run["context"]["failure"]["buildkite_job_id"] == "job-101-failed"
    assert run["context"]["pull_request"]["number"] == 123
    assert run["log"] == "log tail with the error"
    (analysis,) = store.analyses()
    assert analysis.alert_id == 1
    assert analysis.analyzed_failure_job_id == "job-101-failed"
    assert analysis.classification == "infra"
    assert analysis.model_version == "moonshotai/Kimi-K3"


def test_current_analysis_is_not_recomputed() -> None:
    runtime, executions, main_ci, store, _, runner = fixture()
    seed_alert(main_ci, executions)

    analyze(runtime)
    analyze(runtime, START + timedelta(minutes=10))

    assert len(runner.runs) == 1
    assert len(store.analyses()) == 1


def test_newer_failure_marks_the_alert_pending_for_reanalysis() -> None:
    runtime, executions, main_ci, store, _, runner = fixture()
    seed_alert(main_ci, executions)
    analyze(runtime)

    seed_alert(main_ci, executions, build_number=102, minutes=6)
    analyze(runtime, START + timedelta(minutes=10))

    assert len(runner.runs) == 2
    (analysis,) = store.analyses()
    assert analysis.analyzed_failure_job_id == "job-102-failed"


def test_resolved_alerts_are_not_analyzed() -> None:
    runtime, executions, main_ci, store, _, runner = fixture()
    seed_alert(main_ci, executions)
    seed_alert(main_ci, executions, build_number=102, state="passed", minutes=6)

    analyze(runtime)

    assert runner.runs == []
    assert store.analyses() == []


def test_invalid_model_output_leaves_the_previous_analysis_authoritative() -> None:
    runtime, executions, main_ci, store, _, runner = fixture()
    seed_alert(main_ci, executions)
    analyze(runtime)
    assert len(store.analyses()) == 1

    seed_alert(main_ci, executions, build_number=102, minutes=6)
    runner.payload = {"classification": "definitely-broken"}
    analyze(runtime, START + timedelta(minutes=10))

    (analysis,) = store.analyses()
    assert analysis.analyzed_failure_job_id == "job-101-failed"


def test_runner_failure_skips_the_alert_without_failing_the_tick() -> None:
    runtime, executions, main_ci, store, _, runner = fixture()
    seed_alert(main_ci, executions)
    seed_alert(
        main_ci,
        executions,
        build_number=103,
        minutes=6,
        job_name="AMD correctness",
    )
    runner.fail_next()

    analyze(runtime)

    # The newest failure is analyzed first and scripted to fail; the older
    # open alert is still analyzed in the same tick.
    assert len(runner.runs) == 1
    (analysis,) = store.analyses()
    assert analysis.analyzed_failure_job_id == "job-101-failed"


def test_per_tick_limit_bounds_the_number_of_analyses() -> None:
    runtime, executions, main_ci, _, _, runner = fixture()
    for index in range(ANALYSES_PER_TICK + 2):
        seed_alert(
            main_ci,
            executions,
            build_number=200 + index,
            minutes=index + 1,
            job_name=f"Job {index}",
        )

    analyze(runtime)

    assert len(runner.runs) == ANALYSES_PER_TICK


def test_commit_drops_an_analysis_superseded_by_a_newer_failure() -> None:
    _, executions, main_ci, store, _, _ = fixture()
    seed_alert(main_ci, executions)
    analysis = MainCIJobAnalysis(
        alert_id=1,
        analyzed_failure_job_id="job-101-failed",
        classification="infra",
        confidence="high",
        summary="summary",
        evidence_urls=(),
        recommended_action="retry",
        suspected_fix_prs=(),
        model_version="model",
    )

    seed_alert(main_ci, executions, build_number=102, minutes=6)
    store.commit_main_ci_analysis(analysis=analysis, now=START)

    assert store.analyses() == []


def _target() -> MainCIAnalysisTarget:
    return MainCIAnalysisTarget(
        alert_id=1,
        job_key="step:gpu-test|name:GPU correctness",
        job_name="GPU correctness",
        opened_at=START,
        last_failed_at=START,
        failure_count=1,
        failure_job_id="job-101-failed",
        failure_build_number=101,
        failure_build_url="https://buildkite.com/vllm/ci/builds/101",
        failure_job_url="https://example.test/job-101",
        failure_commit_sha="commit-101",
    )


def _write_payload(tmp_path: Path, payload: Any) -> Path:
    path = tmp_path / "analysis.json"
    path.write_text(json.dumps(payload))
    return path


def test_read_analysis_accepts_the_valid_schema(tmp_path: Path) -> None:
    analysis = read_analysis(
        _write_payload(tmp_path, VALID_PAYLOAD),
        target=_target(),
        model_version="model",
    )

    assert analysis.classification == "infra"
    assert analysis.confidence == "high"
    assert analysis.suspected_fix_prs[0].number == 123
    assert analysis.evidence_urls == ("https://buildkite.com/vllm/ci/builds/101#job-2",)


@pytest.mark.parametrize(
    "patch",
    [
        {"classification": "broken"},
        {"confidence": "certain"},
        {"summary": ""},
        {"evidence_urls": "not-a-list"},
        {"evidence_urls": [42]},
        {"suspected_fix_prs": [{"number": 1}]},
        {"suspected_fix_prs": [{"url": "https://x", "number": "one"}]},
    ],
)
def test_read_analysis_rejects_out_of_schema_output(
    tmp_path: Path, patch: dict[str, Any]
) -> None:
    payload = {**VALID_PAYLOAD, **patch}

    with pytest.raises(AnalyzerError):
        read_analysis(
            _write_payload(tmp_path, payload),
            target=_target(),
            model_version="model",
        )


@pytest.mark.parametrize(
    ("key", "limit"),
    [
        ("summary", SUMMARY_CHAR_LIMIT),
        ("recommended_action", ACTION_CHAR_LIMIT),
    ],
)
def test_read_analysis_truncates_over_limit_strings(
    tmp_path: Path, key: str, limit: int
) -> None:
    over_limit = "x" * (limit + 50)
    payload = {**VALID_PAYLOAD, key: over_limit}

    analysis = read_analysis(
        _write_payload(tmp_path, payload),
        target=_target(),
        model_version="model",
    )

    value = getattr(analysis, key)
    assert len(value) == limit
    assert value == "x" * (limit - 1) + "…"


def test_read_analysis_accepts_summary_up_to_the_limit(tmp_path: Path) -> None:
    payload = {**VALID_PAYLOAD, "summary": "x" * SUMMARY_CHAR_LIMIT}

    analysis = read_analysis(
        _write_payload(tmp_path, payload),
        target=_target(),
        model_version="model",
    )

    assert analysis.summary == "x" * SUMMARY_CHAR_LIMIT


def test_read_analysis_requires_the_output_file(tmp_path: Path) -> None:
    with pytest.raises(AnalyzerError, match="no analysis.json"):
        read_analysis(
            tmp_path / "analysis.json",
            target=_target(),
            model_version="model",
        )
