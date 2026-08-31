"""Full CI analyzer compatibility adapter behavior through the runtime seam."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from alerting.analyzer import (
    CHECKPOINT_SCHEMA_VERSION,
    REPORT_CHAR_LIMIT,
    AnalyzerError,
    CauseCategory,
    CheckpointRef,
    CheckpointUnavailable,
    CompletedAnalysis,
    FailureCache,
    FailureCondition,
    FailureLifecycle,
    FullCIAnalysisHandler,
    PullRequestRef,
    pack_checkpoint,
    unpack_checkpoint,
)
from alerting.commands import ScheduledCommand
from alerting.full_ci import FullCIReconciliationHandler, FullCIRun
from alerting.memory import (
    FixedClock,
    InMemoryAnalyzerStore,
    InMemoryAutomationExecutionStore,
    InMemoryFullCIStore,
    InMemoryOutboxStore,
    RecordingSlackPort,
)
from alerting.ports import (
    AlertPath,
    DeliveryMode,
    DestinationMode,
    NotificationIntent,
    NotificationIntentRecord,
)
from alerting.runtime import AlertingRuntime, ProcessResult, ProcessStatus

START = datetime(2026, 8, 27, 6, 0, tzinfo=timezone.utc)
RUN1_AT = START - timedelta(hours=9)
RUN2_AT = START
RUN3_AT = START + timedelta(hours=9)


def make_run(build_number: int, scheduled_at: datetime) -> FullCIRun:
    return FullCIRun(
        build_id=f"build-{build_number}",
        build_number=build_number,
        scheduled_at=scheduled_at,
        commit_sha=f"commit-{build_number}",
        message="Full CI run - nightly",
        state="passed",
        jobs=(),
    )


def build_json(
    build_number: int,
    jobs: list[tuple[str, str, bool]],
    *,
    scheduled_at: datetime,
    state: str = "failed",
) -> dict[str, object]:
    """(name, state, soft_failed) job rows in the Buildkite build JSON shape."""
    return {
        "number": build_number,
        "state": state,
        "web_url": f"https://buildkite.com/vllm/ci/builds/{build_number}",
        "commit": f"commit-{build_number}",
        "message": "Full CI run - nightly",
        "scheduled_at": scheduled_at.isoformat(),
        "started_at": scheduled_at.isoformat(),
        "finished_at": (scheduled_at + timedelta(hours=2)).isoformat(),
        "jobs": [
            {"name": name, "state": job_state, "soft_failed": soft}
            for name, job_state, soft in jobs
        ],
    }


def mostly_passing_jobs(
    failures: list[tuple[str, str, bool]], *, total: int = 20
) -> list[tuple[str, str, bool]]:
    padding = [
        (f"Padding Job {index}", "passed", False)
        for index in range(total - len(failures))
    ]
    return failures + padding


class FakeBuildPort:
    def __init__(self, builds: dict[int, dict[str, object]]) -> None:
        self.builds = builds
        self._fail = False

    def fail_next(self) -> None:
        self._fail = True

    def get_build(self, build_number: int) -> dict[str, object]:
        if self._fail:
            self._fail = False
            raise RuntimeError("Buildkite is unavailable")
        return self.builds[build_number]


def well_behaved(
    working_dir: Path,
    *,
    report: str = "*Build:* fine",
    suspicious: tuple[dict[str, object], ...] = (),
    memory_note: str | None = None,
) -> None:
    """A faithful analyzer: classifies from the summary and writes all outputs."""
    logs = working_dir / ".logs"
    summary = json.loads((logs / "nightly_summary.json").read_text())
    hard = {
        job["name"]
        for job in summary["jobs"]
        if job["state"] == "failed" and not job["soft_failed"]
    }
    previous = set(summary["previous_failures"]["failed_tests"])
    passed = {job["name"] for job in summary["jobs"] if job["state"] == "passed"}
    durable_failures = sorted(hard | (previous - passed))
    (logs / "ci_report.txt").write_text(report)
    (logs / "failed_tests_cache.json").write_text(
        json.dumps(
            {
                "build_number": summary["number"],
                "commit": summary["commit"],
                "failed_tests": durable_failures,
            }
        )
    )
    (logs / "suspicious_prs.json").write_text(
        json.dumps(
            {
                "build_number": summary["number"],
                "commit": summary["commit"],
                "suspicious_prs": list(suspicious),
            }
        )
    )
    if memory_note is not None:
        memory = working_dir / ".claude/agent-memory/vllm-ci-failure-analyzer"
        memory.mkdir(parents=True, exist_ok=True)
        (memory / "MEMORY.md").write_text(memory_note)


class FakeRunner:
    def __init__(self) -> None:
        self._behaviors: list[Callable[[Path], None]] = []
        self._fail = False
        self.runs = 0

    def on_run(self, behavior: Callable[[Path], None]) -> None:
        self._behaviors.append(behavior)

    def fail_next(self) -> None:
        self._fail = True

    def run(self, working_dir: Path) -> None:
        self.runs += 1
        if self._fail:
            self._fail = False
            raise AnalyzerError("LLM invocation failed")
        if self._behaviors:
            self._behaviors.pop(0)(working_dir)
        else:
            well_behaved(working_dir)


class FakeCheckpoints:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self._fail = False
        self._unavailable = False

    def fail_next(self) -> None:
        self._fail = True

    def make_unavailable(self) -> None:
        """Simulate a stack recreation stranding stored checkpoint URIs."""
        self._unavailable = True

    def upload(self, files: Mapping[str, bytes]) -> CheckpointRef:
        if self._fail:
            self._fail = False
            raise RuntimeError("S3 is unavailable")
        blob = pack_checkpoint(files)
        digest = hashlib.sha256(blob).hexdigest()
        # Versioned keys: every upload is a new object, even for equal content.
        uri = f"s3://test-checkpoints/{len(self.objects)}-{digest[:12]}.tar.gz"
        self.objects[uri] = blob
        return CheckpointRef(
            s3_uri=uri, sha256=digest, schema_version=CHECKPOINT_SCHEMA_VERSION
        )

    def download(self, s3_uri: str) -> bytes:
        if self._unavailable:
            raise CheckpointUnavailable(f"bucket is gone: {s3_uri}")
        if s3_uri not in self.objects:
            raise RuntimeError(f"checkpoint object missing: {s3_uri}")
        return self.objects[s3_uri]


class FakeGitHub:
    def __init__(self) -> None:
        self.merged_reverts: dict[int, PullRequestRef] = {}
        self.commit_prs: dict[str, PullRequestRef] = {}
        self.revert_lookups: list[int] = []

    def pull_for_commit(self, commit_sha: str) -> PullRequestRef | None:
        return self.commit_prs.get(commit_sha)

    def find_merged_revert(self, pr_number: int) -> PullRequestRef | None:
        self.revert_lookups.append(pr_number)
        return self.merged_reverts.get(pr_number)


class Harness:
    def __init__(
        self,
        *,
        runs: list[FullCIRun],
        builds: dict[int, dict[str, object]],
        seed_checkpoint: bool = True,
        delivery_mode: DeliveryMode = DeliveryMode.LIVE,
    ) -> None:
        self.clock = FixedClock(START)
        self.executions = InMemoryAutomationExecutionStore()
        self.outbox = InMemoryOutboxStore()
        self.full_ci = InMemoryFullCIStore(executions=self.executions)
        self.store = InMemoryAnalyzerStore(full_ci=self.full_ci, outbox=self.outbox)
        self.builds = FakeBuildPort(builds)
        self.runner = FakeRunner()
        self.checkpoints = FakeCheckpoints()
        self.github = FakeGitHub()
        self._seeded_delivery_ids: set[str] = set()
        if seed_checkpoint:
            self._seed_initial_checkpoint()
        slack = RecordingSlackPort()
        reconcile_runtime = AlertingRuntime(
            executions=self.executions,
            outbox=self.outbox,
            slack=slack,
            clock=self.clock,
            handlers={
                "full_ci_reconcile": FullCIReconciliationHandler(
                    source=_FixtureSource(runs), store=self.full_ci, clock=self.clock
                )
            },
        )
        reconcile_runtime.process_command(
            ScheduledCommand(command_type="full_ci_reconcile", target_time=RUN3_AT)
        )
        self.runtime = AlertingRuntime(
            executions=self.executions,
            outbox=self.outbox,
            slack=slack,
            clock=self.clock,
            handlers={
                "full_ci_analyze": FullCIAnalysisHandler(
                    store=self.store,
                    builds=self.builds,
                    runner=self.runner,
                    checkpoints=self.checkpoints,
                    github=self.github,
                    clock=self.clock,
                    delivery_mode=delivery_mode,
                )
            },
        )

    def _seed_initial_checkpoint(self) -> None:
        ref = self.checkpoints.upload({"MEMORY.md": b"# seed memory\n"})
        self.store.seed_checkpoint(ref)

    def analyze(self, *, target: datetime = RUN3_AT) -> ProcessResult:
        return self.runtime.process_command(
            ScheduledCommand(command_type="full_ci_analyze", target_time=target)
        )

    def seed_analysis(
        self,
        run: FullCIRun,
        *,
        failed_tests: tuple[str, ...],
        conditions: tuple[FailureCondition, ...] = (),
    ) -> None:
        checkpoint = self.store.latest_checkpoint()
        if checkpoint is None:
            checkpoint = self.checkpoints.upload({"MEMORY.md": b"# seed\n"})
        delivery_id = f"full-ci:{run.build_id}"
        self._seeded_delivery_ids.add(delivery_id)
        self.store.commit_analysis(
            analysis=CompletedAnalysis(
                current_build_id=run.build_id,
                previous_build_id="build-0",
                report_text="seeded report",
                failure_cache=FailureCache(
                    build_number=run.build_number,
                    commit=run.commit_sha,
                    failed_tests=failed_tests,
                ),
                suspicious_prs=(),
                conditions=conditions,
                checkpoint=checkpoint,
            ),
            notification=NotificationIntent(
                delivery_id=delivery_id,
                alert_ref=f"full-ci-comparison:{run.build_id}",
                alert_path=AlertPath.FULL_CI,
                delivery_mode=DeliveryMode.LIVE,
                destination_mode=DestinationMode.WEBHOOK,
                destination="vllm-ci",
                payload={"text": "seeded report"},
            ),
            now=self.clock.now(),
        )

    def new_notifications(self) -> list[NotificationIntentRecord]:
        """Outbox records enqueued by analysis, excluding seeded baselines."""
        return [
            record
            for record in self.outbox.records()
            if record.delivery_id not in self._seeded_delivery_ids
        ]


class _FixtureSource:
    def __init__(self, runs: list[FullCIRun]) -> None:
        self._runs = runs

    def fetch_runs(
        self,
        *,
        start_time: datetime | None,
        processed_build_ids: frozenset[str],
        up_to: datetime,
    ) -> list[FullCIRun]:
        return [
            run
            for run in self._runs
            if run.build_id not in processed_build_ids and run.scheduled_at <= up_to
        ]


def suspicious_pr(pr_number: int, failed_tests: list[str]) -> dict[str, object]:
    return {
        "pr_number": pr_number,
        "pr_url": f"https://github.com/vllm-project/vllm/pull/{pr_number}",
        "pr_title": f"PR {pr_number} title",
        "failure_count": len(failed_tests),
        "failed_tests": failed_tests,
        "summary": f"PR {pr_number} broke it",
    }


def notification_for(harness: Harness, build_id: str) -> NotificationIntentRecord:
    record = harness.outbox.get_outbox(f"full-ci:{build_id}")
    assert record is not None, f"no notification enqueued for {build_id}"
    return record


def test_analysis_persists_conditions_report_checkpoint_and_notification() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs(
                    [
                        ("Job A", "failed", False),
                        ("Job B", "failed", False),
                        ("Job C", "failed", True),
                    ]
                ),
                scheduled_at=RUN2_AT,
            )
        },
    )
    harness.seed_analysis(
        run1,
        failed_tests=("Job A",),
        conditions=(
            FailureCondition(
                job_name="Job A",
                lifecycle=FailureLifecycle.NEW,
                cause=CauseCategory.INFRASTRUCTURE,
                summary="env: disk full",
            ),
        ),
    )
    harness.runner.on_run(
        lambda wd: well_behaved(
            wd,
            report="*🆕 New failures (1):*\n• Job B — _suspicious: <https://github.com/vllm-project/vllm/pull/101|PR #101> changed related files_",
            suspicious=(suspicious_pr(101, ["Job B"]),),
            memory_note="# learned",
        )
    )

    result = harness.analyze()

    assert result.status is ProcessStatus.COMPLETED
    analyses = harness.store.analyses()
    assert [analysis.current_build_id for analysis in analyses] == [
        run1.build_id,
        run2.build_id,
    ]
    analysis = analyses[-1]
    assert analysis.previous_build_id == run1.build_id
    assert analysis.failure_cache.failed_tests == ("Job A", "Job B")
    conditions = {condition.job_name: condition for condition in analysis.conditions}
    assert conditions["Job A"].lifecycle is FailureLifecycle.RECURRING
    assert conditions["Job A"].cause is CauseCategory.INFRASTRUCTURE
    assert conditions["Job B"].lifecycle is FailureLifecycle.NEW
    assert conditions["Job B"].cause is CauseCategory.CODE
    assert conditions["Job B"].culprit_pr is not None
    assert conditions["Job B"].culprit_pr.number == 101
    assert "Job C" not in conditions  # soft failures are not failure conditions
    checkpoint = harness.store.latest_checkpoint()
    assert checkpoint is not None
    assert checkpoint.s3_uri in harness.checkpoints.objects
    memory_files = unpack_checkpoint(harness.checkpoints.objects[checkpoint.s3_uri])
    assert memory_files["MEMORY.md"] == b"# learned"
    notification = notification_for(harness, run2.build_id)
    assert notification.destination_mode is DestinationMode.BOT_TOKEN
    assert notification.destination == "C0ABTNM9L5U"
    assert "Job B" in notification.payload["text"]


def test_shadow_analysis_persists_report_without_slack_delivery() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
        delivery_mode=DeliveryMode.SHADOW,
    )

    assert harness.analyze().status is ProcessStatus.COMPLETED
    notification = notification_for(harness, run2.build_id)
    assert notification.delivery_mode is DeliveryMode.SHADOW
    assert notification.payload["text"] == "*Build:* fine"
    assert harness.runtime.dispatch_due_notifications().delivered == 0


def test_materialized_working_files_match_skill_contract(tmp_path: Path) -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs(
                    [("Job A", "failed", False), ("AMD Job", "failed", False)]
                ),
                scheduled_at=RUN2_AT,
            )
        },
    )
    harness.seed_analysis(run1, failed_tests=("Job A",))
    observed: dict[str, Any] = {}

    def capture(working_dir: Path) -> None:
        logs = working_dir / ".logs"
        observed["summary"] = json.loads((logs / "nightly_summary.json").read_text())
        observed["full"] = json.loads((logs / "nightly_full.json").read_text())
        observed["cache"] = json.loads((logs / "failed_tests_cache.json").read_text())
        memory = working_dir / ".claude/agent-memory/vllm-ci-failure-analyzer"
        observed["memory"] = (memory / "MEMORY.md").read_text()
        observed["agent"] = (
            working_dir / ".claude/agents/vllm-ci-failure-analyzer.md"
        ).read_text()
        well_behaved(working_dir)

    harness.runner.on_run(capture)
    harness.analyze()

    summary = observed["summary"]
    assert summary["number"] == 2
    assert summary["skip_report"] is False
    assert summary["previous_failures"]["failed_tests"] == ["Job A"]
    names = {job["name"] for job in summary["jobs"]}
    assert "AMD Job" not in names  # NVIDIA-only filter is preserved
    full_names = {job["name"] for job in observed["full"]["jobs"]}
    assert "AMD Job" in full_names
    assert observed["cache"]["failed_tests"] == ["Job A"]
    assert observed["memory"] == "# seed memory\n"
    assert "Phase A" in observed["agent"]
    assert "Phase D" in observed["agent"]
    assert "git push" not in observed["agent"]


def test_first_comparison_uses_imported_failure_cache_and_checkpoint() -> None:
    imported = make_run(1, RUN1_AT)
    current = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[imported, current],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
        seed_checkpoint=False,
    )
    checkpoint = harness.checkpoints.upload(
        {
            "MEMORY.md": b"# imported memory\n",
            "classification.md": b"legacy classification\n",
        }
    )
    harness.store.seed_imported_baseline(
        build_id=imported.build_id,
        failure_cache=FailureCache(
            build_number=imported.build_number,
            commit=imported.commit_sha,
            failed_tests=("Job A",),
        ),
        checkpoint=checkpoint,
    )
    observed: dict[str, Any] = {}

    def capture(working_dir: Path) -> None:
        logs = working_dir / ".logs"
        observed["cache"] = json.loads((logs / "failed_tests_cache.json").read_text())
        memory = working_dir / ".claude/agent-memory/vllm-ci-failure-analyzer"
        observed["memory"] = {
            str(path.relative_to(memory)): path.read_text()
            for path in memory.rglob("*")
            if path.is_file()
        }
        well_behaved(working_dir)

    harness.runner.on_run(capture)

    assert harness.analyze().status is ProcessStatus.COMPLETED
    assert observed["cache"] == {
        "build_number": 1,
        "commit": "commit-1",
        "failed_tests": ["Job A"],
    }
    assert observed["memory"] == {
        "MEMORY.md": "# imported memory\n",
        "classification.md": "legacy classification\n",
    }
    condition = harness.store.analyses()[0].conditions[0]
    assert condition.job_name == "Job A"
    assert condition.lifecycle is FailureLifecycle.RECURRING


def test_first_ever_analysis_without_any_checkpoint_starts_with_empty_memory() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
        seed_checkpoint=False,
    )
    observed: dict[str, Any] = {}

    def capture(working_dir: Path) -> None:
        memory = working_dir / ".claude/agent-memory/vllm-ci-failure-analyzer"
        observed["memory_files"] = (
            list(memory.rglob("*")) if memory.is_dir() else []
        )
        well_behaved(working_dir)

    harness.runner.on_run(capture)

    assert harness.analyze().status is ProcessStatus.COMPLETED
    assert observed["memory_files"] == []
    checkpoint = harness.store.latest_checkpoint()
    assert checkpoint is not None
    assert harness.store.analyses()[0].current_build_id == run2.build_id


def test_fixed_requires_a_positively_observed_pass() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs(
                    [
                        ("Fixed Job", "passed", False),
                        ("Timed Out Job", "timed_out", False),
                        ("Running Job", "running", False),
                        ("Canceled Job", "canceled", False),
                        ("Scheduled Job", "scheduled", False),
                        ("Soft Job", "failed", True),
                    ],
                    total=120,
                ),
                scheduled_at=RUN2_AT,
            )
        },
    )
    harness.seed_analysis(
        run1,
        failed_tests=(
            "Fixed Job",
            "Timed Out Job",
            "Running Job",
            "Canceled Job",
            "Scheduled Job",
            "Absent Job",
            "Soft Job",
        ),
    )

    harness.analyze()

    analysis = harness.store.analyses()[-1]
    fixed = {
        condition.job_name: condition
        for condition in analysis.conditions
        if condition.lifecycle is FailureLifecycle.FIXED
    }
    assert set(fixed) == {"Fixed Job"}
    assert fixed["Fixed Job"].summary == "passed without a verified cause"
    assert all(condition.fixing_pr is None for condition in fixed.values())
    assert set(analysis.failure_cache.failed_tests) == {
        "Timed Out Job",
        "Running Job",
        "Canceled Job",
        "Scheduled Job",
        "Absent Job",
        "Soft Job",
    }


def test_fixed_with_verified_merged_revert_is_a_code_fix() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "passed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
    )
    harness.seed_analysis(
        run1,
        failed_tests=("Job A",),
        conditions=(
            FailureCondition(
                job_name="Job A",
                lifecycle=FailureLifecycle.NEW,
                cause=CauseCategory.CODE,
                summary="suspicious PR",
                culprit_pr=PullRequestRef(
                    number=100,
                    url="https://github.com/vllm-project/vllm/pull/100",
                    title="bad change",
                ),
            ),
        ),
    )
    harness.github.merged_reverts[100] = PullRequestRef(
        number=200,
        url="https://github.com/vllm-project/vllm/pull/200",
        title='Revert "bad change" (#100)',
    )

    harness.analyze()

    condition = harness.store.analyses()[-1].conditions[0]
    assert condition.lifecycle is FailureLifecycle.FIXED
    assert condition.cause is CauseCategory.CODE
    assert condition.fixing_pr is not None
    assert condition.fixing_pr.number == 200


@pytest.mark.parametrize(
    ("prior_cause", "expected_cause"),
    [
        (CauseCategory.INFRASTRUCTURE, CauseCategory.INFRASTRUCTURE),
        (CauseCategory.FLAKY_TEST, CauseCategory.FLAKY_TEST),
        (CauseCategory.CODE, CauseCategory.UNKNOWN),
        (CauseCategory.UNKNOWN, CauseCategory.UNKNOWN),
    ],
)
def test_unverified_recovery_stays_distinct_and_invents_no_fixing_pr(
    prior_cause: CauseCategory, expected_cause: CauseCategory
) -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "passed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
    )
    harness.seed_analysis(
        run1,
        failed_tests=("Job A",),
        conditions=(
            FailureCondition(
                job_name="Job A",
                lifecycle=FailureLifecycle.NEW,
                cause=prior_cause,
                summary="prior summary",
                culprit_pr=(
                    PullRequestRef(
                        number=100,
                        url="https://github.com/vllm-project/vllm/pull/100",
                        title="bad change",
                    )
                    if prior_cause is CauseCategory.CODE
                    else None
                ),
            ),
        ),
    )

    harness.analyze()

    condition = harness.store.analyses()[-1].conditions[0]
    assert condition.lifecycle is FailureLifecycle.FIXED
    assert condition.cause is expected_cause
    assert condition.fixing_pr is None


def test_llm_failure_preserves_baseline_and_recovers_on_retry() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
    )
    harness.seed_analysis(run1, failed_tests=())
    harness.runner.fail_next()

    failed = harness.analyze()

    assert failed.status is ProcessStatus.FAILED
    assert len(harness.store.analyses()) == 1  # only the seeded baseline
    assert harness.new_notifications() == []
    # The seeded baseline stays authoritative for the next comparison.
    assert harness.store.failure_cache_before(RUN2_AT).failed_tests == ()

    harness.clock.advance(minutes=31)  # let the execution lease expire
    retried = harness.analyze()

    assert retried.status is ProcessStatus.COMPLETED
    assert harness.store.analyses()[-1].current_build_id == run2.build_id
    notification_for(harness, run2.build_id)


@pytest.mark.parametrize(
    "behavior",
    [
        pytest.param(lambda wd: well_behaved(wd, report="SKIP"), id="skip-report"),
        pytest.param(
            lambda wd: well_behaved(wd, report="x" * (REPORT_CHAR_LIMIT + 1)),
            id="oversized-report",
        ),
        pytest.param(lambda wd: None, id="no-outputs"),
        pytest.param(
            lambda wd: _write_cache_only(wd, failed_tests=["Wrong Job"]),
            id="cache-mismatch",
        ),
    ],
)
def test_invalid_analyzer_result_preserves_baseline(
    behavior: Callable[[Path], None],
) -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
    )
    harness.seed_analysis(run1, failed_tests=())
    harness.runner.on_run(behavior)

    result = harness.analyze()

    assert result.status is ProcessStatus.FAILED
    assert len(harness.store.analyses()) == 1
    assert harness.new_notifications() == []


def _write_cache_only(working_dir: Path, *, failed_tests: list[str]) -> None:
    logs = working_dir / ".logs"
    summary = json.loads((logs / "nightly_summary.json").read_text())
    (logs / "ci_report.txt").write_text("*Build:* fine")
    (logs / "failed_tests_cache.json").write_text(
        json.dumps(
            {
                "build_number": summary["number"],
                "commit": summary["commit"],
                "failed_tests": failed_tests,
            }
        )
    )
    (logs / "suspicious_prs.json").write_text(
        json.dumps(
            {
                "build_number": summary["number"],
                "commit": summary["commit"],
                "suspicious_prs": [],
            }
        )
    )


def test_corrupted_checkpoint_leaves_baseline_authoritative() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
    )
    # Corrupt the object behind the referenced URI without changing the URI.
    referenced = harness.store.latest_checkpoint()
    assert referenced is not None
    harness.checkpoints.objects[referenced.s3_uri] = b"corrupted"

    result = harness.analyze()

    assert result.status is ProcessStatus.FAILED
    assert "checksum" in (result.error or "")
    assert harness.store.analyses() == []
    assert harness.outbox.records() == []
    assert harness.runner.runs == 0


def test_stranded_checkpoint_uri_restarts_from_empty_memory() -> None:
    """A recreated stack's new bucket strands old URIs; analysis must not wedge."""
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
    )
    assert harness.store.latest_checkpoint() is not None
    harness.checkpoints.make_unavailable()
    observed: dict[str, Any] = {}

    def capture(working_dir: Path) -> None:
        memory = working_dir / ".claude/agent-memory/vllm-ci-failure-analyzer"
        observed["memory_files"] = (
            list(memory.rglob("*")) if memory.is_dir() else []
        )
        well_behaved(working_dir)

    harness.runner.on_run(capture)

    assert harness.analyze().status is ProcessStatus.COMPLETED
    assert observed["memory_files"] == []
    # The completed analysis uploads the new bucket's first checkpoint.
    assert harness.store.latest_checkpoint() is not None
    analyses = harness.store.analyses()
    assert [analysis.current_build_id for analysis in analyses] == [run2.build_id]


def test_failure_before_analysis_persists_nothing() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
    )
    harness.builds.fail_next()

    result = harness.analyze()

    assert result.status is ProcessStatus.FAILED
    assert harness.store.analyses() == []
    assert harness.runner.runs == 0


def test_crash_after_upload_leaves_only_an_unreferenced_object() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
    )
    harness.store.fail_next_commit()

    failed = harness.analyze()

    assert failed.status is ProcessStatus.FAILED
    assert harness.store.analyses() == []
    assert harness.outbox.records() == []
    orphaned = set(harness.checkpoints.objects)
    assert len(orphaned) == 2  # seed checkpoint + uploaded-but-unreferenced

    harness.clock.advance(minutes=31)
    retried = harness.analyze()

    assert retried.status is ProcessStatus.COMPLETED
    referenced = harness.store.latest_checkpoint()
    assert referenced is not None
    assert referenced.s3_uri in harness.checkpoints.objects


def test_crash_after_commit_before_completion_is_idempotent_on_retry() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
    )
    harness.executions.fail_next_complete()

    with pytest.raises(RuntimeError, match="completion marker lost"):
        harness.analyze()

    assert len(harness.store.analyses()) == 1

    harness.clock.advance(minutes=31)
    retried = harness.analyze()

    assert retried.status is ProcessStatus.COMPLETED
    assert len(harness.store.analyses()) == 1  # no duplicate analysis
    assert len(harness.outbox.records()) == 1  # no duplicate notification
    assert harness.runner.runs == 1  # analyzer not re-run for completed work


def test_incomplete_build_is_left_pending_not_analyzed() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                [
                    ("Job A", "passed", False),
                    ("Job B", "running", False),
                ],
                scheduled_at=RUN2_AT,
                state="running",
            )
        },
    )

    result = harness.analyze()

    assert result.status is ProcessStatus.COMPLETED
    assert harness.store.analyses() == []
    assert harness.runner.runs == 0
    pending = harness.store.pending_comparisons()
    assert [context.current.build_id for context in pending] == [run2.build_id]


def test_incomplete_oldest_comparison_blocks_newer_analysis() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    run3 = make_run(3, RUN3_AT)
    harness = Harness(
        runs=[run1, run2, run3],
        builds={
            2: build_json(
                2,
                [("Job A", "passed", False), ("Job B", "running", False)],
                scheduled_at=RUN2_AT,
                state="running",
            ),
            3: build_json(
                3,
                mostly_passing_jobs([("Job C", "failed", False)]),
                scheduled_at=RUN3_AT,
            ),
        },
    )

    result = harness.analyze()

    assert result.status is ProcessStatus.COMPLETED
    assert harness.store.analyses() == []
    assert harness.runner.runs == 0


def test_missed_comparisons_are_analyzed_chronologically() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    run3 = make_run(3, RUN3_AT)
    harness = Harness(
        runs=[run1, run2, run3],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            ),
            3: build_json(
                3,
                mostly_passing_jobs(
                    [("Job A", "failed", False), ("Job B", "failed", False)]
                ),
                scheduled_at=RUN3_AT,
            ),
        },
    )

    result = harness.analyze()

    assert result.status is ProcessStatus.COMPLETED
    analyses = harness.store.analyses()
    assert [analysis.current_build_id for analysis in analyses] == [
        run2.build_id,
        run3.build_id,
    ]
    assert analyses[0].failure_cache.failed_tests == ("Job A",)
    # The second comparison's baseline is the first comparison's fresh cache.
    assert analyses[1].failure_cache.failed_tests == ("Job A", "Job B")
    lifecycles = {
        condition.job_name: condition.lifecycle for condition in analyses[1].conditions
    }
    assert lifecycles == {
        "Job A": FailureLifecycle.RECURRING,
        "Job B": FailureLifecycle.NEW,
    }
    notification_for(harness, run2.build_id)
    notification_for(harness, run3.build_id)


def test_duplicate_tick_skips_completed_analysis() -> None:
    run1 = make_run(1, RUN1_AT)
    run2 = make_run(2, RUN2_AT)
    harness = Harness(
        runs=[run1, run2],
        builds={
            2: build_json(
                2,
                mostly_passing_jobs([("Job A", "failed", False)]),
                scheduled_at=RUN2_AT,
            )
        },
    )

    first = harness.analyze()
    second = harness.analyze()

    assert first.status is ProcessStatus.COMPLETED
    assert second.status is ProcessStatus.SKIPPED_ALREADY_COMPLETED
    assert len(harness.store.analyses()) == 1
    assert harness.runner.runs == 1


def test_checkpoint_packing_is_deterministic() -> None:
    files = {"b.md": b"two", "a.md": b"one"}
    assert pack_checkpoint(files) == pack_checkpoint(
        dict(reversed(list(files.items())))
    )
    unpacked = unpack_checkpoint(pack_checkpoint(files))
    assert unpacked == {"a.md": b"one", "b.md": b"two"}
