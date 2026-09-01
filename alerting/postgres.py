"""Postgres adapter for execution, alert state, and notification outbox."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from alerting.analyzer import (
    AnalyzerRunner,
    CauseCategory,
    CheckpointRef,
    ComparisonContext,
    CompletedAnalysis,
    FailureCache,
    FailureCondition,
    FailureLifecycle,
    PullRequestRef,
    SuspiciousPR,
)
from alerting.commands import ScheduledCommand
from alerting.fast_ci import (
    STALE_NOTIFICATION_AGE,
    BatchFactory,
    FastFailureEvent,
    FastFailureState,
    ordered_unique_events,
    recovery_notification,
)
from alerting.full_ci import (
    FullCIReconciliationState,
    FullCIRun,
    ordered_unique_runs,
)
from alerting.main_ci import (
    MainCIJobObservation,
    MainCIOpenAlertRef,
    ordered_unique_observations,
)
from alerting.main_ci_analysis import (
    MainCIAnalysisRunner,
    MainCIAnalysisTarget,
    MainCIJobAnalysis,
)
from alerting.ports import (
    AlertPath,
    ClaimOutcome,
    Clock,
    DeliveryMode,
    DestinationMode,
    AutomationExecution,
    AutomationExecutionStatus,
    NotificationIntent,
    NotificationIntentRecord,
    OutboxStatus,
    SlackPort,
)
from alerting.runtime import AlertingRuntime

if TYPE_CHECKING:
    from alerting.migration import ImportedFastCIJob


def _executemany(connection: Any, sql: str, rows: list[tuple[Any, ...]]) -> None:
    """psycopg3 exposes executemany on cursors, not connections."""
    with connection.cursor() as cursor:
        cursor.executemany(sql, rows)


class PostgresAlertStore:
    """One database-backed implementation of all transactional alert stores."""

    def __init__(self, connection_factory: Callable[[], Any]) -> None:
        self._connection_factory = connection_factory

    @classmethod
    def from_database_url(cls, database_url: str) -> PostgresAlertStore:
        import psycopg

        return cls(
            lambda: psycopg.connect(
                database_url,
                autocommit=True,
                prepare_threshold=None,
            )
        )

    def claim(
        self, command: ScheduledCommand, *, now: datetime, lease_until: datetime
    ) -> ClaimOutcome:
        with self._connection_factory() as connection:
            with connection.transaction():
                inserted = connection.execute(
                    """
                    INSERT INTO alerting_automation_executions (
                        idempotency_key, command_type, schema_version, target_time,
                        status, attempts, lease_expires_at
                    ) VALUES (%s, %s, %s, %s, 'running', 1, %s)
                    ON CONFLICT (idempotency_key) DO NOTHING
                    RETURNING idempotency_key
                    """,
                    (
                        command.idempotency_key,
                        command.command_type,
                        command.schema_version,
                        command.target_time,
                        lease_until,
                    ),
                ).fetchone()
                if inserted is not None:
                    return ClaimOutcome.CLAIMED

                row = connection.execute(
                    """
                    SELECT status, lease_expires_at
                    FROM alerting_automation_executions
                    WHERE idempotency_key = %s
                    FOR UPDATE
                    """,
                    (command.idempotency_key,),
                ).fetchone()
                if row[0] == AutomationExecutionStatus.COMPLETED.value:
                    return ClaimOutcome.ALREADY_COMPLETED
                if (
                    row[0] == AutomationExecutionStatus.RUNNING.value
                    and row[1] is not None
                    and row[1] > now
                ):
                    return ClaimOutcome.LEASE_HELD
                connection.execute(
                    """
                    UPDATE alerting_automation_executions
                    SET status = 'running', attempts = attempts + 1,
                        lease_expires_at = %s, last_error = NULL
                    WHERE idempotency_key = %s
                    """,
                    (lease_until, command.idempotency_key),
                )
                return ClaimOutcome.CLAIMED

    def complete(self, idempotency_key: str, *, now: datetime) -> None:
        with self._connection_factory() as connection:
            connection.execute(
                """
                UPDATE alerting_automation_executions
                SET status = 'completed', completed_at = %s,
                    lease_expires_at = NULL, last_error = NULL
                WHERE idempotency_key = %s
                """,
                (now, idempotency_key),
            )

    def fail(self, idempotency_key: str, error: str, *, now: datetime) -> None:
        with self._connection_factory() as connection:
            connection.execute(
                """
                UPDATE alerting_automation_executions
                SET status = 'failed', last_error = %s, lease_expires_at = NULL
                WHERE idempotency_key = %s AND status <> 'completed'
                """,
                (error, idempotency_key),
            )

    def get(self, idempotency_key: str) -> AutomationExecution | None:
        with self._connection_factory() as connection:
            row = connection.execute(
                """
                SELECT idempotency_key, command_type, schema_version, target_time,
                       status, attempts, lease_expires_at, last_error, completed_at
                FROM alerting_automation_executions
                WHERE idempotency_key = %s
                """,
                (idempotency_key,),
            ).fetchone()
        if row is None:
            return None
        return AutomationExecution(
            idempotency_key=row[0],
            command_type=row[1],
            schema_version=row[2],
            target_time=row[3],
            status=AutomationExecutionStatus(row[4]),
            attempts=row[5],
            lease_expires_at=row[6],
            last_error=row[7],
            completed_at=row[8],
        )

    def enqueue(
        self,
        message: NotificationIntent,
        *,
        now: datetime,
        next_attempt_at: datetime | None = None,
    ) -> None:
        with self._connection_factory() as connection:
            self._enqueue(
                connection,
                message,
                next_attempt_at=next_attempt_at or now,
            )

    @staticmethod
    def _enqueue(
        connection: Any,
        message: NotificationIntent,
        *,
        next_attempt_at: datetime,
    ) -> None:
        connection.execute(
            """
            INSERT INTO alerting_notification_outbox (
                delivery_id, alert_ref, alert_path, delivery_mode,
                destination_mode, destination, payload, next_attempt_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (delivery_id) DO NOTHING
            """,
            (
                message.delivery_id,
                message.alert_ref,
                message.alert_path.value,
                message.delivery_mode.value,
                message.destination_mode.value,
                message.destination,
                json.dumps(message.payload),
                next_attempt_at,
            ),
        )

    def lease_due(
        self,
        *,
        now: datetime,
        lease_until: datetime,
        limit: int,
        alert_path: AlertPath | None = None,
    ) -> list[NotificationIntentRecord]:
        with self._connection_factory() as connection:
            with connection.transaction():
                rows = connection.execute(
                    """
                    WITH due AS (
                        SELECT delivery_id
                        FROM alerting_notification_outbox
                        WHERE status IN ('pending', 'retrying')
                          AND delivery_mode = 'live'
                          AND (%s::text IS NULL OR alert_path = %s)
                          AND superseded_by IS NULL
                          AND next_attempt_at <= %s
                          AND (lease_expires_at IS NULL OR lease_expires_at <= %s)
                        ORDER BY next_attempt_at
                        FOR UPDATE SKIP LOCKED
                        LIMIT %s
                    )
                    UPDATE alerting_notification_outbox AS outbox
                    SET lease_expires_at = %s, attempts = outbox.attempts + 1
                    FROM due
                    WHERE outbox.delivery_id = due.delivery_id
                    RETURNING outbox.delivery_id, outbox.alert_ref,
                              outbox.alert_path, outbox.delivery_mode,
                              outbox.destination_mode, outbox.destination,
                              outbox.payload, outbox.status, outbox.attempts,
                              outbox.next_attempt_at, outbox.lease_expires_at,
                              outbox.slack_ts, outbox.last_error,
                              outbox.created_at, outbox.superseded_by
                    """,
                    (
                        alert_path.value if alert_path is not None else None,
                        alert_path.value if alert_path is not None else None,
                        now,
                        now,
                        limit,
                        lease_until,
                    ),
                ).fetchall()
        return [self._outbox_record(row) for row in rows]

    @staticmethod
    def _outbox_record(row: Any) -> NotificationIntentRecord:
        return NotificationIntentRecord(
            delivery_id=row[0],
            alert_ref=row[1],
            alert_path=AlertPath(row[2]),
            delivery_mode=DeliveryMode(row[3]),
            destination_mode=DestinationMode(row[4]),
            destination=row[5],
            payload=dict(row[6]),
            status=OutboxStatus(row[7]),
            attempts=row[8],
            next_attempt_at=row[9],
            created_at=row[13],
            lease_expires_at=row[10],
            slack_ts=row[11],
            last_error=row[12],
            superseded_by=row[14],
        )

    def mark_delivered(
        self, delivery_id: str, *, slack_ts: str | None, now: datetime
    ) -> None:
        self._update_outbox(
            delivery_id,
            """
            status = 'delivered', slack_ts = %s, lease_expires_at = NULL,
            last_error = NULL
            """,
            (slack_ts,),
        )

    def mark_retrying(
        self,
        delivery_id: str,
        *,
        error: str,
        next_attempt_at: datetime,
        now: datetime,
    ) -> None:
        self._update_outbox(
            delivery_id,
            """
            status = 'retrying', last_error = %s, next_attempt_at = %s,
            lease_expires_at = NULL
            """,
            (error, next_attempt_at),
            guard_delivered=True,
        )

    def mark_dead_letter(self, delivery_id: str, *, error: str, now: datetime) -> None:
        self._update_outbox(
            delivery_id,
            "status = 'dead_letter', last_error = %s, lease_expires_at = NULL",
            (error,),
            guard_delivered=True,
        )

    def _update_outbox(
        self,
        delivery_id: str,
        assignments: str,
        values: tuple[Any, ...],
        *,
        guard_delivered: bool = False,
    ) -> None:
        delivered_guard = "AND status <> 'delivered'" if guard_delivered else ""
        with self._connection_factory() as connection:
            connection.execute(
                f"""
                UPDATE alerting_notification_outbox
                SET {assignments}
                WHERE delivery_id = %s {delivered_guard}
                """,
                (*values, delivery_id),
            )

    def get_outbox(self, delivery_id: str) -> NotificationIntentRecord | None:
        with self._connection_factory() as connection:
            row = connection.execute(
                """
                SELECT delivery_id, alert_ref, alert_path, delivery_mode,
                       destination_mode, destination,
                       payload, status, attempts, next_attempt_at,
                       lease_expires_at, slack_ts, last_error, created_at,
                       superseded_by
                FROM alerting_notification_outbox
                WHERE delivery_id = %s
                """,
                (delivery_id,),
            ).fetchone()
        return self._outbox_record(row) if row is not None else None

    def shadow_outputs(
        self, *, alert_path: AlertPath, limit: int
    ) -> list[NotificationIntentRecord]:
        with self._connection_factory() as connection:
            rows = connection.execute(
                """
                SELECT delivery_id, alert_ref, alert_path, delivery_mode,
                       destination_mode, destination, payload, status, attempts,
                       next_attempt_at, lease_expires_at, slack_ts, last_error,
                       created_at, superseded_by
                FROM alerting_notification_outbox
                WHERE alert_path = %s AND delivery_mode = 'shadow'
                ORDER BY created_at DESC, delivery_id DESC
                LIMIT %s
                """,
                (alert_path.value, limit),
            ).fetchall()
        return [self._outbox_record(row) for row in rows]

    def runs_missing_commit_pull_request(
        self, *, limit: int
    ) -> list[tuple[str, str]]:
        """Analyzed runs whose commit was never resolved to a pull request.

        Rows analyzed before the run carried those columns keep a null there
        forever, since an analysis never runs twice for the same build.
        """
        with self._connection_factory() as connection:
            rows = connection.execute(
                """
                SELECT buildkite_build_id, commit_sha
                FROM alerting_full_ci_runs
                WHERE commit_pr_number IS NULL
                ORDER BY scheduled_at DESC
                LIMIT %s
                """,
                (limit,),
            ).fetchall()
        return [(str(row[0]), str(row[1])) for row in rows]

    def record_commit_pull_request(
        self, *, build_id: str, number: int, url: str, title: str
    ) -> None:
        with self._connection_factory() as connection:
            connection.execute(
                """
                UPDATE alerting_full_ci_runs
                SET commit_pr_number = %s,
                    commit_pr_url = %s,
                    commit_pr_title = %s
                WHERE buildkite_build_id = %s
                """,
                (number, url, title, build_id),
            )

    def archive_pending_live(self, *, alert_path: AlertPath) -> int:
        with self._connection_factory() as connection:
            result = connection.execute(
                """
                UPDATE alerting_notification_outbox
                SET delivery_mode = 'shadow', lease_expires_at = NULL
                WHERE alert_path = %s
                  AND delivery_mode = 'live'
                  AND status IN ('pending', 'retrying')
                """,
                (alert_path.value,),
            )
        return int(result.rowcount)

    def consolidate_stale_notifications(self, *, now: datetime) -> None:
        stale_before = now - STALE_NOTIFICATION_AGE
        with self._connection_factory() as connection:
            with connection.transaction():
                rows = connection.execute(
                    """
                    WITH stale_fast_ci_outbox AS (
                        SELECT outbox.delivery_id
                        FROM alerting_notification_outbox AS outbox
                        WHERE outbox.status IN ('pending', 'retrying')
                          AND outbox.delivery_mode = 'live'
                          AND outbox.superseded_by IS NULL
                          AND outbox.created_at <= %s
                          AND (
                              outbox.lease_expires_at IS NULL
                              OR outbox.lease_expires_at <= %s
                          )
                          AND outbox.delivery_id LIKE 'fast-ci:%%'
                          AND outbox.delivery_id NOT LIKE 'fast-ci-recovery:%%'
                          AND EXISTS (
                              SELECT 1
                              FROM alerting_fast_failure_notifications AS linked
                              WHERE linked.delivery_id = outbox.delivery_id
                          )
                        ORDER BY outbox.created_at, outbox.delivery_id
                        FOR UPDATE SKIP LOCKED
                    )
                    SELECT stale.delivery_id, event.buildkite_job_id,
                           event.job_name, event.job_url, event.state,
                           event.soft_failed, event.duration_seconds,
                           event.finished_at, event.build_url, event.message,
                           event.commit_sha, event.branch, event.author,
                           event.pr_number, event.pipeline
                    FROM stale_fast_ci_outbox AS stale
                    JOIN alerting_fast_failure_notifications AS linked
                      ON linked.delivery_id = stale.delivery_id
                    JOIN alerting_fast_failure_events AS event
                      ON event.buildkite_job_id = linked.buildkite_job_id
                    ORDER BY event.finished_at, event.buildkite_job_id
                    """,
                    (stale_before, now),
                ).fetchall()
                if not rows:
                    return

                stale_delivery_ids = sorted({row[0] for row in rows})
                events = [
                    FastFailureEvent(
                        job_id=row[1],
                        job_name=row[2],
                        job_url=row[3],
                        state=FastFailureState(row[4]),
                        soft_failed=row[5],
                        duration_seconds=row[6],
                        finished_at=row[7],
                        build_url=row[8],
                        message=row[9],
                        commit_sha=row[10],
                        branch=row[11],
                        author=row[12],
                        pr_number=row[13],
                        pipeline=row[14],
                    )
                    for row in rows
                ]
                summary = recovery_notification(events, stale_delivery_ids)
                self._enqueue(connection, summary.message, next_attempt_at=now)
                _executemany(connection,
                    """
                    INSERT INTO alerting_fast_failure_notifications (
                        buildkite_job_id, delivery_id
                    ) VALUES (%s, %s)
                    ON CONFLICT (buildkite_job_id, delivery_id) DO NOTHING
                    """,
                    [
                        (job_id, summary.message.delivery_id)
                        for job_id in summary.job_ids
                    ],
                )
                connection.execute(
                    """
                    UPDATE alerting_notification_outbox
                    SET superseded_by = %s, lease_expires_at = NULL,
                        last_error = %s
                    WHERE delivery_id = ANY(%s)
                    """,
                    (
                        summary.message.delivery_id,
                        "consolidated into recovery summary "
                        f"{summary.message.delivery_id}",
                        stale_delivery_ids,
                    ),
                )

    def scan_cursor(self) -> datetime | None:
        with self._connection_factory() as connection:
            row = connection.execute(
                """
                SELECT scanned_through
                FROM alerting_fast_ci_scan_cursors
                WHERE cursor_name = 'fast_ci'
                """
            ).fetchone()
        return row[0] if row is not None else None

    def import_legacy_state(
        self,
        *,
        baseline_run: FullCIRun,
        failure_cache: FailureCache,
        reported_build_numbers: tuple[int, ...],
        checkpoint: CheckpointRef,
        fast_ci_jobs: tuple[ImportedFastCIJob, ...],
        now: datetime,
    ) -> None:
        """Atomically reference uploaded legacy state and seed deduplication."""
        cache_payload = _cache_payload(failure_cache)
        with self._connection_factory() as connection:
            with connection.transaction():
                connection.execute(
                    """
                    SELECT pg_advisory_xact_lock(
                        hashtext('alerting_legacy_state_import')
                    )
                    """
                )
                existing = connection.execute(
                    """
                    SELECT buildkite_build_id, failure_cache,
                           reported_build_numbers
                    FROM alerting_full_ci_import_baselines
                    WHERE singleton = true
                    FOR UPDATE
                    """
                ).fetchone()
                if existing is not None:
                    seed_checkpoint = connection.execute(
                        """
                        SELECT s3_uri, sha256, schema_version
                        FROM alerting_analyzer_checkpoints
                        WHERE current_build_id IS NULL
                        ORDER BY checkpoint_id
                        LIMIT 1
                        """
                    ).fetchone()
                    if (
                        existing[0] != baseline_run.build_id
                        or _failure_cache(existing[1]) != failure_cache
                        or tuple(existing[2]) != reported_build_numbers
                        or seed_checkpoint
                        != (
                            checkpoint.s3_uri,
                            checkpoint.sha256,
                            checkpoint.schema_version,
                        )
                    ):
                        raise RuntimeError(
                            "legacy Full CI state was already imported with "
                            "different baseline or checkpoint"
                        )
                else:
                    started = connection.execute(
                        """
                        SELECT EXISTS (
                            SELECT 1 FROM alerting_full_ci_comparisons
                            UNION ALL
                            SELECT 1 FROM alerting_full_ci_analyses
                            UNION ALL
                            SELECT 1 FROM alerting_analyzer_checkpoints
                        )
                        """
                    ).fetchone()
                    if started is not None and started[0]:
                        raise RuntimeError(
                            "legacy Full CI state must be imported before "
                            "comparisons, analyses, or checkpoints exist"
                        )
                    connection.execute(
                        """
                        INSERT INTO alerting_full_ci_runs (
                            buildkite_build_id, build_number, scheduled_at,
                            commit_sha, message, state
                        ) VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT DO NOTHING
                        RETURNING buildkite_build_id
                        """,
                        (
                            baseline_run.build_id,
                            baseline_run.build_number,
                            baseline_run.scheduled_at,
                            baseline_run.commit_sha,
                            baseline_run.message,
                            baseline_run.state,
                        ),
                    )
                    stored_run = connection.execute(
                        """
                        SELECT build_number, scheduled_at, commit_sha, message, state
                        FROM alerting_full_ci_runs
                        WHERE buildkite_build_id = %s
                        """,
                        (baseline_run.build_id,),
                    ).fetchone()
                    expected_run = (
                        baseline_run.build_number,
                        baseline_run.scheduled_at,
                        baseline_run.commit_sha,
                        baseline_run.message,
                        baseline_run.state,
                    )
                    if stored_run != expected_run:
                        raise RuntimeError(
                            "Buildkite baseline identity conflicts with an existing run"
                        )
                    if baseline_run.jobs:
                        _executemany(connection,
                            """
                            INSERT INTO alerting_full_ci_job_outcomes (
                                buildkite_build_id, job_name, state, soft_failed
                            ) VALUES (%s, %s, %s, %s)
                            ON CONFLICT (buildkite_build_id, job_name) DO NOTHING
                            """,
                            [
                                (
                                    baseline_run.build_id,
                                    job.name,
                                    job.state,
                                    job.soft_failed,
                                )
                                for job in baseline_run.jobs
                            ],
                        )
                    connection.execute(
                        """
                        INSERT INTO alerting_analyzer_checkpoints (
                            current_build_id, s3_uri, sha256,
                            schema_version, created_at
                        ) VALUES (NULL, %s, %s, %s, %s)
                        """,
                        (
                            checkpoint.s3_uri,
                            checkpoint.sha256,
                            checkpoint.schema_version,
                            now,
                        ),
                    )
                    connection.execute(
                        """
                        INSERT INTO alerting_full_ci_import_baselines (
                            buildkite_build_id, failure_cache,
                            reported_build_numbers, imported_at
                        ) VALUES (%s, %s::jsonb, %s, %s)
                        """,
                        (
                            baseline_run.build_id,
                            json.dumps(cache_payload),
                            list(reported_build_numbers),
                            now,
                        ),
                    )
                if fast_ci_jobs:
                    _executemany(connection,
                        """
                        INSERT INTO alerting_fast_ci_imported_deduplication_keys (
                            buildkite_job_id, finished_at, imported_at
                        ) VALUES (%s, %s, %s)
                        ON CONFLICT (buildkite_job_id) DO NOTHING
                        """,
                        [(job.job_id, job.finished_at, now) for job in fast_ci_jobs],
                    )

    def commit_scan(
        self,
        *,
        command: ScheduledCommand,
        observations: list[FastFailureEvent],
        scanned_through: datetime,
        now: datetime,
        batch_factory: BatchFactory,
    ) -> None:
        with self._connection_factory() as connection:
            with connection.transaction():
                ordered = ordered_unique_events(observations)
                imported_job_ids: set[str] = set()
                if ordered:
                    imported_job_ids = {
                        row[0]
                        for row in connection.execute(
                            """
                            SELECT buildkite_job_id
                            FROM alerting_fast_ci_imported_deduplication_keys
                            WHERE buildkite_job_id = ANY(%s)
                            """,
                            ([event.job_id for event in ordered],),
                        ).fetchall()
                    }
                new_events: list[FastFailureEvent] = []
                for event in ordered:
                    if event.job_id in imported_job_ids:
                        continue
                    inserted = connection.execute(
                        """
                        INSERT INTO alerting_fast_failure_events (
                            buildkite_job_id, job_name, job_url, state, soft_failed,
                            duration_seconds, finished_at, build_url, message,
                            commit_sha, branch, author, pr_number, pipeline
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s, %s,
                            %s, %s, %s, %s, %s, %s, %s
                        )
                        ON CONFLICT (buildkite_job_id) DO NOTHING
                        RETURNING buildkite_job_id
                        """,
                        (
                            event.job_id,
                            event.job_name,
                            event.job_url,
                            event.state.value,
                            event.soft_failed,
                            event.duration_seconds,
                            event.finished_at,
                            event.build_url,
                            event.message,
                            event.commit_sha,
                            event.branch,
                            event.author,
                            event.pr_number,
                            event.pipeline,
                        ),
                    ).fetchone()
                    if inserted is not None:
                        new_events.append(event)

                for batch in batch_factory(new_events):
                    self._enqueue(connection, batch.message, next_attempt_at=now)
                    _executemany(connection,
                        """
                        INSERT INTO alerting_fast_failure_notifications (
                            buildkite_job_id, delivery_id
                        ) VALUES (%s, %s)
                        ON CONFLICT (buildkite_job_id, delivery_id) DO NOTHING
                        """,
                        [
                            (job_id, batch.message.delivery_id)
                            for job_id in batch.job_ids
                        ],
                    )

                connection.execute(
                    """
                    INSERT INTO alerting_fast_ci_scan_cursors (
                        cursor_name, scanned_through
                    ) VALUES ('fast_ci', %s)
                    ON CONFLICT (cursor_name) DO UPDATE
                    SET scanned_through = GREATEST(
                        alerting_fast_ci_scan_cursors.scanned_through,
                        EXCLUDED.scanned_through
                    )
                    """,
                    (scanned_through,),
                )
                completed = connection.execute(
                    """
                    UPDATE alerting_automation_executions
                    SET status = 'completed', completed_at = %s,
                        lease_expires_at = NULL, last_error = NULL
                    WHERE idempotency_key = %s AND status = 'running'
                    """,
                    (now, command.idempotency_key),
                )
                if completed.rowcount != 1:
                    raise RuntimeError("Fast CI execution was not running at commit")

    def reconciliation_state(self) -> FullCIReconciliationState:
        with self._connection_factory() as connection:
            rows = connection.execute(
                """
                SELECT buildkite_build_id, scheduled_at
                FROM alerting_full_ci_runs
                """
            ).fetchall()
        return FullCIReconciliationState(
            start_time=min((row[1] for row in rows), default=None),
            processed_build_ids=frozenset(row[0] for row in rows),
        )

    def main_ci_scan_cursor(self) -> datetime | None:
        with self._connection_factory() as connection:
            row = connection.execute(
                """
                SELECT scanned_through
                FROM alerting_main_ci_scan_cursors
                WHERE cursor_name = 'main_ci'
                """
            ).fetchone()
        return row[0] if row is not None else None

    def commit_main_ci_scan(
        self,
        *,
        command: ScheduledCommand,
        observations: list[MainCIJobObservation],
        scanned_through: datetime,
        now: datetime,
    ) -> None:
        with self._connection_factory() as connection:
            with connection.transaction():
                connection.execute(
                    """
                    SELECT pg_advisory_xact_lock(
                        hashtext('alerting_main_ci_reconcile')
                    )
                    """
                )
                for observation in ordered_unique_observations(observations):
                    current = connection.execute(
                        """
                        SELECT latest_build_number, latest_finished_at,
                               latest_job_id
                        FROM alerting_main_ci_job_states
                        WHERE job_key = %s
                        FOR UPDATE
                        """,
                        (observation.job_key,),
                    ).fetchone()
                    if current is not None and (
                        current[0], current[1], current[2]
                    ) >= observation.order:
                        continue

                    connection.execute(
                        """
                        INSERT INTO alerting_main_ci_job_states (
                            job_key, job_name, latest_job_id, latest_job_state,
                            latest_finished_at, latest_build_id,
                            latest_build_number, latest_build_url,
                            latest_job_url, latest_commit_sha, updated_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (job_key) DO UPDATE
                        SET job_name = EXCLUDED.job_name,
                            latest_job_id = EXCLUDED.latest_job_id,
                            latest_job_state = EXCLUDED.latest_job_state,
                            latest_finished_at = EXCLUDED.latest_finished_at,
                            latest_build_id = EXCLUDED.latest_build_id,
                            latest_build_number = EXCLUDED.latest_build_number,
                            latest_build_url = EXCLUDED.latest_build_url,
                            latest_job_url = EXCLUDED.latest_job_url,
                            latest_commit_sha = EXCLUDED.latest_commit_sha,
                            updated_at = EXCLUDED.updated_at
                        """,
                        (
                            observation.job_key,
                            observation.job_name,
                            observation.job_id,
                            observation.state,
                            observation.finished_at,
                            observation.build_id,
                            observation.build_number,
                            observation.build_url,
                            observation.job_url,
                            observation.commit_sha,
                            now,
                        ),
                    )

                    if observation.failed:
                        updated = connection.execute(
                            """
                            UPDATE alerting_main_ci_job_alerts
                            SET job_name = %s,
                                last_failed_at = %s,
                                last_failure_job_id = %s,
                                last_failure_state = %s,
                                last_failure_build_id = %s,
                                last_failure_build_number = %s,
                                last_failure_build_url = %s,
                                last_failure_job_url = %s,
                                last_failure_commit_sha = %s,
                                failure_count = failure_count + 1,
                                updated_at = %s
                            WHERE job_key = %s AND status = 'open'
                            RETURNING alert_id
                            """,
                            (
                                observation.job_name,
                                observation.finished_at,
                                observation.job_id,
                                observation.state,
                                observation.build_id,
                                observation.build_number,
                                observation.build_url,
                                observation.job_url,
                                observation.commit_sha,
                                now,
                                observation.job_key,
                            ),
                        ).fetchone()
                        if updated is None:
                            connection.execute(
                                """
                                INSERT INTO alerting_main_ci_job_alerts (
                                    job_key, job_name, status, opened_at,
                                    first_failure_job_id, first_failure_state,
                                    first_failure_build_id,
                                    first_failure_build_number,
                                    first_failure_build_url,
                                    first_failure_job_url,
                                    first_failure_commit_sha,
                                    last_failed_at, last_failure_job_id,
                                    last_failure_state, last_failure_build_id,
                                    last_failure_build_number,
                                    last_failure_build_url, last_failure_job_url,
                                    last_failure_commit_sha, failure_count,
                                    created_at, updated_at
                                ) VALUES (
                                    %s, %s, 'open', %s, %s, %s, %s, %s, %s,
                                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                                    1, %s, %s
                                )
                                """,
                                (
                                    observation.job_key,
                                    observation.job_name,
                                    observation.finished_at,
                                    observation.job_id,
                                    observation.state,
                                    observation.build_id,
                                    observation.build_number,
                                    observation.build_url,
                                    observation.job_url,
                                    observation.commit_sha,
                                    observation.finished_at,
                                    observation.job_id,
                                    observation.state,
                                    observation.build_id,
                                    observation.build_number,
                                    observation.build_url,
                                    observation.job_url,
                                    observation.commit_sha,
                                    now,
                                    now,
                                ),
                            )
                    else:
                        connection.execute(
                            """
                            UPDATE alerting_main_ci_job_alerts
                            SET status = 'resolved', resolved_at = %s,
                                resolution_job_id = %s,
                                resolution_build_id = %s,
                                resolution_build_number = %s,
                                resolution_build_url = %s,
                                resolution_job_url = %s,
                                resolution_commit_sha = %s,
                                updated_at = %s
                            WHERE job_key = %s AND status = 'open'
                            """,
                            (
                                observation.finished_at,
                                observation.job_id,
                                observation.build_id,
                                observation.build_number,
                                observation.build_url,
                                observation.job_url,
                                observation.commit_sha,
                                now,
                                observation.job_key,
                            ),
                        )

                connection.execute(
                    """
                    INSERT INTO alerting_main_ci_scan_cursors (
                        cursor_name, scanned_through
                    ) VALUES ('main_ci', %s)
                    ON CONFLICT (cursor_name) DO UPDATE
                    SET scanned_through = GREATEST(
                        alerting_main_ci_scan_cursors.scanned_through,
                        EXCLUDED.scanned_through
                    )
                    """,
                    (scanned_through,),
                )
                completed = connection.execute(
                    """
                    UPDATE alerting_automation_executions
                    SET status = 'completed', completed_at = %s,
                        lease_expires_at = NULL, last_error = NULL
                    WHERE idempotency_key = %s AND status = 'running'
                    """,
                    (now, command.idempotency_key),
                )
                if completed.rowcount != 1:
                    raise RuntimeError("Main CI execution was not running at commit")

    def open_main_ci_alert_builds(self) -> list[MainCIOpenAlertRef]:
        with self._connection_factory() as connection:
            rows = connection.execute(
                """
                SELECT DISTINCT job_key, last_failure_build_number
                FROM alerting_main_ci_job_alerts
                WHERE status = 'open'
                ORDER BY job_key
                """
            ).fetchall()
        return [
            MainCIOpenAlertRef(job_key=row[0], build_number=int(row[1]))
            for row in rows
        ]

    def pending_main_ci_analyses(self, *, limit: int) -> list[MainCIAnalysisTarget]:
        with self._connection_factory() as connection:
            rows = connection.execute(
                """
                SELECT a.alert_id, a.job_key, a.job_name, a.opened_at,
                       a.last_failed_at, a.failure_count, a.last_failure_job_id,
                       a.last_failure_build_number, a.last_failure_build_url,
                       a.last_failure_job_url, a.last_failure_commit_sha
                FROM alerting_main_ci_job_alerts AS a
                LEFT JOIN alerting_main_ci_job_analysis AS an
                    ON an.alert_id = a.alert_id
                WHERE a.status = 'open'
                  AND (an.alert_id IS NULL
                       OR an.analyzed_failure_job_id <> a.last_failure_job_id)
                ORDER BY a.last_failed_at DESC, a.alert_id DESC
                LIMIT %s
                """,
                (limit,),
            ).fetchall()
        return [
            MainCIAnalysisTarget(
                alert_id=int(row[0]),
                job_key=row[1],
                job_name=row[2],
                opened_at=row[3],
                last_failed_at=row[4],
                failure_count=int(row[5]),
                failure_job_id=row[6],
                failure_build_number=int(row[7]),
                failure_build_url=row[8],
                failure_job_url=row[9],
                failure_commit_sha=row[10],
            )
            for row in rows
        ]

    def commit_main_ci_analysis(
        self, *, analysis: MainCIJobAnalysis, now: datetime
    ) -> None:
        with self._connection_factory() as connection:
            with connection.transaction():
                current = connection.execute(
                    """
                    SELECT last_failure_job_id
                    FROM alerting_main_ci_job_alerts
                    WHERE alert_id = %s
                    FOR UPDATE
                    """,
                    (analysis.alert_id,),
                ).fetchone()
                # The reconcile slice may have observed a newer failure while
                # this analysis ran; a diagnosis of an old job must not win.
                if current is None or current[0] != analysis.analyzed_failure_job_id:
                    return
                connection.execute(
                    """
                    INSERT INTO alerting_main_ci_job_analysis (
                        alert_id, analyzed_failure_job_id, classification,
                        confidence, summary, evidence_urls, recommended_action,
                        suspected_fix_prs, model_version, analyzed_at, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s::jsonb, %s, %s, %s)
                    ON CONFLICT (alert_id) DO UPDATE
                    SET analyzed_failure_job_id = EXCLUDED.analyzed_failure_job_id,
                        classification = EXCLUDED.classification,
                        confidence = EXCLUDED.confidence,
                        summary = EXCLUDED.summary,
                        evidence_urls = EXCLUDED.evidence_urls,
                        recommended_action = EXCLUDED.recommended_action,
                        suspected_fix_prs = EXCLUDED.suspected_fix_prs,
                        model_version = EXCLUDED.model_version,
                        analyzed_at = EXCLUDED.analyzed_at,
                        updated_at = EXCLUDED.updated_at
                    """,
                    (
                        analysis.alert_id,
                        analysis.analyzed_failure_job_id,
                        analysis.classification,
                        analysis.confidence,
                        analysis.summary,
                        json.dumps(list(analysis.evidence_urls)),
                        analysis.recommended_action,
                        json.dumps(
                            [
                                {"url": pr.url, "number": pr.number, "title": pr.title}
                                for pr in analysis.suspected_fix_prs
                            ]
                        ),
                        analysis.model_version,
                        now,
                        now,
                    ),
                )

    def commit_reconciliation(
        self,
        *,
        command: ScheduledCommand,
        observations: list[FullCIRun],
        now: datetime,
    ) -> None:
        with self._connection_factory() as connection:
            with connection.transaction():
                connection.execute(
                    """
                    SELECT pg_advisory_xact_lock(
                        hashtext('alerting_full_ci_reconcile')
                    )
                    """
                )
                for run in ordered_unique_runs(observations):
                    run_order = (run.scheduled_at, run.build_number)
                    previous = connection.execute(
                        """
                        SELECT buildkite_build_id
                        FROM alerting_full_ci_runs
                        WHERE (scheduled_at, build_number) < (%s, %s)
                        ORDER BY scheduled_at DESC, build_number DESC
                        LIMIT 1
                        """,
                        run_order,
                    ).fetchone()
                    following = connection.execute(
                        """
                        SELECT buildkite_build_id
                        FROM alerting_full_ci_runs
                        WHERE (scheduled_at, build_number) > (%s, %s)
                        ORDER BY scheduled_at, build_number
                        LIMIT 1
                        """,
                        run_order,
                    ).fetchone()
                    inserted = connection.execute(
                        """
                        INSERT INTO alerting_full_ci_runs (
                            buildkite_build_id, build_number, scheduled_at,
                            commit_sha, message, state
                        ) VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (buildkite_build_id) DO NOTHING
                        RETURNING buildkite_build_id
                        """,
                        (
                            run.build_id,
                            run.build_number,
                            run.scheduled_at,
                            run.commit_sha,
                            run.message,
                            run.state,
                        ),
                    ).fetchone()
                    if inserted is None:
                        continue

                    jobs_by_name = {job.name: job for job in run.jobs}
                    if jobs_by_name:
                        _executemany(connection,
                            """
                            INSERT INTO alerting_full_ci_job_outcomes (
                                buildkite_build_id, job_name, state, soft_failed
                            ) VALUES (%s, %s, %s, %s)
                            ON CONFLICT (buildkite_build_id, job_name) DO UPDATE
                            SET state = EXCLUDED.state,
                                soft_failed = EXCLUDED.soft_failed
                            """,
                            [
                                (
                                    run.build_id,
                                    job.name,
                                    job.state,
                                    job.soft_failed,
                                )
                                for job in jobs_by_name.values()
                            ],
                        )
                    if previous is not None:
                        connection.execute(
                            """
                            INSERT INTO alerting_full_ci_comparisons (
                                current_build_id, previous_build_id
                            ) VALUES (%s, %s)
                            ON CONFLICT (current_build_id) DO NOTHING
                            """,
                            (run.build_id, previous[0]),
                        )
                    if following is not None:
                        connection.execute(
                            """
                            INSERT INTO alerting_full_ci_comparisons (
                                current_build_id, previous_build_id
                            ) VALUES (%s, %s)
                            ON CONFLICT (current_build_id) DO UPDATE
                            SET previous_build_id = EXCLUDED.previous_build_id
                            """,
                            (following[0], run.build_id),
                        )

                completed = connection.execute(
                    """
                    UPDATE alerting_automation_executions
                    SET status = 'completed', completed_at = %s,
                        lease_expires_at = NULL, last_error = NULL
                    WHERE idempotency_key = %s AND status = 'running'
                    """,
                    (now, command.idempotency_key),
                )
                if completed.rowcount != 1:
                    raise RuntimeError("Full CI execution was not running at commit")

    def pending_comparisons(self) -> list[ComparisonContext]:
        with self._connection_factory() as connection:
            rows = connection.execute(
                """
                SELECT c.previous_build_id, r.buildkite_build_id, r.build_number,
                       r.scheduled_at, r.commit_sha, r.message, r.state
                FROM alerting_full_ci_comparisons AS c
                JOIN alerting_full_ci_runs AS r
                    ON r.buildkite_build_id = c.current_build_id
                WHERE NOT EXISTS (
                    SELECT 1 FROM alerting_full_ci_analyses AS a
                    WHERE a.current_build_id = c.current_build_id
                )
                ORDER BY r.scheduled_at, r.build_number
                """
            ).fetchall()
            contexts: list[ComparisonContext] = []
            for row in rows:
                contexts.append(
                    ComparisonContext(
                        previous_build_id=row[0],
                        # Job outcomes come from the fresh Buildkite fetch at
                        # analysis time, not this durable snapshot.
                        current=FullCIRun(
                            build_id=row[1],
                            build_number=row[2],
                            scheduled_at=row[3],
                            commit_sha=row[4],
                            message=row[5],
                            state=row[6],
                            jobs=(),
                        ),
                    )
                )
        return contexts

    def failure_cache_before(self, scheduled_at: datetime) -> FailureCache:
        with self._connection_factory() as connection:
            row = connection.execute(
                """
                WITH failure_baselines AS (
                    SELECT r.scheduled_at, r.build_number, a.failure_cache
                    FROM alerting_full_ci_analyses AS a
                    JOIN alerting_full_ci_runs AS r
                        ON r.buildkite_build_id = a.current_build_id
                    UNION ALL
                    SELECT r.scheduled_at, r.build_number, imported.failure_cache
                    FROM alerting_full_ci_import_baselines AS imported
                    JOIN alerting_full_ci_runs AS r
                        ON r.buildkite_build_id = imported.buildkite_build_id
                )
                SELECT failure_cache
                FROM failure_baselines
                WHERE scheduled_at < %s
                ORDER BY scheduled_at DESC, build_number DESC
                LIMIT 1
                """,
                (scheduled_at,),
            ).fetchone()
        return _failure_cache(row[0]) if row is not None else FailureCache.empty()

    def latest_checkpoint(self) -> CheckpointRef | None:
        # Insertion order is chronological: the imported seed is the first row
        # and each committed analysis appends its own checkpoint.
        with self._connection_factory() as connection:
            row = connection.execute(
                """
                SELECT s3_uri, sha256, schema_version
                FROM alerting_analyzer_checkpoints
                ORDER BY checkpoint_id DESC
                LIMIT 1
                """
            ).fetchone()
        if row is None:
            return None
        return CheckpointRef(s3_uri=row[0], sha256=row[1], schema_version=row[2])

    def prior_condition(
        self, job_name: str, *, before: datetime
    ) -> FailureCondition | None:
        with self._connection_factory() as connection:
            row = connection.execute(
                """
                SELECT fc.job_name, fc.lifecycle, fc.cause, fc.summary,
                       fc.culprit_pr_number, fc.culprit_pr_url, fc.culprit_pr_title,
                       fc.fixing_pr_number, fc.fixing_pr_url, fc.fixing_pr_title
                FROM alerting_full_ci_failure_conditions AS fc
                JOIN alerting_full_ci_analyses AS a
                    ON a.current_build_id = fc.current_build_id
                JOIN alerting_full_ci_runs AS r
                    ON r.buildkite_build_id = a.current_build_id
                WHERE fc.job_name = %s AND r.scheduled_at < %s
                ORDER BY r.scheduled_at DESC, r.build_number DESC
                LIMIT 1
                """,
                (job_name, before),
            ).fetchone()
        return _condition(row) if row is not None else None

    def commit_analysis(
        self,
        *,
        analysis: CompletedAnalysis,
        notification: NotificationIntent,
        now: datetime,
    ) -> None:
        with self._connection_factory() as connection:
            with connection.transaction():
                inserted = connection.execute(
                    """
                    INSERT INTO alerting_full_ci_analyses (
                        current_build_id, previous_build_id, report_text,
                        failure_cache, suspicious_prs, analyzed_at
                    ) VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s)
                    ON CONFLICT (current_build_id) DO NOTHING
                    RETURNING current_build_id
                    """,
                    (
                        analysis.current_build_id,
                        analysis.previous_build_id,
                        analysis.report_text,
                        json.dumps(_cache_payload(analysis.failure_cache)),
                        json.dumps(_suspicious_payload(analysis.suspicious_prs)),
                        now,
                    ),
                ).fetchone()
                if inserted is None:
                    return  # already committed by an earlier attempt
                if analysis.commit_pull_request is not None:
                    # The run row is written at ingest, before anything has
                    # asked GitHub what its commit belongs to, so the pull
                    # request lands here where the answer already exists.
                    connection.execute(
                        """
                        UPDATE alerting_full_ci_runs
                        SET commit_pr_number = %s,
                            commit_pr_url = %s,
                            commit_pr_title = %s
                        WHERE buildkite_build_id = %s
                        """,
                        (
                            analysis.commit_pull_request.number,
                            analysis.commit_pull_request.url,
                            analysis.commit_pull_request.title,
                            analysis.current_build_id,
                        ),
                    )
                if analysis.conditions:
                    _executemany(connection,
                        """
                        INSERT INTO alerting_full_ci_failure_conditions (
                            current_build_id, job_name, lifecycle, cause, summary,
                            culprit_pr_number, culprit_pr_url, culprit_pr_title,
                            fixing_pr_number, fixing_pr_url, fixing_pr_title
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        [
                            (
                                analysis.current_build_id,
                                condition.job_name,
                                condition.lifecycle.value,
                                condition.cause.value,
                                condition.summary,
                                _pr_number(condition.culprit_pr),
                                _pr_url(condition.culprit_pr),
                                _pr_title(condition.culprit_pr),
                                _pr_number(condition.fixing_pr),
                                _pr_url(condition.fixing_pr),
                                _pr_title(condition.fixing_pr),
                            )
                            for condition in analysis.conditions
                        ],
                    )
                connection.execute(
                    """
                    INSERT INTO alerting_analyzer_checkpoints (
                        current_build_id, s3_uri, sha256, schema_version, created_at
                    ) VALUES (%s, %s, %s, %s, %s)
                    """,
                    (
                        analysis.current_build_id,
                        analysis.checkpoint.s3_uri,
                        analysis.checkpoint.sha256,
                        analysis.checkpoint.schema_version,
                        now,
                    ),
                )
                self._enqueue(connection, notification, next_attempt_at=now)


def _cache_payload(cache: FailureCache) -> dict[str, Any]:
    return {
        "build_number": cache.build_number,
        "commit": cache.commit,
        "failed_tests": list(cache.failed_tests),
    }


def _failure_cache(payload: Any) -> FailureCache:
    return FailureCache(
        build_number=payload.get("build_number"),
        commit=payload.get("commit"),
        failed_tests=tuple(str(name) for name in payload.get("failed_tests", [])),
    )


def _suspicious_payload(
    suspicious_prs: tuple[SuspiciousPR, ...],
) -> list[dict[str, Any]]:
    return [
        {
            "pr_number": pr.pr_number,
            "pr_url": pr.pr_url,
            "pr_title": pr.pr_title,
            "failure_count": pr.failure_count,
            "failed_tests": list(pr.failed_tests),
            "summary": pr.summary,
        }
        for pr in suspicious_prs
    ]


def _pr_number(pr: PullRequestRef | None) -> int | None:
    return pr.number if pr is not None else None


def _pr_url(pr: PullRequestRef | None) -> str | None:
    return pr.url if pr is not None else None


def _pr_title(pr: PullRequestRef | None) -> str | None:
    return pr.title if pr is not None else None


def _condition(row: Any) -> FailureCondition:
    culprit = (
        PullRequestRef(number=row[4], url=row[5], title=row[6])
        if row[4] is not None
        else None
    )
    fixing = (
        PullRequestRef(number=row[7], url=row[8], title=row[9])
        if row[7] is not None
        else None
    )
    return FailureCondition(
        job_name=row[0],
        lifecycle=FailureLifecycle(row[1]),
        cause=CauseCategory(row[2]),
        summary=row[3],
        culprit_pr=culprit,
        fixing_pr=fixing,
    )


def build_fast_ci_runtime(
    *,
    database_url: str,
    databricks_host: str,
    databricks_token: str,
    databricks_warehouse_id: str,
    slack: SlackPort,
    clock: Clock,
    delivery_mode: DeliveryMode = DeliveryMode.LIVE,
) -> AlertingRuntime:
    """Wire production Fast CI source and Postgres state into the runtime."""
    from alerting.fast_ci import (
        DatabricksFastCISource,
        DatabricksStatementClient,
        FastCIScanHandler,
    )

    store = PostgresAlertStore.from_database_url(database_url)
    source = DatabricksFastCISource(
        DatabricksStatementClient(
            host=databricks_host,
            token=databricks_token,
            warehouse_id=databricks_warehouse_id,
        )
    )
    handler = FastCIScanHandler(
        source=source,
        store=store,
        clock=clock,
        delivery_mode=delivery_mode,
    )
    return AlertingRuntime(
        executions=store,
        outbox=store,
        slack=slack,
        clock=clock,
        handlers={"fast_ci_scan": handler},
        stale_notifications=store,
        alert_path=AlertPath.FAST_CI,
    )


def build_full_ci_runtime(
    *,
    database_url: str,
    buildkite_token: str,
    slack: SlackPort,
    clock: Clock,
    delivery_mode: DeliveryMode = DeliveryMode.LIVE,
) -> AlertingRuntime:
    """Wire production Full CI source and Postgres state into the runtime."""
    from alerting.full_ci import (
        BuildkiteFullCISource,
        BuildkiteRestClient,
        FullCIReconciliationHandler,
    )

    store = PostgresAlertStore.from_database_url(database_url)
    source = BuildkiteFullCISource(BuildkiteRestClient(token=buildkite_token))
    handler = FullCIReconciliationHandler(source=source, store=store, clock=clock)
    return AlertingRuntime(
        executions=store,
        outbox=store,
        slack=slack,
        clock=clock,
        handlers={"full_ci_reconcile": handler},
        alert_path=AlertPath.FULL_CI,
    )


def build_main_ci_runtime(
    *,
    database_url: str,
    buildkite_token: str,
    slack: SlackPort,
    clock: Clock,
) -> AlertingRuntime:
    """Wire Main CI exact-job lifecycle reconciliation into the runtime."""
    from alerting.full_ci import BuildkiteRestClient
    from alerting.main_ci import BuildkiteMainCISource, MainCIReconciliationHandler

    store = PostgresAlertStore.from_database_url(database_url)
    source = BuildkiteMainCISource(BuildkiteRestClient(token=buildkite_token))
    handler = MainCIReconciliationHandler(source=source, store=store, clock=clock)
    return AlertingRuntime(
        executions=store,
        outbox=store,
        slack=slack,
        clock=clock,
        handlers={"main_ci_reconcile": handler},
        alert_path=AlertPath.MAIN_CI,
    )


def build_main_ci_backstop_runtime(
    *,
    database_url: str,
    buildkite_token: str,
    slack: SlackPort,
    clock: Clock,
) -> AlertingRuntime:
    """Wire the hourly Main CI retry-resolution backstop into the runtime."""
    from alerting.full_ci import BuildkiteRestClient
    from alerting.main_ci import MainCIBackstopHandler

    store = PostgresAlertStore.from_database_url(database_url)
    handler = MainCIBackstopHandler(
        builds=BuildkiteRestClient(token=buildkite_token),
        store=store,
        clock=clock,
    )
    return AlertingRuntime(
        executions=store,
        outbox=store,
        slack=slack,
        clock=clock,
        handlers={"main_ci_backstop": handler},
        alert_path=AlertPath.MAIN_CI,
    )


def build_main_ci_analysis_runtime(
    *,
    database_url: str,
    buildkite_token: str,
    github_token: str,
    kimi_api_key: str,
    slack: SlackPort,
    clock: Clock,
    runner: MainCIAnalysisRunner | None = None,
    kimi_base_url: str = "https://api2.inferact.dev/v1",
    kimi_model: str = "moonshotai/Kimi-K3",
    kimi_timeout_seconds: int = 600,
    kimi_reasoning_effort: str = "low",
) -> AlertingRuntime:
    """Wire the Main CI analysis sidecar into the runtime.

    The sidecar never enqueues notifications and never writes alert state;
    it only reads open alerts and upserts rows in the analysis table.
    """
    from alerting.analyzer import GitHubRestClient
    from alerting.kimi import KimiCodeRunner
    from alerting.main_ci_analysis import (
        BuildkiteJobLogClient,
        MainCIAnalysisHandler,
    )

    store = PostgresAlertStore.from_database_url(database_url)
    handler = MainCIAnalysisHandler(
        store=store,
        logs=BuildkiteJobLogClient(token=buildkite_token),
        github=GitHubRestClient(token=github_token),
        runner=runner
        if runner is not None
        else KimiCodeRunner(
            api_key=kimi_api_key,
            base_url=kimi_base_url,
            model=kimi_model,
            timeout_seconds=kimi_timeout_seconds,
            reasoning_effort=kimi_reasoning_effort,
        ),
        clock=clock,
        model_version=kimi_model,
    )
    return AlertingRuntime(
        executions=store,
        outbox=store,
        slack=slack,
        clock=clock,
        handlers={"main_ci_analyze": handler},
        alert_path=AlertPath.MAIN_CI,
    )

def build_full_ci_analysis_runtime(
    *,
    database_url: str,
    buildkite_token: str,
    github_token: str,
    checkpoint_bucket: str,
    kimi_api_key: str,
    slack: SlackPort,
    clock: Clock,
    runner: AnalyzerRunner | None = None,
    kimi_base_url: str = "https://api2.inferact.dev/v1",
    kimi_model: str = "moonshotai/Kimi-K3",
    kimi_timeout_seconds: int = 3600,
    kimi_reasoning_effort: str = "low",
    delivery_mode: DeliveryMode = DeliveryMode.LIVE,
) -> AlertingRuntime:
    """Wire the production analyzer compatibility adapter into the runtime."""
    from alerting.analyzer import (
        FullCIAnalysisHandler,
        GitHubRestClient,
        S3CheckpointStore,
    )
    from alerting.full_ci import BuildkiteRestClient
    from alerting.kimi import KimiCodeRunner

    store = PostgresAlertStore.from_database_url(database_url)
    handler = FullCIAnalysisHandler(
        store=store,
        builds=BuildkiteRestClient(token=buildkite_token),
        runner=runner
        if runner is not None
        else KimiCodeRunner(
            api_key=kimi_api_key,
            base_url=kimi_base_url,
            model=kimi_model,
            timeout_seconds=kimi_timeout_seconds,
            reasoning_effort=kimi_reasoning_effort,
        ),
        checkpoints=S3CheckpointStore(bucket=checkpoint_bucket),
        github=GitHubRestClient(token=github_token),
        clock=clock,
        delivery_mode=delivery_mode,
    )
    return AlertingRuntime(
        executions=store,
        outbox=store,
        slack=slack,
        clock=clock,
        handlers={"full_ci_analyze": handler},
        stale_notifications=store,
        alert_path=AlertPath.FULL_CI,
    )
