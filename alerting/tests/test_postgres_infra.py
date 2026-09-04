"""Postgres infra scan transaction behavior through the runtime seam."""

from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from types import TracebackType
from typing import Any, Literal

from alerting.commands import ScheduledCommand
from alerting.infra import InfraScanHandler
from alerting.memory import FixedClock, RecordingSlackPort
from alerting.postgres import PostgresAlertStore
from alerting.runtime import AlertingRuntime, ProcessStatus

START = datetime(2026, 9, 2, 10, 0, tzinfo=timezone.utc)


class Result:
    def __init__(
        self,
        row: tuple[Any, ...] | None = None,
        rowcount: int = 0,
        rows: list[tuple[Any, ...]] | None = None,
    ) -> None:
        self._row = row
        self.rowcount = rowcount
        self._rows = rows or []

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


class FakePostgresConnection:
    """Small transaction-capable DB fake for the infra adapter contract."""

    def __init__(self) -> None:
        self.state: dict[str, Any] = {
            "executions": {},
            "thresholds": [("unreporting", 10.0, "minutes", 2, True)],
            "reports": [],
            "recent_hosts": [],
            "mounts": [],
            "temps": [],
            "infra_states": {},
            "infra_alerts": [],
            "outbox": {},
        }
        self.transaction_depth = 0
        self.fail_on_complete = False

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
        if statement.startswith("SELECT alert_type, threshold_value"):
            return Result(rows=list(self.state["thresholds"]))
        if statement.startswith("WITH gpu AS ("):
            return Result(rows=list(self.state["reports"]))
        if statement.startswith("SELECT DISTINCT hostname FROM gpu_snapshots"):
            return Result(rows=list(self.state["recent_hosts"]))
        if statement.startswith("WITH latest AS ("):
            return Result(rows=list(self.state["mounts"]))
        if statement.startswith("SELECT DISTINCT ON (hostname, gpu_index)"):
            return Result(rows=list(self.state["temps"]))
        if statement.startswith(
            "SELECT alert_type, subject_key, consecutive_breaches"
        ):
            return Result(rows=list(self.state["infra_states"].values()))
        if statement.startswith("SELECT alert_id, alert_type, subject_key, opened_at"):
            return Result(
                rows=[
                    (
                        alert["alert_id"],
                        alert["alert_type"],
                        alert["subject_key"],
                        alert["opened_at"],
                        alert["details"],
                    )
                    for alert in self.state["infra_alerts"]
                    if alert["status"] == "open"
                ]
            )
        if statement.startswith("SELECT pg_advisory_xact_lock"):
            assert self.transaction_depth == 1
            return Result()
        if statement.startswith("INSERT INTO alerting_infra_host_states"):
            assert self.transaction_depth == 1
            self.state["infra_states"][(params[0], params[1])] = (
                *params[:5],
                json.loads(params[5]),
                params[6],
            )
            return Result(rowcount=1)
        if statement.startswith("INSERT INTO alerting_infra_alerts"):
            assert self.transaction_depth == 1
            alerts: list[dict[str, Any]] = self.state["infra_alerts"]
            for alert in alerts:
                if (
                    alert["alert_type"] == params[0]
                    and alert["subject_key"] == params[1]
                    and alert["status"] == "open"
                ):
                    return Result(rowcount=0)
            alerts.append(
                {
                    "alert_id": len(alerts) + 1,
                    "alert_type": params[0],
                    "subject_key": params[1],
                    "status": "open",
                    "opened_at": params[2],
                    "details": json.loads(params[3]),
                    "resolved_at": None,
                }
            )
            return Result(rowcount=1)
        if statement.startswith("UPDATE alerting_infra_alerts SET status = 'resolved'"):
            assert self.transaction_depth == 1
            for alert in self.state["infra_alerts"]:
                if (
                    alert["alert_type"] == params[3]
                    and alert["subject_key"] == params[4]
                    and alert["status"] == "open"
                ):
                    alert["status"] = "resolved"
                    alert["resolved_at"] = params[0]
                    alert["details"] = json.loads(params[1])
                    return Result(rowcount=1)
            return Result(rowcount=0)
        if statement.startswith("INSERT INTO alerting_notification_outbox"):
            assert self.transaction_depth == 1
            self.state["outbox"][params[0]] = params
            return Result(rowcount=1)
        if "SET status = 'completed'" in statement:
            assert self.transaction_depth == 1
            if self.fail_on_complete:
                self.fail_on_complete = False
                raise RuntimeError("database connection lost")
            executions[params[1]].update(status="completed", lease=None)
            return Result(rowcount=1)
        if "SET status = 'failed'" in statement:
            executions[params[1]].update(status="failed", lease=None)
            return Result(rowcount=1)
        raise AssertionError(f"unexpected SQL: {statement}")


class FixtureHosts:
    def __init__(self, hosts: set[str]) -> None:
        self.hosts = hosts

    def expected_hosts(self) -> frozenset[str]:
        return frozenset(self.hosts)


def runtime_for(
    connection: FakePostgresConnection, hosts: FixtureHosts
) -> tuple[AlertingRuntime, FixedClock]:
    store = PostgresAlertStore(lambda: connection)
    clock = FixedClock(START)
    runtime = AlertingRuntime(
        executions=store,
        outbox=store,
        slack=RecordingSlackPort(),
        clock=clock,
        handlers={
            "infra_scan": InfraScanHandler(
                hosts=hosts, snapshots=store, store=store, clock=clock
            )
        },
    )
    return runtime, clock


def scan(runtime: AlertingRuntime, target: datetime) -> None:
    result = runtime.process_command(
        ScheduledCommand(command_type="infra_scan", target_time=target)
    )
    assert result.status is ProcessStatus.COMPLETED


def test_postgres_scan_opens_episode_and_outbox_row_in_one_transaction() -> None:
    connection = FakePostgresConnection()
    runtime, _ = runtime_for(connection, FixtureHosts({"gpu-h100-01"}))

    scan(runtime, START)
    assert connection.state["infra_alerts"] == []
    assert connection.state["outbox"] == {}
    state = connection.state["infra_states"][("unreporting", "gpu-h100-01")]
    assert state[2] == 1  # consecutive_breaches

    scan(runtime, START + timedelta(minutes=5))

    [alert] = connection.state["infra_alerts"]
    assert alert["alert_type"] == "unreporting"
    assert alert["subject_key"] == "gpu-h100-01"
    assert alert["status"] == "open"
    [outbox_row] = connection.state["outbox"].values()
    assert outbox_row[2] == "infra"
    assert "stopped reporting" in json.loads(outbox_row[6])["text"]
    command = ScheduledCommand(command_type="infra_scan", target_time=START)
    assert (
        connection.state["executions"][command.idempotency_key]["status"]
        == "completed"
    )


def test_postgres_failure_rolls_back_state_episode_and_outbox_before_retry() -> None:
    connection = FakePostgresConnection()
    runtime, _ = runtime_for(connection, FixtureHosts({"gpu-h100-01"}))
    scan(runtime, START)

    connection.fail_on_complete = True
    failed = runtime.process_command(
        ScheduledCommand(
            command_type="infra_scan", target_time=START + timedelta(minutes=5)
        )
    )

    assert failed.status is ProcessStatus.FAILED
    assert connection.state["infra_alerts"] == []
    assert connection.state["outbox"] == {}
    state = connection.state["infra_states"][("unreporting", "gpu-h100-01")]
    assert state[2] == 1  # rollback restored the first scan's count

    scan(runtime, START + timedelta(minutes=5))
    assert len(connection.state["infra_alerts"]) == 1
    assert len(connection.state["outbox"]) == 1


def test_postgres_scan_resolves_episode_on_first_fresh_report() -> None:
    connection = FakePostgresConnection()
    runtime, _ = runtime_for(connection, FixtureHosts({"gpu-h100-01"}))
    scan(runtime, START)
    scan(runtime, START + timedelta(minutes=5))

    fresh = START + timedelta(minutes=10)
    connection.state["reports"] = [("gpu-h100-01", fresh)]
    connection.state["recent_hosts"] = [("gpu-h100-01",)]
    scan(runtime, fresh)

    [alert] = connection.state["infra_alerts"]
    assert alert["status"] == "resolved"
    assert alert["resolved_at"] == fresh
    assert len(connection.state["outbox"]) == 2
    resolve_row = next(
        row
        for delivery_id, row in connection.state["outbox"].items()
        if delivery_id.endswith(":resolve")
    )
    assert "reporting again" in json.loads(resolve_row[6])["text"]


def test_postgres_disk_group_deduplicates_across_hosts_sharing_a_volume() -> None:
    connection = FakePostgresConnection()
    connection.state["thresholds"].append(("disk_usage", 90.0, "percent", 2, True))
    connection.state["mounts"] = [
        ("h200-ci-1", "/data", "nfs01:/exports/ci", "nfs4", "data", 950, 1000, None, START),
        ("h200-ci-2", "/data", "nfs01:/exports/ci", "nfs4", "data", 960, 1000, None, START),
        ("h200-ci-1", "/scratch", "/dev/sdb1", "ext4", "other", 990, 1000, None, START),
    ]
    runtime, _ = runtime_for(connection, FixtureHosts(set()))

    scan(runtime, START)
    assert connection.state["infra_alerts"] == []

    scan(runtime, START + timedelta(minutes=5))

    [alert] = connection.state["infra_alerts"]
    assert alert["alert_type"] == "disk_usage"
    assert alert["subject_key"] == "disk:nfs4:nfs01:/exports/ci"
    assert alert["status"] == "open"
    assert len(connection.state["outbox"]) == 1
    [outbox_row] = connection.state["outbox"].values()
    assert outbox_row[2] == "infra"
    text = json.loads(outbox_row[6])["text"]
    assert "h200-ci-1" in text and "h200-ci-2" in text
    assert "/scratch" not in text
