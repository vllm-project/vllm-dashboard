"""Infra health scans through the scheduled-command seam."""

from __future__ import annotations

import json
import pathlib
import subprocess
from collections.abc import Iterable
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from alerting.commands import ScheduledCommand
from alerting.infra import (
    InfraAlertEpisode,
    _render_quarantine,
    RETIREMENT_AGE,
    DiskMountObservation,
    GpuCountObservation,
    GpuDeadMemoryObservation,
    GpuFaultObservation,
    GpuTemperatureObservation,
    HostFaultObservation,
    HostReport,
    InfraAlertType,
    InfraScanHandler,
    InfraThreshold,
    KubectlNodesSource,
    QuarantineDecision,
    UnionExpectedHostSource,
    XidEvent,
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
        self.dead_mem: list[GpuDeadMemoryObservation] = []
        self.gpu_totals: list[GpuCountObservation] = []
        self.faults: list[GpuFaultObservation] = []
        self.host_fault_rows: list[HostFaultObservation] = []
        self.xids: list[XidEvent] = []
        self.agents: list[tuple[str, str]] = []

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

    def gpu_dead_memory(self) -> list[GpuDeadMemoryObservation]:
        return list(self.dead_mem)

    def gpu_counts(self) -> list[GpuCountObservation]:
        return list(self.gpu_totals)

    def gpu_faults(self) -> list[GpuFaultObservation]:
        return list(self.faults)

    def host_faults(self) -> list[HostFaultObservation]:
        return list(self.host_fault_rows)

    def xid_events(
        self, *, hostnames: Iterable[str], since: datetime
    ) -> list[XidEvent]:
        wanted = set(hostnames)
        return [e for e in self.xids if e.hostname in wanted and e.at >= since]

    def agent_queues(self) -> list[tuple[str, str]]:
        return list(self.agents)


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
    assert update_text.endswith("~") and "(edited)" not in update_text
    # The shared alert channel tells posts apart by their header block.
    assert slack.deliveries[0].payload["blocks"][0]["text"]["text"] == (
        "🖥️ INFRA · host gpu-h100-01 stopped reporting"
    )
    assert slack.updates[0]["payload"]["blocks"][0]["text"]["text"] == (
        "✅ INFRA · Resolved: host gpu-h100-01 stopped reporting"
    )


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
    assert slack.updates[0]["payload"]["text"].endswith("~")

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
    assert slack.updates[0]["payload"]["text"].endswith("~")


def test_local_disks_with_the_same_device_name_page_per_host() -> None:
    # Live failure: every mithril host's root is ext4 /dev/vda1. Grouped by
    # (fstype, device) they shared one episode, so a second host filling up
    # while the first was still open never paged.
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(
        threshold(InfraAlertType.DISK_USAGE, 90, "percent")
    )
    snapshots.disks = [
        mount("mithril-h200-1", "/dev/vda1", fstype="ext4", role="system",
              mount_point="/"),
        mount("mithril-h200-2", "/dev/vda1", fstype="ext4", role="system",
              used_percent=40.0, mount_point="/"),
    ]
    runtime, store, outbox, _, clock = runtime_for(FixtureHosts(), snapshots)

    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    assert [episode.subject_key for episode in store.episodes()] == [
        "disk:mithril-h200-1:ext4:/dev/vda1"
    ]

    # The second host filling opens its own episode while the first is open.
    snapshots.disks[1] = mount("mithril-h200-2", "/dev/vda1", fstype="ext4",
                               role="system", mount_point="/")
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    assert sorted(
        (episode.subject_key, episode.status) for episode in store.episodes()
    ) == [
        ("disk:mithril-h200-1:ext4:/dev/vda1", "open"),
        ("disk:mithril-h200-2:ext4:/dev/vda1", "open"),
    ]
    assert outbox.count() == 2


def test_other_role_mounts_alert() -> None:
    # Live failure: /mnt/local on the mithril hosts was missing from the
    # reporter's role map, so it reported as 'other' and filled silently.
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(
        threshold(InfraAlertType.DISK_USAGE, 90, "percent")
    )
    snapshots.disks = [
        mount("mithril-h200-1", "/dev/vdc", fstype="ext4", role="other",
              used_percent=99.0, mount_point="/mnt/local"),
    ]
    runtime, store, _, _, clock = runtime_for(FixtureHosts(), snapshots)

    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())

    assert [episode.subject_key for episode in store.episodes()] == [
        "disk:mithril-h200-1:ext4:/dev/vdc"
    ]


def test_errored_mounts_never_alert() -> None:
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(
        threshold(InfraAlertType.DISK_USAGE, 90, "percent")
    )
    snapshots.disks = [
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
    assert slack.updates[0]["payload"]["text"].endswith("~")


def dead_mem_reading(
    hostname: str,
    gpu_index: int,
    dead_proc_mem_mb: float,
    reported_at: datetime = START,
) -> GpuDeadMemoryObservation:
    return GpuDeadMemoryObservation(
        hostname=hostname,
        gpu_index=gpu_index,
        dead_proc_mem_mb=dead_proc_mem_mb,
        reported_at=reported_at,
    )


def test_gpu_dead_memory_requires_sustained_breach_across_scans() -> None:
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(
        threshold(InfraAlertType.GPU_DEAD_MEMORY, 4096, "mib")
    )
    snapshots.dead_mem = [dead_mem_reading("h200-ci-5", 3, 6144.0)]
    runtime, store, outbox, slack, clock = runtime_for(FixtureHosts(), snapshots)

    scan(runtime, clock.now())
    assert store.episodes() == []
    assert outbox.count() == 0

    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()

    [episode] = store.episodes()
    assert episode.alert_type == "gpu_dead_memory"
    assert episode.subject_key == "gpu-dead-mem:h200-ci-5:3"
    assert episode.status == "open"
    text = slack.deliveries[0].payload["text"]
    assert "GPU 3" in text
    assert "h200-ci-5" in text
    assert "6144.0 MiB held by dead processes" in text

    snapshots.dead_mem = [
        dead_mem_reading("h200-ci-5", 3, 512.0, reported_at=clock.now())
    ]
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()

    assert [episode.status for episode in store.episodes()] == ["resolved"]
    assert outbox.count() == 2
    assert slack.updates[0]["payload"]["text"].endswith("~")


def test_gpu_dead_memory_without_readings_never_alerts() -> None:
    # Hosts that cannot collect dead_proc_mem_mb report null rows, which the
    # snapshot query filters out; the planner then sees no subject to alert on.
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(
        threshold(InfraAlertType.GPU_DEAD_MEMORY, 4096, "mib")
    )
    runtime, store, outbox, _, clock = runtime_for(FixtureHosts(), snapshots)

    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())

    assert store.episodes() == []
    assert outbox.count() == 0


def test_disabled_gpu_dead_memory_threshold_suppresses_alerts() -> None:
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(
        threshold(InfraAlertType.GPU_DEAD_MEMORY, 4096, "mib", enabled=False)
    )
    snapshots.dead_mem = [dead_mem_reading("h200-ci-5", 0, 8192.0)]
    runtime, store, outbox, _, clock = runtime_for(FixtureHosts(), snapshots)

    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())

    assert store.episodes() == []
    assert outbox.count() == 0


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


def gpu_count_reading(
    hostname: str,
    observed_gpus: int,
    reported_at: datetime = START,
) -> GpuCountObservation:
    return GpuCountObservation(
        hostname=hostname,
        observed_gpus=observed_gpus,
        reported_at=reported_at,
    )


def test_gpu_count_alerts_when_a_gpu_stops_reporting() -> None:
    # A GPU can drop out while the host stays Ready with no pressure
    # condition, so every other infra check passes and the shortfall is
    # invisible. This is the case the alert exists for.
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(threshold(InfraAlertType.GPU_COUNT, 1, "gpus"))
    snapshots.gpu_totals = [gpu_count_reading("gpu-node-01", 8)]
    runtime, store, outbox, slack, clock = runtime_for(FixtureHosts(), snapshots)

    # First scan only records the baseline; a full fleet must never alert.
    scan(runtime, clock.now())
    assert store.episodes() == []

    snapshots.gpu_totals = [
        gpu_count_reading("gpu-node-01", 7, reported_at=clock.now())
    ]
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    assert store.episodes() == [], "one breaching scan must not open an episode"

    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()

    [episode] = store.episodes()
    assert episode.alert_type == "gpu_count"
    assert episode.subject_key == "gpu-count:gpu-node-01"
    assert episode.status == "open"
    text = slack.deliveries[0].payload["text"]
    assert "gpu-node-01" in text
    assert "7 of 8 GPUs" in text

    snapshots.gpu_totals = [
        gpu_count_reading("gpu-node-01", 8, reported_at=clock.now())
    ]
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()

    assert [episode.status for episode in store.episodes()] == ["resolved"]
    assert slack.updates[0]["payload"]["text"].endswith("~")


def test_gpu_count_baseline_never_decays_while_a_gpu_stays_missing() -> None:
    # The baseline is carried in durable state precisely so a long outage
    # cannot be absorbed into a rolling window and silently self-resolve.
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(threshold(InfraAlertType.GPU_COUNT, 1, "gpus"))
    snapshots.gpu_totals = [gpu_count_reading("gpu-node-01", 8)]
    runtime, store, outbox, _, clock = runtime_for(FixtureHosts(), snapshots)
    scan(runtime, clock.now())

    snapshots.gpu_totals = [
        gpu_count_reading("gpu-node-01", 7, reported_at=clock.now())
    ]
    for _ in range(12):
        clock.advance(minutes=5)
        scan(runtime, clock.now())

    [episode] = store.episodes()
    assert episode.status == "open", "episode must stay open while a GPU is absent"
    assert episode.details["baseline_gpus"] == 8


def test_gpu_count_first_sighting_of_a_short_host_never_alerts() -> None:
    # A host whose first ever report shows 7 GPUs has no baseline to fall
    # below, so it must not alert; the baseline ratchets up from what it
    # reports, never down.
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(threshold(InfraAlertType.GPU_COUNT, 1, "gpus"))
    snapshots.gpu_totals = [gpu_count_reading("gpu-node-02", 7)]
    runtime, store, outbox, _, clock = runtime_for(FixtureHosts(), snapshots)

    for _ in range(3):
        scan(runtime, clock.now())
        clock.advance(minutes=5)

    assert store.episodes() == []
    assert outbox.count() == 0


def test_gpu_count_added_capacity_raises_the_baseline() -> None:
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(threshold(InfraAlertType.GPU_COUNT, 1, "gpus"))
    snapshots.gpu_totals = [gpu_count_reading("gpu-node-03", 4)]
    runtime, store, outbox, _, clock = runtime_for(FixtureHosts(), snapshots)
    scan(runtime, clock.now())

    snapshots.gpu_totals = [gpu_count_reading("gpu-node-03", 8, reported_at=clock.now())]
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())

    assert store.episodes() == []
    snapshots.gpu_totals = [gpu_count_reading("gpu-node-03", 7, reported_at=clock.now())]
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())

    [episode] = store.episodes()
    assert episode.details["baseline_gpus"] == 8
    assert episode.details["missing_gpus"] == 1


def test_disabled_gpu_count_threshold_suppresses_alerts() -> None:
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows.append(
        threshold(InfraAlertType.GPU_COUNT, 1, "gpus", enabled=False)
    )
    snapshots.gpu_totals = [gpu_count_reading("gpu-node-01", 8)]
    runtime, store, outbox, _, clock = runtime_for(FixtureHosts(), snapshots)
    scan(runtime, clock.now())
    snapshots.gpu_totals = [
        gpu_count_reading("gpu-node-01", 7, reported_at=clock.now())
    ]
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    clock.advance(minutes=5)
    scan(runtime, clock.now())

    assert store.episodes() == []
    assert outbox.count() == 0


def _newest_migration_defining(constraint: str) -> str:
    # Constraints are replaced with DROP + ADD, so the highest-numbered
    # migration that mentions one is the definition in force.
    root = pathlib.Path(__file__).resolve().parents[2] / "migrations" / "sql"
    files = sorted(path for path in root.glob("*.sql") if constraint in path.read_text())
    assert files, f"no migration defines {constraint}"
    return files[-1].read_text()


@pytest.mark.parametrize(
    "constraint",
    [
        "alerting_infra_host_states_alert_type_check",
        "alerting_infra_alerts_alert_type_check",
        "alert_thresholds_check",
    ],
)
def test_every_alert_type_is_permitted_by_the_sql_constraints(constraint: str) -> None:
    # Migration 0023 added an alert type to alert_thresholds but missed the two
    # infra tables. The first scan after that deploy failed on the host-states
    # constraint and infra alerting stopped reconciling until 0024 was
    # hand-applied. A new InfraAlertType that no migration permits is the same
    # outage, so fail here instead of in production.
    sql = _newest_migration_defining(constraint)
    missing = [
        alert_type.value
        for alert_type in InfraAlertType
        if f"'{alert_type.value}'" not in sql
        # Quarantine has no threshold row: trigger rules decide, not a value.
        and not (
            alert_type is InfraAlertType.QUARANTINE
            and constraint == "alert_thresholds_check"
        )
    ]
    assert not missing, (
        f"{constraint} does not permit {missing}; widen it in a new migration"
    )


def quarantine_runtime(
    decisions: list[QuarantineDecision],
    *,
    live: bool = False,
    operator_destination: str | None = None,
) -> tuple[AlertingRuntime, InMemoryInfraStore, RecordingSlackPort, FixedClock]:
    clock = FixedClock(START)
    executions = InMemoryAutomationExecutionStore()
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    store = InMemoryInfraStore(executions=executions, outbox=outbox)
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows = []
    # A pool of eight: the safety limits allow two out at once.
    snapshots.agents = [(f"gpu-node-{n}", "h200_35gb") for n in range(1, 9)]
    runtime = AlertingRuntime(
        executions=executions,
        outbox=outbox,
        slack=slack,
        clock=clock,
        handlers={
            "infra_scan": InfraScanHandler(
                hosts=FixtureHosts(),
                snapshots=snapshots,
                store=store,
                clock=clock,
                quarantine_decisions=lambda: list(decisions),
                quarantine_live=live,
                operator_destination=operator_destination,
            )
        },
        alert_path=None,
    )
    return runtime, store, slack, clock


def test_a_tripped_breaker_also_reaches_the_operator() -> None:
    # Hardware faults skip the pool cap, so the breaker is what stops four.
    decisions = [
        replace(quarantine_decision(f"gpu-node-{n}"), hardware=True)
        for n in range(1, 5)
    ]
    runtime, store, slack, clock = quarantine_runtime(
        decisions, live=True, operator_destination="UOPS"
    )
    scan_and_post(runtime, clock)
    channel, operator = slack.deliveries
    assert operator.destination == "UOPS"
    assert operator.payload == channel.payload
    assert "detector suspect" in operator.payload["text"]


def quarantine_decision(host: str = "GPU-Node-7") -> QuarantineDecision:
    return QuarantineDecision(
        host=host,
        cluster="h200",
        pool="h200_35gb",
        reason="Xid 79: GPU fell off the bus",
        evidence={"xid": 79, "gpu": 3},
    )


def scan_and_post(runtime: AlertingRuntime, clock: FixedClock) -> None:
    clock.advance(minutes=5)
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()


def test_live_quarantine_runs_the_whole_sequence_on_actuator_reports() -> None:
    decisions = [quarantine_decision()]
    runtime, store, slack, clock = quarantine_runtime(decisions, live=True)

    scan_and_post(runtime, clock)
    [episode] = store.open_episodes()
    assert episode.subject_key == "gpu-node-7"
    assert episode.details["stage"] == "quarantining"
    assert episode.details["cluster"] == "h200"
    assert episode.details["evidence"] == {"xid": 79, "gpu": 3}
    assert "commanded_at" in episode.details
    assert slack.deliveries[-1].payload["text"].endswith(
        "will be quarantined once its running jobs finish: "
        "Xid 79: GPU fell off the bus"
    )

    # 'out' is not enough: running jobs are still finishing.
    store.update_details("quarantine", "gpu-node-7", actuator_state="out")
    scan_and_post(runtime, clock)
    assert store.open_episodes()[0].details["stage"] == "quarantining"
    assert len(slack.deliveries) == 1

    store.update_details("quarantine", "gpu-node-7", actuator_state="drained")
    scan_and_post(runtime, clock)
    assert store.open_episodes()[0].details["stage"] == "quarantined"
    assert "is quarantined" in slack.deliveries[-1].payload["text"]

    # The decision going away never returns a live quarantine.
    decisions.clear()
    for _ in range(3):
        scan_and_post(runtime, clock)
    assert store.open_episodes()[0].details["stage"] == "quarantined"
    assert len(slack.deliveries) == 2

    # The operator resolve endpoint moves it to resolving; it stays there
    # until the actuator reports 'returned'.
    store.update_details(
        "quarantine",
        "gpu-node-7",
        stage="resolving",
        resolved_by="oncall",
        resolve_requested_at=clock.now().isoformat(),
    )
    scan_and_post(runtime, clock)
    assert store.open_episodes()[0].details["stage"] == "resolving"

    store.update_details(
        "quarantine",
        "gpu-node-7",
        actuator_state="returned",
        actuator_observed={
            "cordoned": True,
            "note": "a pre-existing cordon was left in place",
        },
    )
    scan_and_post(runtime, clock)
    assert store.open_episodes() == []
    [closed] = store.episodes()
    assert closed.status == "resolved"
    assert closed.details["stage"] == "resolved"
    assert slack.deliveries[-1].payload["text"].endswith(
        "is back in service (resolved by oncall); "
        "a pre-existing cordon was left in place"
    )
    assert len(slack.deliveries) == 3


def test_dry_run_quarantine_posts_would_and_expires_silently() -> None:
    decisions = [quarantine_decision()]
    runtime, store, slack, clock = quarantine_runtime(decisions)

    scan_and_post(runtime, clock)
    assert store.open_episodes()[0].details["stage"] == "would"
    assert slack.deliveries[-1].payload["text"].endswith(
        "would quarantine `gpu-node-7`: Xid 79: GPU fell off the bus"
    )
    assert slack.deliveries[-1].payload["blocks"] == [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": "🚧 QUARANTINE · would quarantine gpu-node-7:"
                " Xid 79: GPU fell off the bus",
                "emoji": True,
            },
        }
    ]

    # One missed scan, then the decision is back: the count starts over.
    decisions.clear()
    scan_and_post(runtime, clock)
    decisions.append(quarantine_decision())
    scan_and_post(runtime, clock)
    decisions.clear()
    scan_and_post(runtime, clock)
    assert store.open_episodes()[0].details["stage"] == "would"

    scan_and_post(runtime, clock)
    assert store.open_episodes() == []
    [closed] = store.episodes()
    assert closed.details["stage"] == "resolved"
    assert closed.details["resolution"] == "decision_cleared"
    assert len(slack.deliveries) == 1

    # A new decision after expiry opens a fresh dry-run episode.
    decisions.append(quarantine_decision())
    scan_and_post(runtime, clock)
    assert [episode.status for episode in store.episodes()] == ["resolved", "open"]


def test_switching_to_live_upgrades_a_standing_dry_run_episode() -> None:
    decisions = [quarantine_decision()]
    runtime, store, slack, clock = quarantine_runtime(decisions)
    scan_and_post(runtime, clock)

    handler = runtime._handlers["infra_scan"]
    handler._quarantine_live = True  # type: ignore[attr-defined]
    scan_and_post(runtime, clock)

    [episode] = store.open_episodes()
    assert episode.details["stage"] == "quarantining"
    assert "will be quarantined" in slack.deliveries[-1].payload["text"]


def test_stage_change_is_skipped_when_the_stage_moved_since_the_read() -> None:
    decisions = [quarantine_decision()]
    runtime, store, slack, clock = quarantine_runtime(decisions, live=True)
    scan_and_post(runtime, clock)
    store.update_details("quarantine", "gpu-node-7", actuator_state="drained")

    # An operator resolves between the scan's read and its commit.
    real_state = store.infra_state

    def racing_read() -> Any:
        snapshot = real_state()
        store.update_details("quarantine", "gpu-node-7", stage="resolving")
        return snapshot

    store.infra_state = racing_read  # type: ignore[method-assign]
    scan_and_post(runtime, clock)

    assert store.open_episodes()[0].details["stage"] == "resolving"
    assert len(slack.deliveries) == 1


@pytest.mark.parametrize("stage", ["would", "quarantining", "quarantined", "resolved"])
def test_quarantine_posts_never_say_how_to_resolve(stage: str) -> None:
    # The infra channel is public; resolving is for the operator token holders.
    text = _render_quarantine(
        InfraAlertEpisode(
            alert_type="quarantine",
            subject_key="gpu-node-7",
            opened_at=START,
            details={"stage": stage, "reason": "Xid 79", "resolved_by": "oncall"},
        )
    ).lower()
    for hint in ("/api/", "bearer", "token", "curl", "/resolve"):
        assert hint not in text


def test_actuator_not_confirming_posts_once_per_stage() -> None:
    decisions = [quarantine_decision()]
    runtime, store, slack, clock = quarantine_runtime(decisions, live=True)
    scan_and_post(runtime, clock)  # quarantining, no 'out' yet
    scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 1

    scan_and_post(runtime, clock)  # 10 min after the command
    assert "has not confirmed taking out `gpu-node-7`" in (
        slack.deliveries[-1].payload["text"]
    )
    for _ in range(3):
        scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 2
    assert store.open_episodes()[0].details["stage"] == "quarantining"

    # A late 'drained' still advances, and resolve gets its own timer.
    store.update_details("quarantine", "gpu-node-7", actuator_state="drained")
    scan_and_post(runtime, clock)
    assert store.open_episodes()[0].details["stage"] == "quarantined"
    store.update_details(
        "quarantine",
        "gpu-node-7",
        stage="resolving",
        resolved_by="oncall",
        resolve_requested_at=clock.now().isoformat(),
    )
    scan_and_post(runtime, clock)
    scan_and_post(runtime, clock)
    assert "has not confirmed returning" in slack.deliveries[-1].payload["text"]
    assert len(slack.deliveries) == 4
    for _ in range(3):
        scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 4


def test_a_failed_return_check_sends_a_resolve_back_to_quarantined() -> None:
    decisions = [quarantine_decision()]
    runtime, store, slack, clock = quarantine_runtime(decisions, live=True)
    scan_and_post(runtime, clock)
    store.update_details("quarantine", "gpu-node-7", actuator_state="drained")
    scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 2

    def resolve() -> None:
        store.update_details(
            "quarantine",
            "gpu-node-7",
            stage="resolving",
            resolved_by="oncall",
            resolve_requested_at=clock.now().isoformat(),
            # What the resolve endpoint clears.
            actuator_state=None,
            verify_note=None,
        )

    def fail_check() -> str:
        store.update_details(
            "quarantine",
            "gpu-node-7",
            actuator_state="verify_failed",
            actuator_observed={"note": "| Memory | Fail - GPU 3 |"},
        )
        scan_and_post(runtime, clock)
        assert store.open_episodes()[0].details["stage"] == "quarantined"
        delivery = slack.deliveries[-1]
        assert delivery.delivery_id.endswith(
            f":quarantined:verify_failed:{clock.now().isoformat()}"
        )
        return str(delivery.payload["text"])

    def stuck_after_two_scans() -> None:
        before = len(slack.deliveries)
        scan_and_post(runtime, clock)
        scan_and_post(runtime, clock)
        assert len(slack.deliveries) == before + 1
        delivery = slack.deliveries[-1]
        assert "has not confirmed returning" in delivery.payload["text"]
        assert delivery.delivery_id.endswith(
            f":resolving:actuator_stuck:{clock.now().isoformat()}"
        )

    # A check that keeps reporting past the confirm timeout is not stuck; one
    # whose reports stop is.
    resolve()
    for _ in range(4):
        store.update_details(
            "quarantine",
            "gpu-node-7",
            actuator_state="verifying",
            actuator_state_at=clock.now().isoformat(),
        )
        scan_and_post(runtime, clock)
    assert store.open_episodes()[0].details["stage"] == "resolving"
    assert len(slack.deliveries) == 2
    scan_and_post(runtime, clock)  # 10 min since the last 'verifying'
    assert len(slack.deliveries) == 3
    assert "has not confirmed returning" in slack.deliveries[-1].payload["text"]

    assert fail_check() == (
        ":x: *Quarantine* — `gpu-node-7` failed its return check and stays "
        "quarantined: | Memory | Fail - GPU 3 |\n"
        "Runbook: to be linked before quarantine goes live."
    )
    [episode] = store.open_episodes()
    assert episode.details["verify_note"] == "| Memory | Fail - GPU 3 |"
    assert episode.details["verify_check"] == "return_check"
    assert episode.details["verify_failed_at"] == clock.now().isoformat()
    scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 4

    # Each later resolve gets its own confirm timer and failure post.
    resolve()
    stuck_after_two_scans()
    fail_check()
    resolve()
    stuck_after_two_scans()
    store.update_details("quarantine", "gpu-node-7", actuator_state="returned")
    scan_and_post(runtime, clock)
    assert store.open_episodes() == []


@pytest.mark.parametrize("forced", [False, True])
def test_a_resolve_waiting_on_ci_jobs_names_them_once_after_an_hour(
    forced: bool,
) -> None:
    decisions = [quarantine_decision()]
    runtime, store, slack, clock = quarantine_runtime(decisions, live=True)
    scan_and_post(runtime, clock)
    store.update_details("quarantine", "gpu-node-7", actuator_state="drained")
    scan_and_post(runtime, clock)
    # The hour runs from the clean reading, or from the request when a person
    # skipped the reading check.
    requested = clock.now() - (timedelta(0) if forced else timedelta(minutes=30))
    store.update_details(
        "quarantine",
        "gpu-node-7",
        stage="resolving",
        resolved_by="oncall",
        resolve_requested_at=requested.isoformat(),
        resolving_at=None if forced else clock.now().isoformat(),
    )
    note = "waiting for 1 CI job(s) to finish: https://buildkite.com/vllm/ci/builds/1#j"

    def waiting() -> None:
        store.update_details(
            "quarantine",
            "gpu-node-7",
            actuator_state="out",
            actuator_state_at=clock.now().isoformat(),
            actuator_observed={"ciPods": 1, "note": note},
        )
        scan_and_post(runtime, clock)

    # The actuator reports the wait every run, so it isn't stuck at 10 min.
    for _ in range(11):
        waiting()
    assert len(slack.deliveries) == 2
    waiting()  # an hour since the resolve
    assert len(slack.deliveries) == 3
    assert slack.deliveries[-1].payload["text"] == (
        ":hourglass: *Quarantine* — `gpu-node-7` has waited 60 min for CI jobs "
        "still on it to finish before its return check, so it stays out: "
        f"{note}"
    )
    for _ in range(3):
        waiting()
    assert len(slack.deliveries) == 3
    assert store.open_episodes()[0].details["stage"] == "resolving"
    # The notice doesn't mute the stuck alert: reports that stop still post.
    scan_and_post(runtime, clock)
    scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 4
    assert "has not confirmed returning" in slack.deliveries[-1].payload["text"]

    # After a failed check, the next resolve gets its own notice.
    store.update_details(
        "quarantine",
        "gpu-node-7",
        actuator_state="verify_failed",
        actuator_observed={"note": "diag failed"},
    )
    scan_and_post(runtime, clock)
    assert store.open_episodes()[0].details["stage"] == "quarantined"
    store.update_details(
        "quarantine",
        "gpu-node-7",
        stage="resolving",
        resolve_requested_at=clock.now().isoformat(),
        resolving_at=clock.now().isoformat(),
        actuator_state=None,
    )
    for _ in range(12):
        waiting()
    assert len(slack.deliveries) == 6
    assert slack.deliveries[-1].payload["text"].startswith(":hourglass:")


def test_a_verified_h200_host_is_timed_from_its_check_not_its_resolve() -> None:
    # The H200 host check can run past 10 minutes; its "verified" starts the
    # pauser's confirm timer.
    decisions = [quarantine_decision()]
    runtime, store, slack, clock = quarantine_runtime(decisions, live=True)
    scan_and_post(runtime, clock)
    store.update_details("quarantine", "gpu-node-7", actuator_state="drained")
    scan_and_post(runtime, clock)
    store.update_details(
        "quarantine",
        "gpu-node-7",
        stage="resolving",
        resolved_by="oncall",
        resolve_requested_at=(clock.now() - timedelta(minutes=60)).isoformat(),
        resolving_at=(clock.now() - timedelta(minutes=50)).isoformat(),
        actuator_state="verified",
        actuator_state_at=clock.now().isoformat(),
    )
    scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 2
    scan_and_post(runtime, clock)  # 10 min since "verified", still not returned
    assert len(slack.deliveries) == 3
    assert "has not confirmed returning" in slack.deliveries[-1].payload["text"]


def test_a_resolve_waiting_on_ci_jobs_whose_reports_stop_is_stuck() -> None:
    decisions = [quarantine_decision()]
    runtime, store, slack, clock = quarantine_runtime(decisions, live=True)
    scan_and_post(runtime, clock)
    store.update_details("quarantine", "gpu-node-7", actuator_state="drained")
    scan_and_post(runtime, clock)
    store.update_details(
        "quarantine",
        "gpu-node-7",
        stage="resolving",
        resolved_by="oncall",
        resolve_requested_at=clock.now().isoformat(),
        resolving_at=clock.now().isoformat(),
        actuator_state="out",
        actuator_state_at=clock.now().isoformat(),
        actuator_observed={"ciPods": 1, "note": "waiting"},
    )
    scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 2
    scan_and_post(runtime, clock)  # 10 min since its last report
    assert len(slack.deliveries) == 3
    assert "has not confirmed returning" in slack.deliveries[-1].payload["text"]
    # An actuator that recovers still gets its CI wait named, at the hour.
    for _ in range(10):
        store.update_details(
            "quarantine",
            "gpu-node-7",
            actuator_state="out",
            actuator_state_at=clock.now().isoformat(),
        )
        scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 4
    assert slack.deliveries[-1].payload["text"].startswith(":hourglass:")


def test_a_resolve_waits_for_a_clean_reading_before_the_host_returns() -> None:
    # The job-failure style decision stands throughout: only fresh readings
    # gate the return, since a quarantined host runs no jobs to clear it.
    decisions = [quarantine_decision()]
    runtime, store, slack, clock = quarantine_runtime(decisions, live=True)
    snapshots = runtime._handlers["infra_scan"]._snapshots  # type: ignore[attr-defined]
    scan_and_post(runtime, clock)
    store.update_details("quarantine", "gpu-node-7", actuator_state="drained")
    scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 2

    def request_resolve() -> None:
        store.update_details(
            "quarantine",
            "gpu-node-7",
            stage="resolve_requested",
            resolved_by="oncall",
            resolve_requested_at=clock.now().isoformat(),
        )

    def scan_with(
        recovery_action: str | None, hung: bool | None = False
    ) -> dict[str, Any]:
        clock.advance(minutes=5)
        snapshots.faults = (
            []
            if recovery_action is None
            else [
                GpuFaultObservation(
                    "gpu-node-7", 3, recovery_action, False, clock.now()
                )
            ]
        )
        snapshots.host_fault_rows = [
            HostFaultObservation("gpu-node-7", hung, None, None, clock.now())
        ]
        scan(runtime, clock.now())
        runtime.dispatch_due_notifications()
        return store.open_episodes()[0].details

    # No fresh reading yet: it waits, still out.
    request_resolve()
    assert scan_with(None)["stage"] == "resolve_requested"
    assert len(slack.deliveries) == 2

    # A reading whose GPU query didn't answer proves nothing: it waits.
    request_resolve()
    assert scan_with("None", hung=None)["stage"] == "resolve_requested"

    # The fault is still there: back to quarantined, and the post says why.
    details = scan_with("Reset")
    assert details["stage"] == "quarantined"
    assert details["verify_note"] == "the driver asks for recovery (Reset) on GPU 3"
    assert details["verify_check"] == "reading"
    assert slack.deliveries[-1].payload["text"].startswith(
        ":x: *Quarantine* — `gpu-node-7` still reports a fault after its resolve "
        "and stays quarantined: the driver asks for recovery (Reset)"
    )
    assert slack.deliveries[-1].delivery_id.endswith(
        f":quarantined:verify_failed:{clock.now().isoformat()}"
    )
    assert len(slack.deliveries) == 3

    # One hung GPU query after the resolve is enough; no two-scan streak.
    request_resolve()
    details = scan_with("None", hung=True)
    assert details["stage"] == "quarantined"
    assert details["verify_note"] == "the GPU query hung after its resolve"
    assert len(slack.deliveries) == 4

    # A fault read before the request is what the resolve fixed: it waits.
    snapshots.faults = [
        GpuFaultObservation("gpu-node-7", 3, "Reset", False, clock.now())
    ]
    request_resolve()
    clock.advance(seconds=30)
    scan(runtime, clock.now())
    assert store.open_episodes()[0].details["stage"] == "resolve_requested"

    # A clean fresh reading hands it to the actuator.
    request_resolve()
    details = scan_with("None")
    assert details["stage"] == "resolving"
    assert details["resolving_at"] == clock.now().isoformat()
    assert len(slack.deliveries) == 4
    # The actuator's confirm timer runs from the hand-over, not the request.
    scan_with(None)
    assert len(slack.deliveries) == 4
    scan_with(None)
    assert "has not confirmed returning" in slack.deliveries[-1].payload["text"]


def test_a_resolve_with_no_fresh_reading_posts_once() -> None:
    runtime, store, slack, clock = quarantine_runtime(
        [quarantine_decision()], live=True
    )
    scan_and_post(runtime, clock)
    store.update_details(
        "quarantine",
        "gpu-node-7",
        stage="resolve_requested",
        resolved_by="oncall",
        resolve_requested_at=clock.now().isoformat(),
    )
    scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 1
    scan_and_post(runtime, clock)
    assert slack.deliveries[-1].payload["text"] == (
        ":warning: *Quarantine* — `gpu-node-7` has had no fresh reading for "
        "10 min since it was resolved, so it stays out. Check its reporter."
    )
    for _ in range(3):
        scan_and_post(runtime, clock)
    assert len(slack.deliveries) == 2
    assert store.open_episodes()[0].details["stage"] == "resolve_requested"

    # The fault shows up: back to quarantined. The next resolve's wait gets
    # its own no-reading post.
    snapshots = runtime._handlers["infra_scan"]._snapshots  # type: ignore[attr-defined]
    clock.advance(minutes=5)
    snapshots.faults = [GpuFaultObservation("gpu-node-7", 3, "Reset", False, clock.now())]
    scan(runtime, clock.now())
    runtime.dispatch_due_notifications()
    assert store.open_episodes()[0].details["stage"] == "quarantined"
    snapshots.faults = []
    store.update_details(
        "quarantine",
        "gpu-node-7",
        stage="resolve_requested",
        resolve_requested_at=clock.now().isoformat(),
    )
    scan_and_post(runtime, clock)
    scan_and_post(runtime, clock)
    assert "no fresh reading" in slack.deliveries[-1].payload["text"]
    assert len(slack.deliveries) == 4


def job_failure_runtime(
    fetch: Any, *, live: bool = False
) -> tuple[AlertingRuntime, InMemoryInfraStore, RecordingSlackPort, FixedClock]:
    clock = FixedClock(START)
    executions = InMemoryAutomationExecutionStore()
    outbox = InMemoryOutboxStore()
    slack = RecordingSlackPort()
    store = InMemoryInfraStore(executions=executions, outbox=outbox)
    snapshots = FixtureSnapshots()
    snapshots.threshold_rows = []
    runtime = AlertingRuntime(
        executions=executions,
        outbox=outbox,
        slack=slack,
        clock=clock,
        handlers={
            "infra_scan": InfraScanHandler(
                hosts=FixtureHosts(),
                snapshots=snapshots,
                store=store,
                clock=clock,
                job_failure_decisions=fetch,
                quarantine_live=live,
            )
        },
        alert_path=None,
    )
    return runtime, store, slack, clock


def test_job_failure_trigger_runs_every_15_minutes_and_its_decisions_hold() -> None:
    fetched: list[datetime] = []

    def fetch(now: datetime) -> list[QuarantineDecision]:
        fetched.append(now)
        return [quarantine_decision()]

    runtime, store, slack, clock = job_failure_runtime(fetch)
    for _ in range(4):
        scan_and_post(runtime, clock)

    assert fetched == [START + timedelta(minutes=5), START + timedelta(minutes=20)]
    [episode] = store.open_episodes()
    assert episode.details["stage"] == "would"
    assert episode.details["evidence"] == {"xid": 79, "gpu": 3}
    assert len(slack.deliveries) == 1
    cached = {state.subject_key for state in store.infra_state().states}
    assert "trigger:job_failure" in cached


def test_job_failure_decisions_stay_dry_run_when_quarantine_is_live() -> None:
    # Fetched and then cached: neither path takes a host out.
    runtime, store, slack, clock = job_failure_runtime(
        lambda now: [quarantine_decision()], live=True
    )
    for _ in range(3):
        scan_and_post(runtime, clock)
    [episode] = store.open_episodes()
    assert episode.details["stage"] == "would"
    assert len(slack.deliveries) == 1
    assert "would quarantine" in slack.deliveries[0].payload["text"]


def test_a_failed_job_failure_fetch_yields_nothing_and_retries_next_scan(
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[datetime] = []

    def fetch(now: datetime) -> list[QuarantineDecision]:
        calls.append(now)
        if len(calls) == 1:
            raise RuntimeError("GET /builds failed with HTTP 502")
        return [quarantine_decision()]

    runtime, store, slack, clock = job_failure_runtime(fetch)
    scan_and_post(runtime, clock)
    assert store.open_episodes() == []
    assert (
        "job-failure trigger skipped: RuntimeError: GET /builds failed with HTTP 502"
        in capsys.readouterr().err.splitlines()
    )

    scan_and_post(runtime, clock)
    assert len(calls) == 2
    assert store.open_episodes()[0].details["stage"] == "would"


def test_a_trigger_rule_opens_a_dry_run_quarantine_with_its_pool() -> None:
    runtime, store, slack, clock = quarantine_runtime([])
    snapshots = runtime._handlers["infra_scan"]._snapshots  # type: ignore[attr-defined]
    snapshots.faults = [
        GpuFaultObservation("dgxb200-test", 0, "None", None, START),
    ]
    snapshots.xids = [XidEvent("dgxb200-test", "", 79, START - timedelta(hours=1))]

    scan_and_post(runtime, clock)

    [episode] = store.open_episodes()
    assert episode.subject_key == "dgxb200-test"
    assert episode.details["stage"] == "would"
    assert (episode.details["cluster"], episode.details["pool"]) == (
        "b200",
        "b200-k8s",
    )
    # The pool's only known host: a hardware fault would page a person.
    text = slack.deliveries[-1].payload["text"]
    assert text.endswith(
        "would quarantine `dgxb200-test`: Xid 79 on GPU unknown "
        "(last serving host: would page a person)"
    )


def test_a_gpu_fault_reading_opens_a_dry_run_quarantine() -> None:
    runtime, store, slack, clock = quarantine_runtime([])
    snapshots = runtime._handlers["infra_scan"]._snapshots  # type: ignore[attr-defined]
    reading_at = clock.now() + timedelta(minutes=5, seconds=-10)
    snapshots.faults = [
        GpuFaultObservation("dgxb200-test", 2, "Reset", None, reading_at),
    ]

    scan_and_post(runtime, clock)

    [episode] = store.open_episodes()
    assert episode.subject_key == "dgxb200-test"
    text = slack.deliveries[-1].payload["text"]
    # The pool's only known host: a hardware fault would page a person.
    assert text.endswith(
        "the driver asks for recovery (Reset) on GPU 2 "
        "(last serving host: would page a person)"
    )


def test_a_host_fault_reading_opens_a_dry_run_quarantine_on_its_second_check() -> None:
    runtime, store, slack, clock = quarantine_runtime([])
    snapshots = runtime._handlers["infra_scan"]._snapshots  # type: ignore[attr-defined]
    for _ in range(2):
        snapshots.host_fault_rows = [
            HostFaultObservation(
                "dgxb200-test", True, None, None, clock.now() + timedelta(minutes=4)
            )
        ]
        scan_and_post(runtime, clock)

    [episode] = store.open_episodes()
    assert episode.subject_key == "dgxb200-test"
    text = slack.deliveries[-1].payload["text"]
    # The pool's only known host: a host fault would be held.
    assert text.endswith(
        "the GPU query hung on 2 consecutive checks "
        "(would be held: last serving host in its pool)"
    )
