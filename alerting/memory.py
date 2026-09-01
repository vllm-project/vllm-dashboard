"""In-memory adapters for the runtime's ports.

Used by tests, and as executable documentation of the semantics the Postgres
adapters must provide: the executions dict mimics the primary-key constraint
on the idempotency key, and `lease_due` mimics `FOR UPDATE SKIP LOCKED`
leasing of due outbox rows.
"""

from __future__ import annotations

import copy
from dataclasses import replace
from datetime import datetime, timedelta

from alerting.analyzer import (
    CheckpointRef,
    ComparisonContext,
    CompletedAnalysis,
    FailureCache,
    FailureCondition,
    PersistedAnalysis,
)
from alerting.commands import ScheduledCommand
from alerting.fast_ci import (
    STALE_NOTIFICATION_AGE,
    BatchFactory,
    FastFailureEvent,
    ordered_unique_events,
    recovery_notification,
)
from alerting.full_ci import (
    FullCIComparison,
    FullCIJobOutcome,
    FullCIReconciliationState,
    FullCIRun,
    ordered_unique_runs,
)
from alerting.main_ci import (
    MainCIJobAlert,
    MainCIJobObservation,
    ordered_unique_observations,
)
from alerting.main_ci_analysis import MainCIAnalysisTarget, MainCIJobAnalysis
from alerting.ports import (
    AlertPath,
    ClaimOutcome,
    AutomationExecution,
    AutomationExecutionStatus,
    NotificationIntent,
    NotificationIntentRecord,
    OutboxStatus,
)


class FixedClock:
    """A manually advanced clock for deterministic tests."""

    def __init__(self, start: datetime) -> None:
        if start.tzinfo is None:
            raise ValueError("start must be timezone-aware")
        self._now = start

    def now(self) -> datetime:
        return self._now

    def advance(self, *, minutes: float = 0, seconds: float = 0) -> None:
        self._now += timedelta(minutes=minutes, seconds=seconds)

    def advance_preview(self, *, minutes: float = 0, seconds: float = 0) -> datetime:
        """The instant `advance` would move to, without moving."""
        return self._now + timedelta(minutes=minutes, seconds=seconds)


class InMemoryAutomationExecutionStore:
    def __init__(self) -> None:
        self._records: dict[str, AutomationExecution] = {}
        self._fail_complete = False

    def claim(
        self, command: ScheduledCommand, *, now: datetime, lease_until: datetime
    ) -> ClaimOutcome:
        key = command.idempotency_key
        record = self._records.get(key)
        if record is None:
            self._records[key] = AutomationExecution(
                idempotency_key=key,
                command_type=command.command_type,
                schema_version=command.schema_version,
                target_time=command.target_time,
                status=AutomationExecutionStatus.RUNNING,
                attempts=1,
                lease_expires_at=lease_until,
            )
            return ClaimOutcome.CLAIMED
        if record.status is AutomationExecutionStatus.COMPLETED:
            return ClaimOutcome.ALREADY_COMPLETED
        if (
            record.status is AutomationExecutionStatus.RUNNING
            and record.lease_expires_at is not None
            and record.lease_expires_at > now
        ):
            return ClaimOutcome.LEASE_HELD
        record.status = AutomationExecutionStatus.RUNNING
        record.attempts += 1
        record.lease_expires_at = lease_until
        return ClaimOutcome.CLAIMED

    def complete(self, idempotency_key: str, *, now: datetime) -> None:
        if self._fail_complete:
            # Crash after a durable commit but before the completion marker.
            self._fail_complete = False
            raise RuntimeError("completion marker lost")
        record = self._records[idempotency_key]
        record.status = AutomationExecutionStatus.COMPLETED
        record.completed_at = now
        record.lease_expires_at = None
        record.last_error = None

    def fail_next_complete(self) -> None:
        self._fail_complete = True

    def fail(self, idempotency_key: str, error: str, *, now: datetime) -> None:
        record = self._records[idempotency_key]
        if record.status is AutomationExecutionStatus.COMPLETED:
            return
        record.status = AutomationExecutionStatus.FAILED
        record.last_error = error
        record.lease_expires_at = None

    def get(self, idempotency_key: str) -> AutomationExecution | None:
        record = self._records.get(idempotency_key)
        return replace(record) if record is not None else None

    def count(self) -> int:
        return len(self._records)

    def _snapshot(self) -> dict[str, AutomationExecution]:
        return copy.deepcopy(self._records)

    def _restore(self, records: dict[str, AutomationExecution]) -> None:
        self._records = records


class InMemoryOutboxStore:
    def __init__(self) -> None:
        self._records: dict[str, NotificationIntentRecord] = {}

    def enqueue(
        self,
        message: NotificationIntent,
        *,
        now: datetime,
        next_attempt_at: datetime | None = None,
    ) -> None:
        if message.delivery_id in self._records:
            return
        self._records[message.delivery_id] = NotificationIntentRecord(
            delivery_id=message.delivery_id,
            alert_ref=message.alert_ref,
            alert_path=message.alert_path,
            delivery_mode=message.delivery_mode,
            destination_mode=message.destination_mode,
            destination=message.destination,
            payload=dict(message.payload),
            status=OutboxStatus.PENDING,
            attempts=0,
            next_attempt_at=next_attempt_at if next_attempt_at is not None else now,
            created_at=now,
        )

    def lease_due(
        self,
        *,
        now: datetime,
        lease_until: datetime,
        limit: int,
        alert_path: AlertPath | None = None,
    ) -> list[NotificationIntentRecord]:
        due = [
            record
            for record in self._records.values()
            if record.status in (OutboxStatus.PENDING, OutboxStatus.RETRYING)
            and record.delivery_mode.value == "live"
            and (alert_path is None or record.alert_path is alert_path)
            and record.superseded_by is None
            and record.next_attempt_at <= now
            and (record.lease_expires_at is None or record.lease_expires_at <= now)
        ]
        due.sort(key=lambda record: record.next_attempt_at)
        leased = due[:limit]
        for record in leased:
            record.lease_expires_at = lease_until
            record.attempts += 1
        return [replace(record) for record in leased]

    def mark_delivered(
        self, delivery_id: str, *, slack_ts: str | None, now: datetime
    ) -> None:
        record = self._records[delivery_id]
        record.status = OutboxStatus.DELIVERED
        record.slack_ts = slack_ts
        record.lease_expires_at = None

    def mark_retrying(
        self, delivery_id: str, *, error: str, next_attempt_at: datetime, now: datetime
    ) -> None:
        record = self._records[delivery_id]
        if record.status is OutboxStatus.DELIVERED:
            return
        record.status = OutboxStatus.RETRYING
        record.last_error = error
        record.next_attempt_at = next_attempt_at
        record.lease_expires_at = None

    def mark_dead_letter(self, delivery_id: str, *, error: str, now: datetime) -> None:
        record = self._records[delivery_id]
        if record.status is OutboxStatus.DELIVERED:
            return
        record.status = OutboxStatus.DEAD_LETTER
        record.last_error = error
        record.lease_expires_at = None

    def get_outbox(self, delivery_id: str) -> NotificationIntentRecord | None:
        record = self._records.get(delivery_id)
        return replace(record) if record is not None else None

    def count(self) -> int:
        return len(self._records)

    def records(self) -> list[NotificationIntentRecord]:
        return [replace(record) for record in self._records.values()]

    def _snapshot(self) -> dict[str, NotificationIntentRecord]:
        return copy.deepcopy(self._records)

    def _restore(self, records: dict[str, NotificationIntentRecord]) -> None:
        self._records = records


class InMemoryFastCIStore:
    """Atomic in-memory model of Fast CI events, outbox, cursor, and completion."""

    def __init__(
        self,
        *,
        executions: InMemoryAutomationExecutionStore,
        outbox: InMemoryOutboxStore,
    ) -> None:
        self._executions = executions
        self._outbox = outbox
        self._events: dict[str, FastFailureEvent] = {}
        self._imported_job_ids: set[str] = set()
        self._cursor: datetime | None = None
        self._delivery_ids: dict[str, list[str]] = {}
        self._fail_commit = False

    def scan_cursor(self) -> datetime | None:
        return self._cursor

    def commit_scan(
        self,
        *,
        command: ScheduledCommand,
        observations: list[FastFailureEvent],
        scanned_through: datetime,
        now: datetime,
        batch_factory: BatchFactory,
    ) -> None:
        execution_snapshot = self._executions._snapshot()
        outbox_snapshot = self._outbox._snapshot()
        event_snapshot = dict(self._events)
        cursor_snapshot = self._cursor
        delivery_snapshot = dict(self._delivery_ids)
        try:
            new_events: list[FastFailureEvent] = []
            for event in ordered_unique_events(observations):
                if (
                    event.job_id in self._events
                    or event.job_id in self._imported_job_ids
                ):
                    continue
                new_events.append(event)
                self._events[event.job_id] = event
            notification_batches = batch_factory(new_events)
            for batch in notification_batches:
                self._outbox.enqueue(batch.message, now=now)
                for job_id in batch.job_ids:
                    self._delivery_ids[job_id] = [batch.message.delivery_id]
            if self._cursor is None or scanned_through > self._cursor:
                self._cursor = scanned_through
            if self._fail_commit:
                self._fail_commit = False
                raise RuntimeError("Fast CI transaction failed")
            self._executions.complete(command.idempotency_key, now=now)
        except Exception:
            self._executions._restore(execution_snapshot)
            self._outbox._restore(outbox_snapshot)
            self._events = event_snapshot
            self._cursor = cursor_snapshot
            self._delivery_ids = delivery_snapshot
            raise

    def events(self) -> list[FastFailureEvent]:
        return list(self._events.values())

    def delivery_id_for(self, job_id: str) -> str | None:
        delivery_ids = self._delivery_ids.get(job_id, [])
        return delivery_ids[-1] if delivery_ids else None

    def delivery_ids_for(self, job_id: str) -> tuple[str, ...]:
        return tuple(self._delivery_ids.get(job_id, []))

    def consolidate_stale_notifications(self, *, now: datetime) -> None:
        stale_before = now - STALE_NOTIFICATION_AGE
        stale_delivery_ids = {
            delivery_id
            for delivery_ids in self._delivery_ids.values()
            for delivery_id in delivery_ids
            if delivery_id.startswith("fast-ci:")
            and not delivery_id.startswith("fast-ci-recovery:")
            and (record := self._outbox._records.get(delivery_id)) is not None
            and record.status in (OutboxStatus.PENDING, OutboxStatus.RETRYING)
            and record.superseded_by is None
            and record.created_at is not None
            and record.created_at <= stale_before
            and (record.lease_expires_at is None or record.lease_expires_at <= now)
        }
        if not stale_delivery_ids:
            return

        events = [
            event
            for job_id, event in self._events.items()
            if stale_delivery_ids.intersection(self._delivery_ids.get(job_id, []))
        ]
        summary = recovery_notification(events, sorted(stale_delivery_ids))
        self._outbox.enqueue(summary.message, now=now)
        for delivery_id in stale_delivery_ids:
            record = self._outbox._records[delivery_id]
            record.superseded_by = summary.message.delivery_id
            record.lease_expires_at = None
            record.last_error = (
                f"consolidated into recovery summary {summary.message.delivery_id}"
            )
        for job_id in summary.job_ids:
            delivery_ids = self._delivery_ids[job_id]
            if summary.message.delivery_id not in delivery_ids:
                delivery_ids.append(summary.message.delivery_id)

    def fail_next_commit(self) -> None:
        self._fail_commit = True

    def seed_imported_job_ids(self, job_ids: set[str]) -> None:
        """Seed legacy job IDs imported before cutover."""
        self._imported_job_ids.update(job_ids)


class InMemoryFullCIStore:
    """Atomic in-memory model of Full CI ingest and execution completion."""

    def __init__(self, *, executions: InMemoryAutomationExecutionStore) -> None:
        self._executions = executions
        self._runs: dict[str, FullCIRun] = {}
        self._jobs: dict[str, list[FullCIJobOutcome]] = {}
        self._comparisons: dict[str, FullCIComparison] = {}

    def reconciliation_state(self) -> FullCIReconciliationState:
        return FullCIReconciliationState(
            start_time=min(
                (run.scheduled_at for run in self._runs.values()), default=None
            ),
            processed_build_ids=frozenset(self._runs),
        )

    def commit_reconciliation(
        self,
        *,
        command: ScheduledCommand,
        observations: list[FullCIRun],
        now: datetime,
    ) -> None:
        execution_snapshot = self._executions._snapshot()
        runs_snapshot = dict(self._runs)
        jobs_snapshot = copy.deepcopy(self._jobs)
        comparisons_snapshot = dict(self._comparisons)
        try:
            for run in ordered_unique_runs(observations):
                if run.build_id in self._runs:
                    continue
                run_key = (run.scheduled_at, run.build_number)
                previous = max(
                    (
                        stored
                        for stored in self._runs.values()
                        if (stored.scheduled_at, stored.build_number) < run_key
                    ),
                    key=lambda item: (item.scheduled_at, item.build_number),
                    default=None,
                )
                following = min(
                    (
                        stored
                        for stored in self._runs.values()
                        if (stored.scheduled_at, stored.build_number) > run_key
                    ),
                    key=lambda item: (item.scheduled_at, item.build_number),
                    default=None,
                )
                self._runs[run.build_id] = run
                self._jobs[run.build_id] = list(
                    {job.name: job for job in run.jobs}.values()
                )
                if previous is not None:
                    self._comparisons[run.build_id] = FullCIComparison(
                        previous_build_id=previous.build_id,
                        current_build_id=run.build_id,
                    )
                if following is not None:
                    self._comparisons[following.build_id] = FullCIComparison(
                        previous_build_id=run.build_id,
                        current_build_id=following.build_id,
                    )
            self._executions.complete(command.idempotency_key, now=now)
        except Exception:
            self._executions._restore(execution_snapshot)
            self._runs = runs_snapshot
            self._jobs = jobs_snapshot
            self._comparisons = comparisons_snapshot
            raise

    def runs(self) -> list[FullCIRun]:
        return sorted(
            self._runs.values(),
            key=lambda item: (item.scheduled_at, item.build_number),
        )

    def job_outcomes(self, build_id: str) -> list[FullCIJobOutcome]:
        return list(self._jobs.get(build_id, []))

    def comparisons(self) -> list[FullCIComparison]:
        return [
            self._comparisons[run.build_id]
            for run in self.runs()
            if run.build_id in self._comparisons
        ]


class InMemoryMainCIStore:
    """Atomic in-memory model of Main CI current state and alert episodes."""

    def __init__(self, *, executions: InMemoryAutomationExecutionStore) -> None:
        self._executions = executions
        self._cursor: datetime | None = None
        self._states: dict[str, MainCIJobObservation] = {}
        self._alerts: list[MainCIJobAlert] = []
        self._active: dict[str, int] = {}

    def main_ci_scan_cursor(self) -> datetime | None:
        return self._cursor

    def commit_main_ci_scan(
        self,
        *,
        command: ScheduledCommand,
        observations: list[MainCIJobObservation],
        scanned_through: datetime,
        now: datetime,
    ) -> None:
        execution_snapshot = self._executions._snapshot()
        cursor_snapshot = self._cursor
        states_snapshot = dict(self._states)
        alerts_snapshot = list(self._alerts)
        active_snapshot = dict(self._active)
        try:
            for observation in ordered_unique_observations(observations):
                previous = self._states.get(observation.job_key)
                if previous is not None and previous.order >= observation.order:
                    continue
                self._states[observation.job_key] = observation
                active_index = self._active.get(observation.job_key)
                if observation.failed:
                    if active_index is None:
                        alert = MainCIJobAlert(
                            alert_id=len(self._alerts) + 1,
                            job_key=observation.job_key,
                            job_name=observation.job_name,
                            opened_at=observation.finished_at,
                            first_failure=observation,
                            last_failure=observation,
                            failure_count=1,
                        )
                        self._alerts.append(alert)
                        self._active[observation.job_key] = len(self._alerts) - 1
                    else:
                        active = self._alerts[active_index]
                        self._alerts[active_index] = replace(
                            active,
                            job_name=observation.job_name,
                            last_failure=observation,
                            failure_count=active.failure_count + 1,
                        )
                elif active_index is not None:
                    active = self._alerts[active_index]
                    self._alerts[active_index] = replace(
                        active,
                        job_name=observation.job_name,
                        resolved_at=observation.finished_at,
                        resolution=observation,
                    )
                    del self._active[observation.job_key]
            if self._cursor is None or scanned_through > self._cursor:
                self._cursor = scanned_through
            self._executions.complete(command.idempotency_key, now=now)
        except Exception:
            self._executions._restore(execution_snapshot)
            self._cursor = cursor_snapshot
            self._states = states_snapshot
            self._alerts = alerts_snapshot
            self._active = active_snapshot
            raise

    def alerts(self) -> list[MainCIJobAlert]:
        return list(self._alerts)

    def state(self, job_key: str) -> MainCIJobObservation | None:
        return self._states.get(job_key)


class InMemoryMainCIAnalysisStore:
    """In-memory model of the Main CI analysis sidecar table."""

    def __init__(self, *, main_ci: InMemoryMainCIStore) -> None:
        self._main_ci = main_ci
        self._analyses: dict[int, MainCIJobAnalysis] = {}

    def pending_main_ci_analyses(self, *, limit: int) -> list[MainCIAnalysisTarget]:
        targets: list[MainCIAnalysisTarget] = []
        for alert in self._main_ci.alerts():
            if alert.status != "open":
                continue
            existing = self._analyses.get(alert.alert_id)
            if (
                existing is not None
                and existing.analyzed_failure_job_id == alert.last_failure.job_id
            ):
                continue
            targets.append(
                MainCIAnalysisTarget(
                    alert_id=alert.alert_id,
                    job_key=alert.job_key,
                    job_name=alert.job_name,
                    opened_at=alert.opened_at,
                    last_failed_at=alert.last_failure.finished_at,
                    failure_count=alert.failure_count,
                    failure_job_id=alert.last_failure.job_id,
                    failure_build_number=alert.last_failure.build_number,
                    failure_build_url=alert.last_failure.build_url,
                    failure_job_url=alert.last_failure.job_url,
                    failure_commit_sha=alert.last_failure.commit_sha,
                )
            )
        targets.sort(key=lambda target: target.last_failed_at, reverse=True)
        return targets[:limit]

    def commit_main_ci_analysis(
        self, *, analysis: MainCIJobAnalysis, now: datetime
    ) -> None:
        # Mirror the Postgres freshness guard: a newer observed failure wins.
        for alert in self._main_ci.alerts():
            if alert.alert_id != analysis.alert_id:
                continue
            if alert.last_failure.job_id == analysis.analyzed_failure_job_id:
                self._analyses[analysis.alert_id] = analysis
            return

    def analyses(self) -> list[MainCIJobAnalysis]:
        return list(self._analyses.values())


class InMemoryAnalyzerStore:
    """Atomic in-memory model of Full CI analyses, conditions, and checkpoints."""

    def __init__(
        self,
        *,
        full_ci: InMemoryFullCIStore,
        outbox: InMemoryOutboxStore,
    ) -> None:
        self._full_ci = full_ci
        self._outbox = outbox
        self._analyses: dict[str, PersistedAnalysis] = {}
        self._checkpoints: dict[str, CheckpointRef] = {}
        self._seeded_checkpoint: CheckpointRef | None = None
        self._imported_baseline: tuple[str, FailureCache] | None = None
        self._fail_commit = False

    def _run(self, build_id: str) -> FullCIRun:
        for run in self._full_ci.runs():
            if run.build_id == build_id:
                return run
        raise KeyError(build_id)

    @staticmethod
    def _order(run: FullCIRun) -> tuple[datetime, int]:
        return (run.scheduled_at, run.build_number)

    def seed_checkpoint(self, checkpoint: CheckpointRef) -> None:
        """The initial checkpoint imported before cutover (ticket 12)."""
        self._seeded_checkpoint = checkpoint

    def seed_imported_baseline(
        self,
        *,
        build_id: str,
        failure_cache: FailureCache,
        checkpoint: CheckpointRef,
    ) -> None:
        """Seed legacy analyzer state without inventing a comparison or alert."""
        self._run(build_id)
        self._imported_baseline = (build_id, failure_cache)
        self._seeded_checkpoint = checkpoint

    def pending_comparisons(self) -> list[ComparisonContext]:
        contexts = [
            ComparisonContext(
                previous_build_id=comparison.previous_build_id,
                current=self._run(comparison.current_build_id),
            )
            for comparison in self._full_ci.comparisons()
            if comparison.current_build_id not in self._analyses
        ]
        contexts.sort(key=lambda context: self._order(context.current))
        return contexts

    def failure_cache_before(self, scheduled_at: datetime) -> FailureCache:
        candidates: list[tuple[tuple[datetime, int], FailureCache]] = [
            (
                self._order(self._run(analysis.current_build_id)),
                analysis.failure_cache,
            )
            for analysis in self._analyses.values()
            if self._order(self._run(analysis.current_build_id)) < (scheduled_at, 0)
        ]
        if self._imported_baseline is not None:
            build_id, cache = self._imported_baseline
            order = self._order(self._run(build_id))
            if order < (scheduled_at, 0):
                candidates.append((order, cache))
        if not candidates:
            return FailureCache.empty()
        return max(candidates, key=lambda candidate: candidate[0])[1]

    def latest_checkpoint(self) -> CheckpointRef | None:
        if not self._analyses:
            return self._seeded_checkpoint
        latest = max(
            self._analyses.values(),
            key=lambda a: self._order(self._run(a.current_build_id)),
        )
        return self._checkpoints[latest.current_build_id]

    def prior_condition(
        self, job_name: str, *, before: datetime
    ) -> FailureCondition | None:
        best: tuple[tuple[datetime, int], FailureCondition] | None = None
        for analysis in self._analyses.values():
            order = self._order(self._run(analysis.current_build_id))
            if order >= (before, 0):
                continue
            for condition in analysis.conditions:
                if condition.job_name != job_name:
                    continue
                if best is None or order > best[0]:
                    best = (order, condition)
        return best[1] if best is not None else None

    def commit_analysis(
        self,
        *,
        analysis: CompletedAnalysis,
        notification: NotificationIntent,
        now: datetime,
    ) -> None:
        analyses_snapshot = dict(self._analyses)
        checkpoints_snapshot = dict(self._checkpoints)
        outbox_snapshot = self._outbox._snapshot()
        try:
            if analysis.current_build_id in self._analyses:
                return  # idempotent replay of an already-committed analysis
            self._analyses[analysis.current_build_id] = PersistedAnalysis(
                current_build_id=analysis.current_build_id,
                previous_build_id=analysis.previous_build_id,
                report_text=analysis.report_text,
                failure_cache=analysis.failure_cache,
                suspicious_prs=analysis.suspicious_prs,
                conditions=analysis.conditions,
                analyzed_at=now,
            )
            self._checkpoints[analysis.current_build_id] = analysis.checkpoint
            self._outbox.enqueue(notification, now=now)
            if self._fail_commit:
                self._fail_commit = False
                raise RuntimeError("Full CI analysis transaction failed")
        except Exception:
            self._analyses = analyses_snapshot
            self._checkpoints = checkpoints_snapshot
            self._outbox._restore(outbox_snapshot)
            raise

    def fail_next_commit(self) -> None:
        self._fail_commit = True

    def analyses(self) -> list[PersistedAnalysis]:
        return sorted(
            self._analyses.values(),
            key=lambda a: self._order(self._run(a.current_build_id)),
        )


class RecordingSlackPort:
    """Records deliveries; scripted failures are raised once per `fail_next`."""

    def __init__(self, ts: str = "0.0") -> None:
        self.ts = ts
        self.deliveries: list[NotificationIntentRecord] = []
        self._failures: dict[str, list[Exception]] = {}

    def fail_next(self, delivery_id: str, error: Exception) -> None:
        self._failures.setdefault(delivery_id, []).append(error)

    def deliver(self, record: NotificationIntentRecord) -> str | None:
        queued = self._failures.get(record.delivery_id)
        if queued:
            raise queued.pop(0)
        self.deliveries.append(record)
        return self.ts
