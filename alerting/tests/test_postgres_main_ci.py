"""Postgres Main CI store queries through the connection seam."""

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from alerting.commands import ScheduledCommand
from alerting.main_ci import MainCIJobObservation
from alerting.ports import DeliveryMode
from alerting.postgres import PostgresAlertStore


class Result:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows


class RecordingConnection:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows
        self.statements: list[str] = []

    def __enter__(self) -> "RecordingConnection":
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Result:
        self.statements.append(" ".join(sql.split()))
        return Result(self.rows)


def test_open_main_ci_alert_builds_reads_distinct_open_alert_builds() -> None:
    connection = RecordingConnection(
        [("step:gpu|name:GPU correctness", 86297), ("name:Other job", 86297)]
    )
    store = PostgresAlertStore(lambda: connection)

    refs = store.open_main_ci_alert_builds()

    assert [(ref.job_key, ref.build_number) for ref in refs] == [
        ("step:gpu|name:GPU correctness", 86297),
        ("name:Other job", 86297),
    ]
    assert len(connection.statements) == 1
    statement = connection.statements[0]
    assert statement.startswith(
        "SELECT DISTINCT job_key, last_failure_build_number"
        " FROM alerting_main_ci_job_alerts"
    )
    assert "WHERE status = 'open'" in statement


class ScriptedResult:
    def __init__(self, row: tuple[Any, ...] | None, rowcount: int = 1) -> None:
        self._row = row
        self.rowcount = rowcount

    def fetchone(self) -> tuple[Any, ...] | None:
        return self._row


class ScriptedConnection:
    """Answers the commit's RETURNING queries from `returning`, in order."""

    def __init__(self, returning: list[tuple[Any, ...]]) -> None:
        self.returning = list(returning)
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def __enter__(self) -> "ScriptedConnection":
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def transaction(self) -> "ScriptedConnection":
        return self

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> ScriptedResult:
        statement = " ".join(sql.split())
        self.calls.append((statement, params))
        if "RETURNING" in statement:
            return ScriptedResult(self.returning.pop(0))
        return ScriptedResult(None)


def _commit(store: PostgresAlertStore, observation: MainCIJobObservation) -> None:
    store.commit_main_ci_scan(
        command=ScheduledCommand(
            command_type="main_ci_reconcile",
            target_time=observation.finished_at + timedelta(minutes=1),
        ),
        observations=[observation],
        scanned_through=observation.finished_at,
        now=observation.finished_at,
        delivery_mode=DeliveryMode.SHADOW,
    )


def _image_build(build_number: int, state: str) -> MainCIJobObservation:
    return MainCIJobObservation(
        job_key="step:image-build|name::docker: Build image",
        job_id=f"job-{build_number}",
        job_name=":docker: Build image",
        job_url=f"https://buildkite.com/vllm/ci/builds/{build_number}#job",
        state=state,
        finished_at=datetime(2026, 10, 14, 19, 41, tzinfo=timezone.utc),
        build_id=f"build-{build_number}",
        build_number=build_number,
        build_url=f"https://buildkite.com/vllm/ci/builds/{build_number}",
        commit_sha="abc",
    )


def _outbox_rows(connection: ScriptedConnection) -> list[tuple[Any, ...]]:
    return [
        params[:6]
        for statement, params in connection.calls
        if statement.startswith("INSERT INTO alerting_notification_outbox")
    ]


def _payload_texts(connection: ScriptedConnection) -> list[str]:
    return [
        json.loads(params[6])["text"]
        for statement, params in connection.calls
        if statement.startswith("INSERT INTO alerting_notification_outbox")
    ]


def test_commit_enqueues_the_failing_post_from_the_refreshed_episode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SLACK_CI_ALERT_CHANNEL", "CALERTS")
    connection = ScriptedConnection(
        [(7, 94919, "https://buildkite.com/vllm/ci/builds/94919")]
    )

    _commit(PostgresAlertStore(lambda: connection), _image_build(94920, "failed"))

    assert _outbox_rows(connection) == [
        (
            "main-ci:image-build:7:failing",
            "main-ci:image-build:7:failing",
            "main_ci",
            "shadow",
            "bot_token",
            "CALERTS",
        )
    ]
    assert (
        "red since <https://buildkite.com/vllm/ci/builds/94919|CI #94919>"
        in (_payload_texts(connection)[0])
    )


def test_commit_enqueues_the_green_post_from_the_resolved_episode() -> None:
    connection = ScriptedConnection(
        [(7, 94919, "https://buildkite.com/vllm/ci/builds/94919", 94920)]
    )

    _commit(PostgresAlertStore(lambda: connection), _image_build(94949, "passed"))

    assert [row[0] for row in _outbox_rows(connection)] == [
        "main-ci:image-build:7:green"
    ]


def test_commit_enqueues_nothing_for_a_single_build_episode() -> None:
    connection = ScriptedConnection(
        [(7, 94919, "https://buildkite.com/vllm/ci/builds/94919", 94919)]
    )

    _commit(PostgresAlertStore(lambda: connection), _image_build(94920, "passed"))

    assert _outbox_rows(connection) == []
