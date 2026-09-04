"""Postgres Full CI analysis transaction behavior through the runtime seam."""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import TracebackType
from typing import Any, Literal

from alerting.analyzer import (
    CHECKPOINT_SCHEMA_VERSION,
    CauseCategory,
    CheckpointRef,
    FailureLifecycle,
    FullCIAnalysisHandler,
    PullRequestRef,
    pack_checkpoint,
    unpack_checkpoint,
)
from alerting.commands import ScheduledCommand
from alerting.memory import FixedClock, RecordingSlackPort
from alerting.postgres import PostgresAlertStore
from alerting.runtime import AlertingRuntime, ProcessStatus

START = datetime(2026, 8, 27, 6, 0, tzinfo=timezone.utc)
RUN1_AT = START - timedelta(hours=9)
RUN2_AT = START


class Result:
    def __init__(
        self,
        row: tuple[Any, ...] | None = None,
        rows: list[tuple[Any, ...]] | None = None,
        rowcount: int = 0,
    ) -> None:
        self._row = row
        self._rows = rows or []
        self.rowcount = rowcount

    def fetchone(self) -> tuple[Any, ...] | None:
        return self._row

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows


class Transaction:
    def __init__(self, connection: FakePostgresConnection) -> None:
        self.connection = connection
        self.snapshot: dict[str, Any] = {}

    def __enter__(self) -> None:
        self.snapshot = copy.deepcopy(self.connection.state)
        self.connection.transaction_depth += 1

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> Literal[False]:
        self.connection.transaction_depth -= 1
        if exc_type is not None:
            self.connection.state = self.snapshot
        return False


def _run_row(build_number: int, scheduled_at: datetime) -> tuple[Any, ...]:
    return (
        f"build-{build_number}",
        build_number,
        scheduled_at,
        f"commit-{build_number}",
        "Full CI run - nightly",
        "passed",
        None,
        None,
        None,
    )


class _ConnectionCursor:
    """psycopg3-style cursor facade over the fake connection."""

    def __init__(self, connection: "FakePostgresConnection") -> None:
        self._connection = connection

    def __enter__(self) -> "_ConnectionCursor":
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def executemany(self, sql: str, params: list[tuple[Any, ...]]) -> "Result":
        return self._connection.executemany(sql, params)


class FakePostgresConnection:
    """Statement-level model of the Postgres analysis schema."""

    def __init__(self) -> None:
        self.state: dict[str, Any] = {
            "executions": {},
            "runs": {
                "build-100": _run_row(100, RUN1_AT),
                "build-101": _run_row(101, RUN2_AT),
            },
            "jobs": {},
            "comparisons": {"build-101": "build-100"},
            "analyses": {},
            "conditions": {},
            "checkpoints": [],
            "outbox": {},
            "imported_baseline": None,
        }
        self.transaction_depth = 0
        self.fail_conditions_insert = False

    def __enter__(self) -> FakePostgresConnection:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> Literal[False]:
        return False

    def transaction(self) -> Transaction:
        return Transaction(self)

    def _analysis_rows_before(
        self, scheduled_at: datetime
    ) -> list[tuple[str, tuple[Any, ...]]]:
        rows = []
        for build_id, analysis in self.state["analyses"].items():
            run = self.state["runs"][build_id]
            if run[2] < scheduled_at:
                rows.append((build_id, analysis))
        rows.sort(key=lambda item: (self.state["runs"][item[0]][2], item[0]))
        return rows

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Result:
        statement = " ".join(sql.split())
        executions: dict[str, dict[str, Any]] = self.state["executions"]
        if statement.startswith("INSERT INTO alerting_automation_executions"):
            key = params[0]
            if key in executions:
                return Result()
            executions[key] = {"status": "running", "lease": params[4], "attempts": 1}
            return Result((key,))
        if statement.startswith("SELECT status, lease_expires_at"):
            record = executions[params[0]]
            return Result((record["status"], record["lease"]))
        if "SET status = 'running', attempts = attempts + 1" in statement:
            record = executions[params[1]]
            record.update(
                status="running", lease=params[0], attempts=record["attempts"] + 1
            )
            return Result(rowcount=1)
        if "SET status = 'completed'" in statement:
            executions[params[1]].update(status="completed", lease=None)
            return Result(rowcount=1)
        if "SET status = 'failed'" in statement:
            executions[params[1]].update(status="failed", lease=None)
            return Result(rowcount=1)
        if statement.startswith("SELECT c.previous_build_id, r.buildkite_build_id"):
            pending = [
                (previous, *self.state["runs"][current])
                for current, previous in self.state["comparisons"].items()
                if current not in self.state["analyses"]
            ]
            pending.sort(key=lambda row: (row[3], row[2]))
            return Result(rows=pending)
        if statement.startswith("SELECT job_name, state, soft_failed"):
            return Result(
                rows=[
                    row[1:]
                    for row in self.state["jobs"].values()
                    if row[0] == params[0]
                ]
            )
        if statement.startswith(
            "SELECT a.current_build_id, a.previous_build_id, a.report_text"
        ):
            candidates = self._analysis_rows_before(params[0])
            if not candidates:
                return Result()
            build_id, analysis = candidates[-1]
            return Result(row=(build_id, *analysis))
        if statement.startswith("WITH failure_baselines AS"):
            candidates = self._analysis_rows_before(params[0])
            if candidates:
                return Result(row=(candidates[-1][1][2],))
            imported = self.state["imported_baseline"]
            if imported is not None and self.state["runs"][imported[0]][2] < params[0]:
                return Result(row=(imported[1],))
            return Result()
        if (
            statement.startswith(
                "SELECT job_name, lifecycle, cause, summary, culprit_pr_number"
            )
            and "WHERE current_build_id" in statement
        ):
            rows = [
                row[1:]
                for row in self.state["conditions"].values()
                if row[0] == params[0]
            ]
            rows.sort(key=lambda row: row[0])
            return Result(rows=rows)
        if statement.startswith("SELECT fc.job_name"):
            candidates = []
            for row in self.state["conditions"].values():
                if row[1] != params[0]:
                    continue
                run = self.state["runs"][row[0]]
                if run[2] < params[1]:
                    candidates.append(row)
            candidates.sort(key=lambda row: (self.state["runs"][row[0]][2], row[0]))
            if not candidates:
                return Result()
            return Result(row=candidates[-1][1:])
        if statement.startswith("SELECT s3_uri, sha256, schema_version"):
            checkpoints = self.state["checkpoints"]
            if not checkpoints:
                return Result()
            return Result(row=tuple(checkpoints[-1][1:4]))
        if statement.startswith("INSERT INTO alerting_full_ci_analyses"):
            assert self.transaction_depth == 1
            build_id = params[0]
            if build_id in self.state["analyses"]:
                return Result()
            # psycopg returns jsonb columns decoded; mirror that on reads.
            self.state["analyses"][build_id] = (
                params[1],
                params[2],
                json.loads(params[3]),
                json.loads(params[4]),
                params[5],
            )
            return Result((build_id,))
        if statement.startswith("INSERT INTO alerting_analyzer_checkpoints"):
            assert self.transaction_depth == 1
            self.state["checkpoints"].append(params)
            return Result(rowcount=1)
        if statement.startswith("UPDATE alerting_full_ci_runs"):
            assert self.transaction_depth == 1
            run = self.state["runs"][params[3]]
            self.state["runs"][params[3]] = (*run[:6], params[0], params[1], params[2])
            return Result(rowcount=1)
        if statement.startswith("INSERT INTO alerting_notification_outbox"):
            assert self.transaction_depth == 1
            delivery_id = params[0]
            if delivery_id not in self.state["outbox"]:
                self.state["outbox"][delivery_id] = params
            return Result(rowcount=1)
        raise AssertionError(f"unexpected SQL: {statement}")

    def cursor(self) -> _ConnectionCursor:
        return _ConnectionCursor(self)

    def executemany(self, sql: str, params: list[tuple[Any, ...]]) -> Result:
        assert self.transaction_depth == 1
        assert "INSERT INTO alerting_full_ci_failure_conditions" in sql
        if self.fail_conditions_insert:
            self.fail_conditions_insert = False
            raise RuntimeError("database connection lost")
        for row in params:
            self.state["conditions"][(row[0], row[1])] = row
        return Result(rowcount=len(params))


class FakeBuildPort:
    def __init__(self, build: dict[str, Any]) -> None:
        self._build = build

    def get_build(self, build_number: int) -> dict[str, Any]:
        return self._build


class WellBehavedRunner:
    def run(self, working_dir: Path) -> None:
        logs = working_dir / ".logs"
        summary = json.loads((logs / "nightly_summary.json").read_text())
        hard = sorted(
            {
                job["name"]
                for job in summary["jobs"]
                if job["state"] == "failed" and not job["soft_failed"]
            }
        )
        (logs / "ci_report.txt").write_text("*Build:* fine")
        (logs / "failed_tests_cache.json").write_text(
            json.dumps(
                {
                    "build_number": summary["number"],
                    "commit": summary["commit"],
                    "failed_tests": hard,
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


class FakeCheckpoints:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def add(self, uri: str, files: dict[str, bytes]) -> None:
        self.objects[uri] = pack_checkpoint(files)

    def upload(self, files: Mapping[str, bytes]) -> CheckpointRef:
        blob = pack_checkpoint(files)
        digest = hashlib.sha256(blob).hexdigest()
        uri = f"s3://test-checkpoints/{digest[:16]}.tar.gz"
        self.objects[uri] = blob
        return CheckpointRef(
            s3_uri=uri, sha256=digest, schema_version=CHECKPOINT_SCHEMA_VERSION
        )

    def download(self, s3_uri: str) -> bytes:
        return self.objects[s3_uri]


class FakeGitHub:
    """No pull request by default; a test that wants one sets `pull`."""

    def __init__(self, pull: PullRequestRef | None = None) -> None:
        self.pull = pull

    def pull_for_commit(self, commit_sha: str) -> PullRequestRef | None:
        return self.pull

    def find_merged_revert(self, pr_number: int) -> None:
        return None


def make_harness(
    connection: FakePostgresConnection,
    pull: PullRequestRef | None = None,
    jobs: list[dict[str, Any]] | None = None,
) -> tuple[AlertingRuntime, FakeCheckpoints]:
    checkpoints = FakeCheckpoints()
    checkpoints.add("s3://test-checkpoints/seed.tar.gz", {"MEMORY.md": b"# seed\n"})
    seed_digest = hashlib.sha256(
        checkpoints.objects["s3://test-checkpoints/seed.tar.gz"]
    ).hexdigest()
    connection.state["checkpoints"].append(
        (None, "s3://test-checkpoints/seed.tar.gz", seed_digest, 1, RUN1_AT)
    )
    build = {
        "number": 101,
        "state": "failed",
        "web_url": "https://buildkite.com/vllm/ci/builds/101",
        "commit": "commit-101",
        "message": "Full CI run - nightly",
        "scheduled_at": RUN2_AT.isoformat(),
        "started_at": RUN2_AT.isoformat(),
        "finished_at": (RUN2_AT + timedelta(hours=2)).isoformat(),
        "jobs": jobs
        if jobs is not None
        else [
            {"name": "Job A", "state": "failed", "soft_failed": False},
            {"name": "Job B", "state": "passed", "soft_failed": False},
        ],
    }
    store = PostgresAlertStore(lambda: connection)
    clock = FixedClock(START)
    runtime = AlertingRuntime(
        executions=store,
        outbox=store,
        slack=RecordingSlackPort(),
        clock=clock,
        handlers={
            "full_ci_analyze": FullCIAnalysisHandler(
                store=store,
                builds=FakeBuildPort(build),
                runner=WellBehavedRunner(),
                checkpoints=checkpoints,
                github=FakeGitHub(pull),
                clock=clock,
            )
        },
    )
    return runtime, checkpoints


def analyze_command() -> ScheduledCommand:
    return ScheduledCommand(command_type="full_ci_analyze", target_time=RUN2_AT)


def test_commit_analysis_persists_everything_in_one_transaction() -> None:
    connection = FakePostgresConnection()
    runtime, checkpoints = make_harness(connection)

    result = runtime.process_command(analyze_command())

    assert result.status is ProcessStatus.COMPLETED
    assert list(connection.state["analyses"]) == ["build-101"]
    conditions = connection.state["conditions"]
    assert set(conditions) == {("build-101", "Job A")}
    lifecycle, cause = (
        conditions[("build-101", "Job A")][2],
        conditions[("build-101", "Job A")][3],
    )
    assert (lifecycle, cause) == (
        FailureLifecycle.NEW.value,
        CauseCategory.UNKNOWN.value,
    )
    checkpoint_rows = connection.state["checkpoints"]
    assert len(checkpoint_rows) == 2  # imported seed + this analysis
    referenced_uri = checkpoint_rows[-1][1]
    assert referenced_uri in checkpoints.objects  # uploaded before referenced
    assert unpack_checkpoint(checkpoints.objects[referenced_uri]) == {
        "MEMORY.md": b"# seed\n"
    }
    assert "full-ci:build-101" in connection.state["outbox"]
    executions = connection.state["executions"]
    assert executions[analyze_command().idempotency_key]["status"] == "completed"
    # A replayed tick finds nothing pending and re-commits nothing.
    assert runtime.process_command(analyze_command()).status is (
        ProcessStatus.SKIPPED_ALREADY_COMPLETED
    )
    assert list(connection.state["analyses"]) == ["build-101"]


def test_commit_analysis_persists_main_and_amd_notifications() -> None:
    connection = FakePostgresConnection()
    runtime, _ = make_harness(
        connection,
        jobs=[
            {"name": "Job A", "state": "passed", "soft_failed": False},
            {
                "name": ":amd: (MI355) LM Eval Spec Decode",
                "state": "failed",
                "soft_failed": False,
            },
        ],
    )

    result = runtime.process_command(analyze_command())

    assert result.status is ProcessStatus.COMPLETED
    assert set(connection.state["outbox"]) == {
        "full-ci:build-101",
        "full-ci-amd:build-101",
    }


def test_failed_commit_rolls_back_analysis_conditions_and_checkpoint() -> None:
    connection = FakePostgresConnection()
    runtime, checkpoints = make_harness(connection)
    connection.fail_conditions_insert = True
    objects_before = dict(checkpoints.objects)

    result = runtime.process_command(analyze_command())

    assert result.status is ProcessStatus.FAILED
    assert connection.state["analyses"] == {}
    assert connection.state["conditions"] == {}
    assert len(connection.state["checkpoints"]) == 1  # only the seed
    assert connection.state["outbox"] == {}
    # The uploaded-but-unreferenced object stays in S3, harmless.
    assert len(checkpoints.objects) == len(objects_before) + 1

    connection.state["executions"][analyze_command().idempotency_key]["lease"] = (
        START - timedelta(minutes=1)
    )
    retried = runtime.process_command(analyze_command())

    assert retried.status is ProcessStatus.COMPLETED
    assert list(connection.state["analyses"]) == ["build-101"]


def test_committed_analysis_becomes_the_next_baseline() -> None:
    connection = FakePostgresConnection()
    runtime, _ = make_harness(connection)
    assert runtime.process_command(analyze_command()).status is ProcessStatus.COMPLETED

    store = PostgresAlertStore(lambda: connection)
    baseline = store.failure_cache_before(START + timedelta(hours=9))
    assert baseline.build_number == 101
    assert baseline.failed_tests == ("Job A",)
    condition = store.prior_condition("Job A", before=START + timedelta(hours=9))
    assert condition is not None
    assert condition.lifecycle is FailureLifecycle.NEW
    checkpoint = store.latest_checkpoint()
    assert checkpoint is not None
    assert checkpoint.s3_uri != "s3://test-checkpoints/seed.tar.gz"


def test_postgres_first_comparison_uses_imported_failure_baseline() -> None:
    connection = FakePostgresConnection()
    connection.state["imported_baseline"] = (
        "build-100",
        {
            "build_number": 100,
            "commit": "commit-100",
            "failed_tests": ["Job A"],
        },
    )
    runtime, _ = make_harness(connection)

    assert runtime.process_command(analyze_command()).status is ProcessStatus.COMPLETED

    condition = connection.state["conditions"][("build-101", "Job A")]
    assert condition[2] == FailureLifecycle.RECURRING.value


def test_analysis_records_the_pull_request_its_commit_merged() -> None:
    """The GitHub lookup the report needs is kept, not thrown away.

    Slack names the change a run carried because the analyzer resolves the head
    commit against GitHub. Recording that answer on the run is what lets the
    dashboard name it too, without a second request from anywhere else.
    """
    connection = FakePostgresConnection()
    runtime, _ = make_harness(
        connection,
        pull=PullRequestRef(
            number=54353,
            url="https://github.com/vllm-project/vllm/pull/54353",
            title="[Bugfix] Bound cache_salt length",
        ),
    )

    runtime.process_command(analyze_command())

    assert connection.state["runs"]["build-101"][6:] == (
        54353,
        "https://github.com/vllm-project/vllm/pull/54353",
        "[Bugfix] Bound cache_salt length",
    )


def test_a_commit_reachable_by_no_pull_request_records_none() -> None:
    connection = FakePostgresConnection()
    runtime, _ = make_harness(connection)

    runtime.process_command(analyze_command())

    assert connection.state["runs"]["build-101"][6:] == (None, None, None)
