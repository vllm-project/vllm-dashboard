"""Infra health scans through the scheduled-command seam."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from alerting.commands import ScheduledCommand
from alerting.fast_ci import ALERTS_SLACK_CHANNEL
from alerting.infra import (
    RETIREMENT_AGE,
    DiskMountObservation,
    GpuTemperatureObservation,
    HostReport,
    InfraAlertType,
    InfraScanHandler,
    InfraThreshold,
    KubectlNodesSource,
    UnionExpectedHostSource,
    slack_channel,
)
from alerting.memory import (
    FixedClock,
    InMemoryAutomationExecutionStore,
    InMemoryInfraStore,
    InMemoryOutboxStore,
    RecordingSlackPort,
)
from alerting.ports import DeliveryMode
from alerting.runtime import AlertingRuntime, ProcessStatus

START = datetime(2026, 9, 2, 10, 0, tzinfo=timezone.utc)


class FixtureHosts:
    def __init__(self, hosts: set[str] | None = None) -> None:
        self.hosts = hosts if hosts is not None else set()

    def expected_hosts(self) -> frozenset[str]:
        return frozenset(self.hosts)


class FixtureSnapshots:
    """In-memory gpu/host snapshot tables plus fleet thresholds."""

    def __init__(self) -> None:
        self.threshold_rows = [
            InfraThreshold(
                alert_type=InfraAlertType.UNREPORTING.value,
                threshold_value=10,
                threshold_unit="minutes",
                consecutive_scans=2,
                enabled=True,
            )
        ]
        self.gpu_reports: dict[str, datetime] = {}
        self.host_reports: dict[str, datetime] = {}
        self.disks: list[DiskMountObservation] = []
        self.temps: list[GpuTemperatureObservation] = []

    def infra_thresholds(self) -> list[InfraThreshold]:
        return list(self.threshold_rows)

    def latest_reports(self) -> list[HostReport]:
        merged = dict(self.host_reports)
        for hostname, reported_at in self.gpu_reports.items():
            merged[hostname] = max(reported_at, merged.get(hostname, reported_at))
        return [
            HostReport(hostname=hostname, reported_at=reported_at)
            for hostname, reported_at in merged.items()
        ]

    def recent_gpu_hosts(self, *, since: datetime) -> frozenset[str]:
        return frozenset(
            hostname
            for hostname, reported_at in self.gpu_reports.items()
            if reported_at >= since
        )

    def disk_mounts(self) -> list[DiskMountObservation]:
        return list(self.disks)

    def gpu_temperatures(self) -> list[GpuTemperatureObservation]:
        return list(self.temps)


def threshold(
    alert_type: InfraAlertType,
    value: float,
    unit: str,
    *,
    scans: int = 2,
    enabled: bool = True,
) -> InfraThreshold:
    return InfraThreshold(
        alert_type=alert_type.value,
        threshold_value=value,
        threshold_unit=unit,
        consecutive_scans=scans,
        enabled=enabled,
    )


def mount(
    hostname: str,
    device: str,
    *,
    fstype: str = "nfs4",
    role: str = "data",
    used_percent: float = 95.0,
    mount_point: str = "/data",
    error: str | None = None,
    reported_at: datetime = START,
) -> DiskMountObservation:
    total_bytes = 1000
    return DiskMountObservation(
        hostname=hostname,
        mount_point=mount_point,
        device=device,
        fstype=fstype,
        role=role,
        used_bytes=int(total_bytes * used_percent / 100),
        total_bytes=total_bytes,
        error=error,
        reported_at=reported_at,
    )


def runtime_for(
    hosts: FixtureHosts,
    snapshots: FixtureSnapshots,
    *,
    delivery_mode: DeliveryMode = DeliveryMode.LIVE,
) -> tuple[
    AlertingRuntime, InMemoryInfraStore, InMemoryOutboxStore, RecordingSlackPort, FixedClock
]:
    clock = FixedClock(START)
    executions = InMemoryAutomationExecutionStore()
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    store = InMemoryInfraStore(executions=executions, outbox=outbox)
    runtime = AlertingRuntime(
        executions=executions,
        outbox=outbox,
        slack=slack,
        clock=clock,
        handlers={
            "infra_scan": InfraScanHandler(
                hosts=hosts,
                snapshots=snapshots,
                store=store,
                clock=clock,
                delivery_mode=delivery_mode,
            )
        },
        alert_path=None,
    )
    return runtime, store, outbox, slack, clock


def scan(runtime: AlertingRuntime, target: datetime) -> None:
    result = runtime.process_command(
        ScheduledCommand(command_type="infra_scan", target_time=target)
    )
    assert result.status is ProcessStatus.COMPLETED


def test_episode_opens_on_second_consecutive_silent_scan_not_the_first() -> None:
    hosts = FixtureHosts({"gpu-h100-01"})
    snapshots = FixtureSnapshots()
    runtime, store, outbox, slack, _ = runtime_for(hosts, snapshots)

    scan(runtime, START)
    assert store.episodes() == []
    assert outbox.count() == 0
    state = store.subject_state("unreporting", "gpu-h100-01")
    assert state is not None
    assert state.consecutive_breaches == 1

    scan(runtime, START + timedelta(minutes=5))
    assert [episode.status for episode in store.episodes()] == ["open"]
    assert outbox.count() == 1

    runtime.dispatch_due_notifications()
    assert len(slack.deliveries) == 1
    text = slack.deliveries[0].payload["text"]
    assert "stopped reporting" in text
    assert "gpu-h100-01" in text
    assert "down" not in text.lower()


def test_first_fresh_report_resolves_episode_by_editing_the_open_message() -> None:
    hosts = FixtureHosts({"gpu-h100-01"})
    snapshots = FixtureSnapshots()
    runtime, store, outbox, slack, clock = runtime_for(hosts, snapshots)

    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()
    assert len(slack.deliveries) == 1

    clock.advance(minutes=5)
    snapshots.gpu_reports["gpu-h100-01"] = clock.now()
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()

    assert [episode.status for episode in store.episodes()] == ["resolved"]
    assert outbox.count() == 2
    # The resolve strikes through the bot's open alert instead of posting.
    assert len(slack.deliveries) == 1
    assert "stopped reporting" in slack.deliveries[0].payload["text"]
    assert len(slack.updates) == 1
    update_text = slack.updates[0]["payload"]["text"]
    assert update_text.startswith(":white_check_mark: ~")
    assert "stopped reporting" in update_text
    assert update_text.endswith("~ (edited)")


def test_reopened_episode_after_resolution_sends_a_new_pair() -> None:
    hosts = FixtureHosts({"gpu-h100-01"})
    snapshots = FixtureSnapshots()
    runtime, store, outbox, slack, clock = runtime_for(hosts, snapshots)

    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    clock.advance(minutes=5)
    snapshots.gpu_reports["gpu-h100-01"] = clock.now()
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()

    # The host goes silent again: two consecutive silent scans reopen it.
    clock.advance(minutes=15)
    scan(runtime, clock.now())
    assert outbox.count() == 2
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()

    assert [episode.status for episode in store.episodes()] == ["resolved", "open"]
    # The first resolve edited open #1 in place, so the reopen is delivery #2.
    assert len(slack.deliveries) == 2
    assert "stopped reporting" in slack.deliveries[1].payload["text"]


def test_absent_and_silent_host_is_auto_retired_after_seven_days() -> None:
    hosts = FixtureHosts({"h200-bare-1"})
    snapshots = FixtureSnapshots()
    # The host's last report is already a day old, so it goes silent fast.
    snapshots.gpu_reports["h200-bare-1"] = START - timedelta(days=1)
    runtime, store, outbox, slack, clock = runtime_for(hosts, snapshots)

    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()
    assert len(slack.deliveries) == 1
    assert [episode.status for episode in store.episodes()] == ["open"]

    # The host leaves the Kubernetes node list, but gpu_snapshots still saw
    # it within the last seven days, so it stays expected and unretired.
    hosts.hosts.clear()
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    state = store.subject_state("unreporting", "h200-bare-1")
    assert state is not None
    assert state.retired_at is None
    assert [episode.status for episode in store.episodes()] == ["open"]

    # Once the last report is seven days old the host is absent from every
    # expected source: it is retired and the open episode is resolved.
    retire_scan = START - timedelta(days=1) + RETIREMENT_AGE + timedelta(minutes=5)
    scan(runtime, retire_scan)
    state = store.subject_state("unreporting", "h200-bare-1")
    assert state is not None
    assert state.retired_at == retire_scan
    runtime.dispatch_due_notifications()

    assert [episode.status for episode in store.episodes()] == ["resolved"]
    assert outbox.count() == 2
    assert len(slack.deliveries) == 1
    assert len(slack.updates) == 1
    assert slack.updates[0]["payload"]["text"].endswith("~ (edited)")

    # Retired hosts stop alerting even while they stay absent and silent.
    scan(runtime, retire_scan + timedelta(minutes=5))
    scan(runtime, retire_scan + timedelta(minutes=10))
    assert outbox.count() == 2

    # A replacement node reusing the hostname rejoins the expected set and
    # alerts again from a clean consecutive-scan count.
    hosts.hosts.add("h200-bare-1")
    scan(runtime, retire_scan + timedelta(minutes=15))
    state = store.subject_state("unreporting", "h200-bare-1")
    assert state is not None
    assert state.retired_at is None
    assert state.consecutive_breaches == 1
    assert len(store.episodes()) == 1
    scan(runtime, retire_scan + timedelta(minutes=20))
    assert [episode.status for episode in store.episodes()] == ["resolved", "open"]


def test_disabled_unreporting_threshold_suppresses_episode_and_messages() -> None:
    hosts = FixtureHosts({"gpu-h100-01"})
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows[0] = InfraThreshold(
        alert_type=InfraAlertType.UNREPORTING.value,
        threshold_value=10,
        threshold_unit="minutes",
        consecutive_scans=2,
        enabled=False,
    )
    runtime, store, outbox, _, _ = runtime_for(hosts, snapshots)

    scan(runtime, START)
    scan(runtime, START + timedelta(minutes=5))

    assert store.episodes() == []
    assert outbox.count() == 0


def test_shadow_scan_persists_rendered_output_without_slack_delivery() -> None:
    hosts = FixtureHosts({"gpu-h100-01"})
    snapshots = FixtureSnapshots()
    runtime, store, outbox, slack, _ = runtime_for(
        hosts, snapshots, delivery_mode=DeliveryMode.SHADOW
    )

    scan(runtime, START)
    scan(runtime, START + timedelta(minutes=5))
    result = runtime.dispatch_due_notifications()

    assert [episode.status for episode in store.episodes()] == ["open"]
    assert outbox.count() == 1
    record = outbox.records()[0]
    assert record.delivery_mode is DeliveryMode.SHADOW
    assert "stopped reporting" in record.payload["text"]
    assert result.delivered == 0
    assert slack.deliveries == []


def test_failed_commit_rolls_back_state_episode_and_outbox_before_retry() -> None:
    hosts = FixtureHosts({"gpu-h100-01"})
    snapshots = FixtureSnapshots()
    runtime, store, outbox, _, _ = runtime_for(hosts, snapshots)

    scan(runtime, START)
    store.fail_next_commit()
    failed = runtime.process_command(
        ScheduledCommand(
            command_type="infra_scan", target_time=START + timedelta(minutes=5)
        )
    )
    assert failed.status is ProcessStatus.FAILED
    assert store.episodes() == []
    assert outbox.count() == 0
    state = store.subject_state("unreporting", "gpu-h100-01")
    assert state is not None
    assert state.consecutive_breaches == 1

    scan(runtime, START + timedelta(minutes=5))
    assert [episode.status for episode in store.episodes()] == ["open"]
    assert outbox.count() == 1


def test_shared_nfs_volume_pages_once_regardless_of_mounting_host_count() -> None:
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(
        threshold(InfraAlertType.DISK_USAGE, 90, "percent")
    )
    snapshots.disks = [
        mount("h200-ci-1", "nfs01:/exports/ci"),
        mount("h200-ci-2", "nfs01:/exports/ci"),
    ]
    runtime, store, outbox, slack, clock = runtime_for(FixtureHosts(), snapshots)

    scan(runtime, clock.now())
    assert store.episodes() == []

    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()

    episodes = store.episodes()
    assert [(episode.alert_type, episode.status) for episode in episodes] == [
        ("disk_usage", "open")
    ]
    assert episodes[0].subject_key == "disk:nfs4:nfs01:/exports/ci"
    assert outbox.count() == 1
    text = slack.deliveries[0].payload["text"]
    assert "nfs01:/exports/ci" in text
    assert "h200-ci-1" in text and "h200-ci-2" in text

    # One mounting host dropping below the threshold does not resolve the
    # shared episode while another host still breaches.
    snapshots.disks = [
        mount("h200-ci-1", "nfs01:/exports/ci", used_percent=50.0),
        mount("h200-ci-2", "nfs01:/exports/ci"),
    ]
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()
    assert [episode.status for episode in store.episodes()] == ["open"]
    assert outbox.count() == 1

    # The episode resolves only when every mount in the group is below.
    snapshots.disks = [
        mount("h200-ci-1", "nfs01:/exports/ci", used_percent=50.0),
        mount("h200-ci-2", "nfs01:/exports/ci", used_percent=40.0),
    ]
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()
    assert [episode.status for episode in store.episodes()] == ["resolved"]
    assert outbox.count() == 2
    assert slack.updates[0]["payload"]["text"].endswith("~ (edited)")


def test_other_role_and_errored_mounts_never_alert() -> None:
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(
        threshold(InfraAlertType.DISK_USAGE, 90, "percent")
    )
    snapshots.disks = [
        mount("h200-ci-1", "/dev/sdb1", fstype="ext4", role="other",
              used_percent=99.0, mount_point="/scratch"),
        mount("h200-ci-1", "nfs01:/exports/ci", used_percent=99.0,
              error="i/o error"),
    ]
    runtime, store, outbox, _, clock = runtime_for(FixtureHosts(), snapshots)

    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())

    assert store.episodes() == []
    assert outbox.count() == 0


def test_disabled_disk_threshold_suppresses_alerts() -> None:
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(
        threshold(InfraAlertType.DISK_USAGE, 90, "percent", enabled=False)
    )
    snapshots.disks = [mount("h200-ci-1", "nfs01:/exports/ci")]
    runtime, store, outbox, _, clock = runtime_for(FixtureHosts(), snapshots)

    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())

    assert store.episodes() == []
    assert outbox.count() == 0

    # Re-enabling the row resumes detection with a clean consecutive count.
    snapshots.threshold_rows[1] = threshold(InfraAlertType.DISK_USAGE, 90, "percent")
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    assert store.episodes() == []
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    assert [episode.status for episode in store.episodes()] == ["open"]


def test_gpu_temperature_requires_sustained_breach_across_scans() -> None:
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(
        threshold(InfraAlertType.GPU_TEMPERATURE, 85, "celsius")
    )
    snapshots.temps = [
        GpuTemperatureObservation(
            hostname="gpu-h100-01",
            gpu_index=3,
            temperature_c=92.0,
            reported_at=START,
        )
    ]
    runtime, store, outbox, slack, clock = runtime_for(FixtureHosts(), snapshots)

    scan(runtime, clock.now())
    assert store.episodes() == []
    assert outbox.count() == 0

    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()

    [episode] = store.episodes()
    assert episode.alert_type == "gpu_temperature"
    assert episode.subject_key == "gpu:gpu-h100-01:3"
    assert episode.status == "open"
    text = slack.deliveries[0].payload["text"]
    assert "GPU 3" in text
    assert "gpu-h100-01" in text
    assert "92.0°C" in text

    snapshots.temps = [
        GpuTemperatureObservation(
            hostname="gpu-h100-01",
            gpu_index=3,
            temperature_c=70.0,
            reported_at=clock.now(),
        )
    ]
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()

    assert [episode.status for episode in store.episodes()] == ["resolved"]
    assert outbox.count() == 2
    assert slack.updates[0]["payload"]["text"].endswith("~ (edited)")


class _FakeCompletedProcess:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_kubectl_source_lowercases_node_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: list[list[str]] = []

    def fake_run(cmd: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        commands.append(cmd)
        return _FakeCompletedProcess(
            0,
            stdout=json.dumps(
                {
                    "items": [
                        {"metadata": {"name": "GPU-H100-01"}},
                        {"metadata": {"name": "dgx-h100-02"}},
                        {"metadata": {}},
                    ]
                }
            ),
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    source = KubectlNodesSource(kubeconfig="/run/alerting/h100.conf")
    assert source.expected_hosts() == frozenset({"gpu-h100-01", "dgx-h100-02"})
    assert commands == [
        [
            "kubectl",
            "--kubeconfig",
            "/run/alerting/h100.conf",
            "get",
            "nodes",
            "-o",
            "json",
        ]
    ]


def test_kubectl_source_fails_closed_on_kubectl_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: _FakeCompletedProcess(1, stderr="forbidden"),
    )

    source = KubectlNodesSource(kubeconfig="/run/alerting/h100.conf")
    with pytest.raises(RuntimeError, match="kubectl get nodes failed"):
        source.expected_hosts()


def test_expected_host_set_is_the_union_of_sources() -> None:
    source = UnionExpectedHostSource(
        [FixtureHosts({"GPU-H100-01"}), FixtureHosts({"h200-ci-1"})]
    )

    assert source.expected_hosts() == frozenset({"gpu-h100-01", "h200-ci-1"})


def test_infra_alerts_post_to_the_infra_channel_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SLACK_CI_INFRA_ALERT_CHANNEL", raising=False)
    assert slack_channel() == ALERTS_SLACK_CHANNEL

    monkeypatch.setenv("SLACK_CI_INFRA_ALERT_CHANNEL", "C-INFRA-1")
    assert slack_channel() == "C-INFRA-1"
