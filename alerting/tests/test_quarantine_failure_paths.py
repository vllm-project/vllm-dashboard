"""Quarantine failure paths on the worker side (ticket 22).

A healthy host never exercises these: a worker that restarts or loses a
commit mid-sequence, an operator action landing between a scan's read and its
write, reports from an older stage, a duplicate Xid delivery, an actuator that
goes quiet, and a host that vanishes. Everything runs against the in-memory
store and a controlled clock.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from test_infra import (  # type: ignore[import-not-found]
    START,
    FixtureHosts,
    FixtureSnapshots,
    quarantine_decision,
)

from alerting.commands import ScheduledCommand
from alerting.infra import (
    InfraAlertEpisode,
    InfraScanHandler,
    InfraSubjectState,
    InfraThreshold,
    QuarantineDecision,
    XidEvent,
    plan_quarantine,
)
from alerting.memory import (
    FixedClock,
    InMemoryAutomationExecutionStore,
    InMemoryInfraStore,
    InMemoryOutboxStore,
    RecordingSlackPort,
)
from alerting.runtime import AlertingRuntime, ProcessStatus

HOST = "gpu-node-7"


class Snapshots(FixtureSnapshots):  # type: ignore[misc]
    """Fixture tables that can run a callback once the scan has read the
    episodes, the way an operator or actuator write lands mid-scan."""

    def __init__(self) -> None:
        super().__init__()
        self.threshold_rows: list[InfraThreshold] = []
        self.agents = [(f"gpu-node-{n}", "h200_35gb") for n in range(1, 9)]
        self.during_scan: Callable[[], object] | None = None

    def xid_events(
        self, *, hostnames: Iterable[str], since: datetime
    ) -> list[XidEvent]:
        if self.during_scan is not None:
            hook, self.during_scan = self.during_scan, None
            hook()
        events: list[XidEvent] = super().xid_events(hostnames=hostnames, since=since)
        return events


class Rig:
    """One worker over durable stores. `restart` builds a new worker (handler
    and runtime) over the same stores: nothing but the database survives."""

    def __init__(
        self, decisions: list[QuarantineDecision] | None = None
    ) -> None:
        self.clock = FixedClock(START)
        self.executions = InMemoryAutomationExecutionStore()
        self.outbox = InMemoryOutboxStore()
        self.slack = RecordingSlackPort()
        self.store = InMemoryInfraStore(
            executions=self.executions, outbox=self.outbox
        )
        self.snapshots = Snapshots()
        self.decisions = [quarantine_decision()] if decisions is None else decisions
        self.restart()

    def restart(self) -> None:
        self.runtime = AlertingRuntime(
            executions=self.executions,
            outbox=self.outbox,
            slack=self.slack,
            clock=self.clock,
            handlers={
                "infra_scan": InfraScanHandler(
                    hosts=FixtureHosts(),
                    snapshots=self.snapshots,
                    store=self.store,
                    clock=self.clock,
                    quarantine_decisions=lambda: list(self.decisions),
                    quarantine_live=True,
                )
            },
            alert_path=None,
        )

    def scan(self, *, minutes: float = 5) -> ProcessStatus:
        self.clock.advance(minutes=minutes)
        result = self.runtime.process_command(
            ScheduledCommand(
                command_type="infra_scan", target_time=self.clock.now()
            )
        )
        self.runtime.dispatch_due_notifications()
        return result.status

    def report(self, host: str = HOST, **fields: Any) -> None:
        """What the dashboard's applied endpoint merges into the episode."""
        self.store.update_details("quarantine", host, **fields)

    @property
    def details(self) -> dict[str, Any]:
        [episode] = self.store.open_episodes()
        return episode.details

    @property
    def texts(self) -> list[str]:
        return [str(d.payload["text"]) for d in self.slack.deliveries]


def at(rig: Rig, minutes: float = 0) -> str:
    return (rig.clock.now() + timedelta(minutes=minutes)).isoformat()


def test_a_restarted_worker_picks_up_where_the_last_one_stopped() -> None:
    rig = Rig()
    rig.scan()
    assert rig.details["stage"] == "quarantining"
    assert rig.details["hostname"] == HOST
    rig.restart()
    # The same standing decision opens nothing new and posts nothing again.
    rig.scan()
    assert [e.alert_id for e in rig.store.episodes()] == [1]
    assert len(rig.texts) == 1

    rig.report(actuator_state="drained")
    rig.restart()
    rig.scan()
    assert rig.details["stage"] == "quarantined"
    assert rig.details["quarantined_at"] == rig.clock.now().isoformat()
    assert len(rig.texts) == 2
    # A restart in the middle of a resolve resumes it, too.
    rig.report(
        stage="resolving",
        resolved_by="oncall",
        resolve_requested_at=at(rig),
        resolving_at=at(rig),
        actuator_state="returned",
    )
    rig.restart()
    rig.scan()
    assert rig.store.open_episodes() == []
    assert "back in service" in rig.texts[-1]
    assert len(rig.texts) == 3


def test_a_scan_that_fails_to_commit_loses_nothing_and_posts_once_on_retry() -> None:
    rig = Rig()
    rig.scan()
    rig.report(actuator_state="drained")
    rig.store.fail_next_commit()
    assert rig.scan() is ProcessStatus.FAILED
    # Rolled back whole: no stage change, no post, and the report is kept.
    assert rig.details["stage"] == "quarantining"
    assert rig.details["actuator_state"] == "drained"
    assert len(rig.texts) == 1

    rig.restart()
    assert rig.scan() is ProcessStatus.COMPLETED
    assert rig.details["stage"] == "quarantined"
    assert len(rig.texts) == 2
    rig.scan()
    assert len(rig.texts) == 2


def test_a_resolve_that_lands_during_a_scan_is_never_overwritten() -> None:
    rig = Rig()
    rig.scan()
    rig.report(actuator_state="drained")
    # The scan has read 'quarantining' + 'drained' and plans 'quarantined'.
    # Before it commits, a person resolves the host.
    rig.snapshots.during_scan = lambda: rig.report(
        stage="resolve_requested",
        resolved_by="oncall",
        resolve_requested_at=at(rig),
        actuator_state=None,
    )
    assert rig.scan() is ProcessStatus.COMPLETED
    assert rig.details["stage"] == "resolve_requested"
    assert rig.details["resolved_by"] == "oncall"
    assert "quarantined_at" not in rig.details
    # The dropped change posts nothing: only the command's own post exists.
    assert len(rig.texts) == 1


def test_a_return_that_lands_during_a_scan_is_not_resolved_twice() -> None:
    rig = Rig()
    rig.scan()
    rig.report(actuator_state="drained")
    rig.scan()
    rig.report(
        stage="resolving",
        resolved_by="oncall",
        resolve_requested_at=at(rig),
        resolving_at=at(rig),
        actuator_state="returned",
    )
    # Two workers scan at once (a lease expired mid-run): both plan the close.
    rig.snapshots.during_scan = lambda: rig.runtime.process_command(
        ScheduledCommand(
            command_type="infra_scan", target_time=rig.clock.now() + timedelta(seconds=1)
        )
    )
    rig.scan()
    assert rig.store.open_episodes() == []
    [closed] = rig.store.episodes()
    assert closed.details["stage"] == "resolved" and closed.resolved_at is not None
    assert sum("back in service" in t for t in rig.texts) == 1


NOW = datetime(2026, 9, 2, 10, 0, tzinfo=timezone.utc)


def quarantined(stage: str, actuator: str | None, **extra: Any) -> InfraAlertEpisode:
    recent = (NOW - timedelta(minutes=1)).isoformat()
    return InfraAlertEpisode(
        alert_id=7,
        alert_type="quarantine",
        subject_key=HOST,
        opened_at=NOW - timedelta(minutes=30),
        details={
            "stage": stage,
            "pool": "pool-a",
            "cluster": "h200",
            "reason": "Xid 79",
            "commanded_at": recent,
            "resolve_requested_at": recent,
            "resolving_at": recent,
            "actuator_state": actuator,
            "actuator_state_at": recent,
            **extra,
        },
    )


# An actuator report that belongs to a different stage than the episode's: a
# post from the quarantine that was still in flight when the resolve cleared
# the report, or one from a check the episode has already left.
OLDER_REPORTS = [
    ("quarantining", "returned"),
    ("quarantining", "verify_failed"),
    ("quarantining", "verified"),
    ("quarantined", "returned"),
    ("quarantined", "drained"),
    ("quarantined", "verify_failed"),
    ("resolve_requested", "returned"),
    ("resolve_requested", "drained"),
    ("resolve_requested", "verify_failed"),
    ("resolving", "drained"),
    ("resolving", "verifying"),
    ("resolving", "verified"),
]


@pytest.mark.parametrize(("stage", "actuator"), OLDER_REPORTS)
def test_a_report_from_another_stage_moves_nothing(stage: str, actuator: str) -> None:
    episode = quarantined(stage, actuator)
    plan = plan_quarantine(
        now=NOW,
        live=True,
        decisions=[],
        states={},
        open_episodes={("quarantine", HOST): episode},
        pool_sizes={"pool-a": 8},
    )
    assert plan.stage_changes == () and plan.resolved == () and plan.opened == ()


def test_a_returned_host_that_trips_again_starts_clean_and_waits_for_its_own_report() -> None:
    rig = Rig()
    rig.scan()
    rig.report(actuator_state="drained")
    rig.scan()
    rig.report(
        stage="resolving",
        resolved_by="oncall",
        resolve_requested_at=at(rig),
        resolving_at=at(rig),
        actuator_state="returned",
    )
    rig.scan()
    assert rig.store.open_episodes() == []
    # The decision still stands, so the next scan quarantines it again.
    rig.scan()
    [again] = rig.store.open_episodes()
    assert again.alert_id == 2
    assert again.details["stage"] == "quarantining"
    # None of the old episode's reports follow it.
    assert again.details.get("actuator_state") is None
    rig.scan()
    assert rig.details["stage"] == "quarantining"
    assert rig.details["repeat_of"]["by"] == "oncall"


def test_a_duplicate_xid_delivery_opens_one_quarantine_and_posts_once() -> None:
    rig = Rig(decisions=[])
    when = START + timedelta(minutes=1)
    event = XidEvent(HOST, "0000:1b:00.0", 79, when)
    rig.snapshots.xids = [event, event, replace(event)]
    rig.scan()
    rig.scan()
    rig.snapshots.xids.append(event)  # the reporter resends after a lost POST
    rig.scan()
    assert [e.alert_id for e in rig.store.episodes()] == [1]
    assert rig.details["stage"] == "quarantining"
    assert rig.details["evidence"]["xid"] == 79
    assert sum("will be quarantined" in t for t in rig.texts) == 1


def test_a_resent_xid_after_the_return_does_not_quarantine_again() -> None:
    rig = Rig(decisions=[])
    event = XidEvent(HOST, "0000:1b:00.0", 79, START + timedelta(minutes=1))
    rig.snapshots.xids = [event]
    rig.scan()
    rig.report(actuator_state="drained")
    rig.scan()
    rig.report(
        stage="resolving",
        resolved_by="oncall",
        resolve_requested_at=at(rig),
        actuator_state="returned",
    )
    rig.scan()
    assert rig.store.open_episodes() == []
    posts = len(rig.texts)
    rig.snapshots.xids = [event, event]
    for _ in range(3):
        rig.scan()
    assert rig.store.open_episodes() == []
    assert len(rig.texts) == posts


def test_an_actuator_that_never_confirms_is_flagged_once_and_still_advances_late() -> None:
    # A pause or taint that keeps failing posts nothing; the episode stays
    # 'quarantining', keeps its slot, and the silence is posted once.
    rig = Rig()
    rig.scan()
    for _ in range(2):
        rig.scan()
    assert rig.details["stage"] == "quarantining"
    assert "has not confirmed" in rig.texts[-1]
    stuck = len(rig.texts)
    for _ in range(12):  # three more hours of silence
        rig.scan(minutes=15)
    assert len(rig.texts) == stuck
    assert rig.details["stage"] == "quarantining"

    # A late 'out' (the pause finally landed, a job still running) is not
    # drained; only the drained report moves it on.
    rig.report(actuator_state="out", actuator_state_at=at(rig))
    rig.scan()
    assert rig.details["stage"] == "quarantining"
    rig.report(actuator_state="drained", actuator_state_at=at(rig))
    rig.scan()
    assert rig.details["stage"] == "quarantined"
    assert "is quarantined" in rig.texts[-1]


def test_a_resolve_nobody_confirms_posts_once_and_a_late_return_still_closes_it() -> None:
    rig = Rig()
    rig.scan()
    rig.report(actuator_state="drained")
    rig.scan()
    rig.report(
        stage="resolving",
        resolved_by="oncall",
        resolve_requested_at=at(rig),
        resolving_at=at(rig),
        actuator_state=None,
    )
    for _ in range(36):  # three hours at 5-minute scans
        rig.scan()
    assert rig.details["stage"] == "resolving"
    assert sum("has not confirmed returning" in t for t in rig.texts) == 1
    rig.report(actuator_state="returned", actuator_state_at=at(rig))
    rig.scan()
    assert rig.store.open_episodes() == []
    assert "back in service" in rig.texts[-1]


def test_a_host_that_vanishes_stays_quarantined_and_never_returns_by_itself() -> None:
    rig = Rig()
    rig.scan()
    rig.report(actuator_state="drained", actuator_state_at=at(rig))
    rig.scan()
    posts = len(rig.texts)
    # Its agents leave Buildkite, its reporter stops, and nothing flags it.
    rig.snapshots.agents = [a for a in rig.snapshots.agents if a[0] != HOST]
    rig.decisions.clear()
    rig.report(actuator_state=None)
    for _ in range(30):
        rig.scan()
    assert rig.details["stage"] == "quarantined"
    assert len(rig.texts) == posts


def test_the_breaker_leaves_hosts_already_out_alone() -> None:
    rig = Rig([quarantine_decision("gpu-node-1")])
    rig.scan()
    rig.report("gpu-node-1", actuator_state="drained")
    rig.scan()
    # A burst of new decisions trips the breaker: they are held, node-1 is not.
    rig.decisions = [
        replace(quarantine_decision(f"gpu-node-{n}"), hardware=True)
        for n in (1, 2, 3, 4)
    ]
    rig.scan()
    stages = {
        e.subject_key: (e.details["stage"], e.details.get("held_reason"))
        for e in rig.store.open_episodes()
    }
    assert stages["gpu-node-1"] == ("quarantined", None)
    assert {stages[f"gpu-node-{n}"] for n in (2, 3, 4)} == {
        ("held", "detector_suspect")
    }
    # And node-1 still advances through its own sequence while they are held.
    rig.report(
        "gpu-node-1",
        stage="resolving",
        resolved_by="oncall",
        resolve_requested_at=at(rig),
        resolving_at=at(rig),
        actuator_state="returned",
    )
    rig.scan()
    assert "gpu-node-1" not in {e.subject_key for e in rig.store.open_episodes()}


def test_a_pause_that_landed_with_a_job_still_running_is_not_stuck() -> None:
    # 'out' every minute for two hours: the actuator is alive, the job is not
    # done. Only silence is flagged.
    rig = Rig()
    rig.scan()
    for _ in range(24):
        rig.report(actuator_state="out", actuator_state_at=at(rig))
        rig.scan()
    assert rig.details["stage"] == "quarantining"
    assert len(rig.texts) == 1


def plan_one(
    episode: InfraAlertEpisode, **kwargs: Any
) -> Any:
    return plan_quarantine(
        now=NOW,
        live=True,
        decisions=kwargs.pop("decisions", []),
        states=kwargs.pop("states", {}),
        open_episodes={("quarantine", HOST): episode},
        pool_sizes={"pool-a": 8},
        **kwargs,
    )


def test_a_quiet_scan_of_a_steady_episode_writes_no_state() -> None:
    plan = plan_one(quarantined("quarantined", None))
    assert plan.states == () and plan.stage_changes == ()


def test_a_fault_after_the_resolve_records_when_the_check_failed() -> None:
    plan = plan_one(
        quarantined("resolve_requested", None), faults={HOST: "still hung"}
    )
    [change] = plan.stage_changes
    assert change.patch["stage"] == "quarantined"
    assert change.patch["verify_failed_at"] == NOW.isoformat()
    assert change.patch["verify_note"] == "still hung"


def test_a_closed_dry_run_resets_its_absence_count_to_zero() -> None:
    episode = quarantined("would", None)
    state = InfraSubjectState("quarantine", HOST, details={"absent_scans": 1})
    plan = plan_one(episode, states={("quarantine", HOST): state})
    [change] = plan.stage_changes
    assert change.patch["resolution"] == "decision_cleared"
    [written] = plan.states
    assert written.details["absent_scans"] == 0
