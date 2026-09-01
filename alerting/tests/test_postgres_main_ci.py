"""Postgres Main CI store queries through the connection seam."""

from typing import Any

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
