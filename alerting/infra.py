"""Infra health alerting: unreporting hosts, disk usage, GPU temperature,
and dead-process GPU memory.

One five-minute scan reconciles the expected-host set against the latest
reported telemetry. An episode opens only after a breach sustains across the
configured consecutive scan count and resolves on the first positive
observation, so every episode produces exactly two Slack messages: open and
resolve. Unreporting wording always says a host "stopped reporting"; the
alert never claims a machine is down. Disk usage on a network filesystem is
keyed by the shared (fstype, device) group — not hostname — so a fleet-wide
NFS volume pages once no matter how many hosts mount it; local disks are keyed
per host, because device names like /dev/vda1 repeat across hosts. Every
reported mount alerts regardless of role; only a per-mount error skips one. GPU temperature and dead-process GPU memory
(memory still allocated to processes that no longer exist) are keyed per
host and GPU.
RAM, load, and network are display-only and never alert.

The same scan also runs the quarantine sequence (see plan_quarantine): a
quarantine is one more episode type, keyed by lowercased host, whose stage in
details moves would | [held ->] quarantining -> quarantined -> resolving ->
resolved, held when a safety limit blocks it.
Its decisions come from the trigger rules over the same telemetry (see
plan_trigger_rules) and from the job-failure trigger.
"""

from __future__ import annotations

import hashlib
import html
import json
import subprocess
import sys
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any, Protocol

from alerting.commands import ScheduledCommand
from alerting.fast_ci import slack_channel
from alerting.ports import (
    AlertPath,
    Clock,
    DeliveryMode,
    DestinationMode,
    NotificationIntent,
)
from alerting.runtime import HandlerCompletion
from alerting.slack import headed_payload


# A host absent from every expected source and silent for this long is
# auto-retired: it stops alerting and stays queryable for the dashboard.
RETIREMENT_AGE = timedelta(days=7)
# Every reported mount alerts on disk usage whatever its role, so a mount
# missing from a reporter's role map still pages. RAM, load, and network are
# display-only and never alert.
# Filesystems that one volume can back on many hosts; their disk episodes
# group across hosts. Every other fstype is a host-local disk whose device
# name (/dev/vda1, tmpfs) says nothing about which host it is on.
SHARED_DISK_FSTYPES = frozenset(
    {"nfs", "nfs4", "cifs", "smb3", "virtiofs", "lustre", "ceph"}
)


class InfraAlertType(StrEnum):
    UNREPORTING = "unreporting"
    DISK_USAGE = "disk_usage"
    GPU_TEMPERATURE = "gpu_temperature"
    GPU_DEAD_MEMORY = "gpu_dead_memory"
    GPU_COUNT = "gpu_count"
    QUARANTINE = "quarantine"


@dataclass(frozen=True)
class InfraThreshold:
    """One fleet-wide threshold row from alert_thresholds."""

    alert_type: str
    threshold_value: float
    threshold_unit: str
    consecutive_scans: int
    enabled: bool


@dataclass(frozen=True)
class HostReport:
    """The latest successful telemetry receipt for one host."""

    hostname: str
    reported_at: datetime


@dataclass(frozen=True)
class DiskMountObservation:
    """One mount from a host's latest host_snapshots disk detail."""

    hostname: str
    mount_point: str
    device: str
    fstype: str
    role: str
    used_bytes: int
    total_bytes: int
    error: str | None
    reported_at: datetime

    @property
    def used_percent(self) -> float:
        return self.used_bytes / self.total_bytes * 100


@dataclass(frozen=True)
class GpuTemperatureObservation:
    """One GPU's latest temperature reading from gpu_snapshots."""

    hostname: str
    gpu_index: int
    temperature_c: float
    reported_at: datetime


@dataclass(frozen=True)
class GpuDeadMemoryObservation:
    """One GPU's latest dead-process memory reading from gpu_snapshots."""

    hostname: str
    gpu_index: int
    dead_proc_mem_mb: float
    reported_at: datetime


@dataclass(frozen=True)
class GpuCountObservation:
    """How many distinct GPUs one host reported in the freshness window."""

    hostname: str
    observed_gpus: int
    reported_at: datetime


@dataclass(frozen=True)
class GpuFaultObservation:
    """One GPU's latest driver fault reading from gpu_snapshots.

    None means the reporter could not read the value, never a passing one:
    MIG hosts report remapped_rows_failure as None.
    """

    hostname: str
    gpu_index: int
    recovery_action: str | None
    remapped_rows_failure: bool | None
    reported_at: datetime


@dataclass(frozen=True)
class HostFaultObservation:
    """A host's latest host_snapshots fault readings; None means not read."""

    hostname: str
    gpu_query_hung: bool | None
    network_probes: list[dict[str, Any]] | None
    root_owned_slots: list[str] | None
    reported_at: datetime


@dataclass(frozen=True)
class XidEvent:
    """One kernel-log Xid from gpu_xid_events; bus_id is '' when unknown."""

    hostname: str
    bus_id: str
    xid: int
    at: datetime


@dataclass(frozen=True)
class InfraSubjectState:
    """Durable per-subject scan state carried between scans."""

    alert_type: str
    subject_key: str
    consecutive_breaches: int = 0
    last_reported_at: datetime | None = None
    retired_at: datetime | None = None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class InfraAlertEpisode:
    """One open-or-resolved breach episode for an infra alert subject."""

    alert_type: str
    subject_key: str
    opened_at: datetime
    resolved_at: datetime | None = None
    details: dict[str, Any] = field(default_factory=dict)
    alert_id: int | None = None

    @property
    def status(self) -> str:
        return "resolved" if self.resolved_at is not None else "open"


@dataclass(frozen=True)
class QuarantineDecision:
    """A trigger rule's verdict that one host should be taken out of CI.

    `cluster` is what the pool's actuator asks the dashboard for: `h100` and
    `b200` for the Kubernetes pools (each control plane's QUARANTINE_CLUSTER,
    with `host` its node name), `h200` for the bare-metal hosts.
    """

    host: str
    cluster: str
    pool: str
    reason: str
    evidence: dict[str, Any] = field(default_factory=dict)
    hardware: bool = False
    # A trigger still in its own dry run (the job-failure trigger): it only
    # ever opens a 'would' episode, even when quarantine is live.
    dry_run: bool = False


@dataclass(frozen=True)
class QuarantineStageChange:
    """An open quarantine episode moving to its next stage.

    `episode` is the episode after the change (resolved_at set when it
    closes) and renders the post. The store merges only `patch` into the
    stored details, and only while the stored stage is still `from_stage`:
    the dashboard writes the same row (operator resolve, actuator reports),
    so the worker never overwrites what it did not read.
    """

    episode: InfraAlertEpisode
    from_stage: str
    patch: dict[str, Any]
    silent: bool = False
    # Set for a post about the episode rather than a move to its next stage;
    # only "actuator_stuck" so far.
    notice: str | None = None


@dataclass(frozen=True)
class InfraScanPlan:
    """The state upserts and episode transitions one scan decided."""

    states: tuple[InfraSubjectState, ...] = ()
    opened: tuple[InfraAlertEpisode, ...] = ()
    resolved: tuple[InfraAlertEpisode, ...] = ()
    stage_changes: tuple[QuarantineStageChange, ...] = ()


@dataclass(frozen=True)
class InfraStateSnapshot:
    """Durable scan state and open episodes read before planning."""

    states: tuple[InfraSubjectState, ...]
    open_episodes: tuple[InfraAlertEpisode, ...]


class ExpectedHostSource(Protocol):
    def expected_hosts(self) -> frozenset[str]:
        """Lowercased hostnames expected to report telemetry."""
        ...


class InfraSnapshotPort(Protocol):
    """Read seam over the telemetry and threshold tables."""

    def infra_thresholds(self) -> list[InfraThreshold]: ...

    def latest_reports(self) -> list[HostReport]:
        """The newest gpu/host snapshot receipt per hostname, unbounded."""
        ...

    def recent_gpu_hosts(self, *, since: datetime) -> frozenset[str]:
        """Distinct hostnames with a gpu_snapshots row since `since`."""
        ...

    def disk_mounts(self) -> list[DiskMountObservation]:
        """Every mount from each host's latest host_snapshots disk detail."""
        ...

    def gpu_temperatures(self) -> list[GpuTemperatureObservation]:
        """The latest temperature reading per (hostname, gpu_index)."""
        ...

    def gpu_dead_memory(self) -> list[GpuDeadMemoryObservation]:
        """The latest dead-process memory reading per (hostname, gpu_index)."""
        ...

    def gpu_counts(self) -> list[GpuCountObservation]:
        """How many distinct GPUs each host reported recently."""
        ...

    def gpu_faults(self) -> list[GpuFaultObservation]:
        """The latest driver fault reading per (hostname, gpu_index)."""
        ...

    def host_faults(self) -> list[HostFaultObservation]:
        """The latest host fault reading per hostname."""
        ...

    def xid_events(
        self, *, hostnames: Iterable[str], since: datetime
    ) -> list[XidEvent]:
        """Trigger-rule Xids (TRIGGER_XIDS) on these hosts since `since`."""
        ...

    def agent_queues(self) -> list[tuple[str, str]]:
        """(hostname, queue) for every recently connected Buildkite agent."""
        ...


class InfraStore(Protocol):
    def infra_state(self) -> InfraStateSnapshot: ...

    def commit_infra_scan(
        self,
        *,
        command: ScheduledCommand,
        plan: InfraScanPlan,
        now: datetime,
        notification_factory: InfraNotificationFactory,
    ) -> None:
        """Atomically persist state upserts and episode transitions, enqueue
        notifications for the transitions that were actually applied, and
        complete the command execution. A failure commits none of them.
        """
        ...


def _plan_unreporting(
    *,
    now: datetime,
    threshold: InfraThreshold,
    expected_hosts: frozenset[str],
    latest_reports: Mapping[str, datetime],
    states: Mapping[tuple[str, str], InfraSubjectState],
    open_episodes: Mapping[tuple[str, str], InfraAlertEpisode],
) -> InfraScanPlan:
    out_states: list[InfraSubjectState] = []
    opened: list[InfraAlertEpisode] = []
    resolved: list[InfraAlertEpisode] = []
    silence = timedelta(minutes=threshold.threshold_value)
    subjects = sorted(
        expected_hosts
        | {
            subject_key
            for alert_type, subject_key in [*states, *open_episodes]
            if alert_type == InfraAlertType.UNREPORTING
        }
    )
    for hostname in subjects:
        key = (InfraAlertType.UNREPORTING.value, hostname)
        state = states.get(
            key, InfraSubjectState(InfraAlertType.UNREPORTING.value, hostname)
        )
        episode = open_episodes.get(key)
        last_seen = latest_reports.get(hostname, state.last_reported_at)
        if state.retired_at is not None:
            # A retired host that rejoins the expected set (a replacement
            # node reusing the name) alerts again from a clean count.
            if hostname not in expected_hosts:
                continue
            state = replace(state, retired_at=None, consecutive_breaches=0)
        fresh = last_seen is not None and now - last_seen <= silence
        if hostname not in expected_hosts:
            # A never-reported host has an unknown silence start, so only a
            # positively observed last report can age it into retirement.
            silent_too_long = (
                last_seen is not None and now - last_seen >= RETIREMENT_AGE
            )
            if silent_too_long:
                out_states.append(
                    replace(
                        state, last_reported_at=last_seen, retired_at=now
                    )
                )
                if episode is not None:
                    resolved.append(
                        replace(
                            episode,
                            resolved_at=now,
                            details={**episode.details, "resolution": "retired"},
                        )
                    )
                continue
            # Recently seen but no longer expected: hold the count, but a
            # fresh report still resolves an episode the scan already opened.
            if episode is not None and fresh:
                out_states.append(
                    replace(state, consecutive_breaches=0, last_reported_at=last_seen)
                )
                resolved.append(
                    replace(
                        episode,
                        resolved_at=now,
                        details={**episode.details, "resolution": "reporting"},
                    )
                )
            continue
        if fresh:
            if state.consecutive_breaches or episode is not None:
                out_states.append(
                    replace(state, consecutive_breaches=0, last_reported_at=last_seen)
                )
            if episode is not None:
                resolved.append(
                    replace(
                        episode,
                        resolved_at=now,
                        details={**episode.details, "resolution": "reporting"},
                    )
                )
            continue
        breaches = state.consecutive_breaches + 1
        out_states.append(
            replace(state, consecutive_breaches=breaches, last_reported_at=last_seen)
        )
        if breaches >= threshold.consecutive_scans and episode is None:
            opened.append(
                InfraAlertEpisode(
                    alert_type=InfraAlertType.UNREPORTING.value,
                    subject_key=hostname,
                    opened_at=now,
                    details={
                        "hostname": hostname,
                        "last_reported_at": (
                            last_seen.isoformat() if last_seen is not None else None
                        ),
                        "threshold_minutes": threshold.threshold_value,
                        "consecutive_scans": threshold.consecutive_scans,
                    },
                )
            )
    return InfraScanPlan(
        states=tuple(out_states), opened=tuple(opened), resolved=tuple(resolved)
    )


def _disk_subject(mount: DiskMountObservation) -> str:
    fstype, device = mount.fstype.lower(), mount.device.lower()
    if fstype in SHARED_DISK_FSTYPES:
        return f"disk:{fstype}:{device}"
    return f"disk:{mount.hostname.lower()}:{fstype}:{device}"


def _plan_disk_usage(
    *,
    now: datetime,
    threshold: InfraThreshold,
    disk_mounts: list[DiskMountObservation],
    states: Mapping[tuple[str, str], InfraSubjectState],
    open_episodes: Mapping[tuple[str, str], InfraAlertEpisode],
) -> InfraScanPlan:
    """Plan disk episodes: shared volumes by (fstype, device), local disks
    per host.

    A group breaches while any reported mount is at or above the threshold
    and resolves only when every mount in the group drops below it, so an
    NFS share mounted by N hosts pages once. Groups with no current
    observations (every mounting host is silent) hold their state.
    """
    out_states: list[InfraSubjectState] = []
    opened: list[InfraAlertEpisode] = []
    resolved: list[InfraAlertEpisode] = []
    groups: dict[str, list[DiskMountObservation]] = {}
    for mount in disk_mounts:
        if (
            mount.error is not None
            or mount.total_bytes <= 0
        ):
            continue
        subject = _disk_subject(mount)
        groups.setdefault(subject, []).append(mount)
    for subject in sorted(groups):
        members = groups[subject]
        breaching = [
            mount
            for mount in members
            if mount.used_percent >= threshold.threshold_value
        ]
        key = (InfraAlertType.DISK_USAGE.value, subject)
        state = states.get(
            key, InfraSubjectState(InfraAlertType.DISK_USAGE.value, subject)
        )
        episode = open_episodes.get(key)
        details = {
            "device": members[0].device,
            "fstype": members[0].fstype,
            "max_used_percent": round(
                max(mount.used_percent for mount in members), 1
            ),
            "threshold_percent": threshold.threshold_value,
            "mounts": [
                {
                    "hostname": mount.hostname,
                    "mount_point": mount.mount_point,
                    "used_percent": round(mount.used_percent, 1),
                }
                for mount in sorted(
                    breaching, key=lambda mount: mount.used_percent, reverse=True
                )
            ],
        }
        if breaching:
            breaches = state.consecutive_breaches + 1
            out_states.append(
                replace(state, consecutive_breaches=breaches, details=details)
            )
            if breaches >= threshold.consecutive_scans and episode is None:
                opened.append(
                    InfraAlertEpisode(
                        alert_type=InfraAlertType.DISK_USAGE.value,
                        subject_key=subject,
                        opened_at=now,
                        details={
                            **details,
                            "consecutive_scans": threshold.consecutive_scans,
                        },
                    )
                )
            continue
        out_states.append(replace(state, consecutive_breaches=0, details=details))
        if episode is not None:
            resolved.append(
                replace(
                    episode,
                    resolved_at=now,
                    details={
                        **episode.details,
                        "resolution": "below_threshold",
                        "max_used_percent": details["max_used_percent"],
                    },
                )
            )
    return InfraScanPlan(
        states=tuple(out_states), opened=tuple(opened), resolved=tuple(resolved)
    )


def _plan_gpu_temperature(
    *,
    now: datetime,
    threshold: InfraThreshold,
    gpu_temperatures: list[GpuTemperatureObservation],
    states: Mapping[tuple[str, str], InfraSubjectState],
    open_episodes: Mapping[tuple[str, str], InfraAlertEpisode],
) -> InfraScanPlan:
    out_states: list[InfraSubjectState] = []
    opened: list[InfraAlertEpisode] = []
    resolved: list[InfraAlertEpisode] = []
    observed = sorted(
        {(reading.hostname, reading.gpu_index) for reading in gpu_temperatures}
    )
    latest = {
        (reading.hostname, reading.gpu_index): reading for reading in gpu_temperatures
    }
    for hostname, gpu_index in observed:
        reading = latest[(hostname, gpu_index)]
        subject = f"gpu:{hostname}:{gpu_index}"
        key = (InfraAlertType.GPU_TEMPERATURE.value, subject)
        state = states.get(
            key, InfraSubjectState(InfraAlertType.GPU_TEMPERATURE.value, subject)
        )
        episode = open_episodes.get(key)
        details = {
            "hostname": hostname,
            "gpu_index": gpu_index,
            "temperature_c": reading.temperature_c,
            "threshold_celsius": threshold.threshold_value,
        }
        if reading.temperature_c >= threshold.threshold_value:
            breaches = state.consecutive_breaches + 1
            out_states.append(
                replace(state, consecutive_breaches=breaches, details=details)
            )
            if breaches >= threshold.consecutive_scans and episode is None:
                opened.append(
                    InfraAlertEpisode(
                        alert_type=InfraAlertType.GPU_TEMPERATURE.value,
                        subject_key=subject,
                        opened_at=now,
                        details={
                            **details,
                            "consecutive_scans": threshold.consecutive_scans,
                        },
                    )
                )
            continue
        out_states.append(replace(state, consecutive_breaches=0, details=details))
        if episode is not None:
            resolved.append(
                replace(
                    episode,
                    resolved_at=now,
                    details={
                        **episode.details,
                        "resolution": "below_threshold",
                        "temperature_c": reading.temperature_c,
                    },
                )
            )
    return InfraScanPlan(
        states=tuple(out_states), opened=tuple(opened), resolved=tuple(resolved)
    )


def _plan_gpu_dead_memory(
    *,
    now: datetime,
    threshold: InfraThreshold,
    gpu_dead_memory: list[GpuDeadMemoryObservation],
    states: Mapping[tuple[str, str], InfraSubjectState],
    open_episodes: Mapping[tuple[str, str], InfraAlertEpisode],
) -> InfraScanPlan:
    out_states: list[InfraSubjectState] = []
    opened: list[InfraAlertEpisode] = []
    resolved: list[InfraAlertEpisode] = []
    observed = sorted(
        {(reading.hostname, reading.gpu_index) for reading in gpu_dead_memory}
    )
    latest = {
        (reading.hostname, reading.gpu_index): reading for reading in gpu_dead_memory
    }
    for hostname, gpu_index in observed:
        reading = latest[(hostname, gpu_index)]
        subject = f"gpu-dead-mem:{hostname}:{gpu_index}"
        key = (InfraAlertType.GPU_DEAD_MEMORY.value, subject)
        state = states.get(
            key, InfraSubjectState(InfraAlertType.GPU_DEAD_MEMORY.value, subject)
        )
        episode = open_episodes.get(key)
        details = {
            "hostname": hostname,
            "gpu_index": gpu_index,
            "dead_proc_mem_mb": reading.dead_proc_mem_mb,
            "threshold_mib": threshold.threshold_value,
        }
        if reading.dead_proc_mem_mb >= threshold.threshold_value:
            breaches = state.consecutive_breaches + 1
            out_states.append(
                replace(state, consecutive_breaches=breaches, details=details)
            )
            if breaches >= threshold.consecutive_scans and episode is None:
                opened.append(
                    InfraAlertEpisode(
                        alert_type=InfraAlertType.GPU_DEAD_MEMORY.value,
                        subject_key=subject,
                        opened_at=now,
                        details={
                            **details,
                            "consecutive_scans": threshold.consecutive_scans,
                        },
                    )
                )
            continue
        out_states.append(replace(state, consecutive_breaches=0, details=details))
        if episode is not None:
            resolved.append(
                replace(
                    episode,
                    resolved_at=now,
                    details={
                        **episode.details,
                        "resolution": "below_threshold",
                        "dead_proc_mem_mb": reading.dead_proc_mem_mb,
                    },
                )
            )
    return InfraScanPlan(
        states=tuple(out_states), opened=tuple(opened), resolved=tuple(resolved)
    )


def _plan_gpu_count(
    *,
    now: datetime,
    threshold: InfraThreshold,
    gpu_counts: list[GpuCountObservation],
    states: Mapping[tuple[str, str], InfraSubjectState],
    open_episodes: Mapping[tuple[str, str], InfraAlertEpisode],
) -> InfraScanPlan:
    out_states: list[InfraSubjectState] = []
    opened: list[InfraAlertEpisode] = []
    resolved: list[InfraAlertEpisode] = []
    for reading in sorted(gpu_counts, key=lambda observation: observation.hostname):
        subject = f"gpu-count:{reading.hostname}"
        key = (InfraAlertType.GPU_COUNT.value, subject)
        state = states.get(
            key, InfraSubjectState(InfraAlertType.GPU_COUNT.value, subject)
        )
        episode = open_episodes.get(key)
        # The baseline lives in durable subject state and only ratchets up. A
        # rolling-window baseline would absorb the missing GPU once the window
        # passed and silently resolve the episode — the exact blindness this
        # alert exists to remove. Ratcheting also means a host's first scan can
        # never breach, and genuinely added capacity raises the bar instead.
        baseline = max(
            int(state.details.get("baseline_gpus") or 0), reading.observed_gpus
        )
        missing = baseline - reading.observed_gpus
        details = {
            "hostname": reading.hostname,
            "observed_gpus": reading.observed_gpus,
            "baseline_gpus": baseline,
            "missing_gpus": missing,
            "threshold_gpus": threshold.threshold_value,
        }
        if missing >= threshold.threshold_value:
            breaches = state.consecutive_breaches + 1
            out_states.append(
                replace(state, consecutive_breaches=breaches, details=details)
            )
            if breaches >= threshold.consecutive_scans and episode is None:
                opened.append(
                    InfraAlertEpisode(
                        alert_type=InfraAlertType.GPU_COUNT.value,
                        subject_key=subject,
                        opened_at=now,
                        details={
                            **details,
                            "consecutive_scans": threshold.consecutive_scans,
                        },
                    )
                )
            continue
        out_states.append(replace(state, consecutive_breaches=0, details=details))
        if episode is not None:
            resolved.append(
                replace(
                    episode,
                    resolved_at=now,
                    details={
                        **episode.details,
                        "resolution": "gpus_returned",
                        "observed_gpus": reading.observed_gpus,
                        "baseline_gpus": baseline,
                    },
                )
            )
    return InfraScanPlan(
        states=tuple(out_states), opened=tuple(opened), resolved=tuple(resolved)
    )


# Buildkite queue -> cluster for the quarantine pilot. The cluster is what the
# pool's actuator asks the dashboard for (QuarantineDecision) and groups the
# hosts that share a failure domain for the job-failure guards; the queue is
# the pool a quarantine is counted in.
PILOT_QUEUES = {
    "h200_35gb": "h200",
    "h200_18gb": "h200",
    "H200": "h200",
    "mithril-h100-pool": "h100",
    "b200-k8s": "b200",
}
# Kubernetes node-name prefix -> the queue its CI pods serve. Bare-metal hosts
# follow no naming scheme, so their queue comes from the agents on them.
K8S_NODE_QUEUES = {"inf-4x8h100-": "mithril-h100-pool", "dgxb200-": "b200-k8s"}

# Reporters post every 30 s; an older reading than two intervals is missing.
READING_MAX_AGE = timedelta(seconds=60)
# Host faults need this many consecutive scans that each fail a fresh reading.
HOST_FAULT_CHECKS = 2
# GPU hardware Xids from NVIDIA's Xid catalog. First-sight ones trip on one
# event; repeat ones on XID_REPEATS of the same Xid on one GPU in XID_WINDOW.
FIRST_SIGHT_XIDS = frozenset({48, 54, 64, 79, 110, 140, 143, 157, 171, 172})
# NVLink 5 errors, B200 only. The design wants only those whose decoded
# message says fatal hardware, but the device-plugin feed carries no decoded
# severity, so every one counts.
B200_FIRST_SIGHT_XIDS = frozenset(range(144, 151))
REPEAT_XIDS = frozenset({46, 62, 74, 95, 109, 119, 120, 136, 158})
TRIGGER_XIDS = FIRST_SIGHT_XIDS | B200_FIRST_SIGHT_XIDS | REPEAT_XIDS
XID_WINDOW = timedelta(hours=24)
XID_REPEATS = 3
# A fix that didn't hold shows up as the same fault soon after: for this long
# after a resolve, one reset-class Xid trips instead of XID_REPEATS.
PROBATION = timedelta(hours=24)


def pilot_pools(
    hosts: Iterable[str], agent_queues: Iterable[tuple[str, str]]
) -> dict[str, tuple[str, str]]:
    """host -> (cluster, pool) for every known pilot host.

    Kubernetes nodes map by name; a bare-metal host maps to the H200 queue its
    connected agents serve (Buildkite may report an FQDN, the reporter the
    short name). Hosts in no pilot pool are left out and never quarantined.
    """
    pools: dict[str, tuple[str, str]] = {}
    for hostname, queue in sorted(agent_queues):
        if PILOT_QUEUES.get(queue) == "h200":
            short = hostname.strip().lower().split(".", 1)[0]
            pools.setdefault(short, ("h200", queue))
    for hostname in hosts:
        for prefix, queue in K8S_NODE_QUEUES.items():
            if hostname.startswith(prefix):
                pools[hostname] = (PILOT_QUEUES[queue], queue)
    return pools


def plan_trigger_rules(
    *,
    now: datetime,
    pools: Mapping[str, tuple[str, str]],
    thresholds: Mapping[str, InfraThreshold],
    gpu_faults: list[GpuFaultObservation],
    host_faults: list[HostFaultObservation],
    xid_events: list[XidEvent],
    disk_mounts: list[DiskMountObservation],
    gpu_dead_memory: list[GpuDeadMemoryObservation],
    gpu_counts: list[GpuCountObservation],
    states: Mapping[tuple[str, str], InfraSubjectState],
    open_episodes: Mapping[tuple[str, str], InfraAlertEpisode],
) -> tuple[list[QuarantineDecision], list[InfraSubjectState]]:
    """Evaluate the quarantine trigger rules (design §4.2) for one scan.

    GPU hardware faults trip on first sight: one fresh reading, or one Xid
    in the last day. Host faults trip on HOST_FAULT_CHECKS consecutive scans
    that each see the fault on a fresh reading no earlier scan used; a missing
    or reused reading neither advances nor resets the streak, kept per host
    and rule in subject state. Hardware decisions come first, so they win
    when one host trips several rules.
    """
    kind = InfraAlertType.QUARANTINE.value
    hardware: list[QuarantineDecision] = []
    host_fault: list[QuarantineDecision] = []
    out_states: list[InfraSubjectState] = []

    def fresh(reported_at: datetime) -> bool:
        return now - reported_at <= READING_MAX_AGE

    def decide(host: str, rule: str, reason: str, **evidence: Any) -> None:
        cluster, pool = pools[host]
        is_hardware = rule in (
            "recovery_action",
            "remapped_rows",
            "xid",
            "xid_repeat",
            "xid_probation",
        )
        (hardware if is_hardware else host_fault).append(
            QuarantineDecision(
                host=host,
                cluster=cluster,
                pool=pool,
                reason=reason,
                evidence={"rule": rule, **evidence},
                hardware=is_hardware,
            )
        )

    def check(host: str, rule: str, failing: bool | None, at: datetime | None) -> bool:
        """Advance one host-fault streak; True when it trips this scan."""
        key = (kind, f"rule:{rule}:{host}")
        state = states.get(key, InfraSubjectState(*key))
        used = state.last_reported_at
        if failing is None or at is None or not fresh(at) or (used and at <= used):
            return False
        if not failing:
            if state.consecutive_breaches:
                out_states.append(
                    replace(state, consecutive_breaches=0, last_reported_at=at)
                )
            return False
        streak = state.consecutive_breaches + 1
        out_states.append(
            replace(state, consecutive_breaches=streak, last_reported_at=at)
        )
        return streak >= HOST_FAULT_CHECKS

    for fault in sorted(gpu_faults, key=lambda r: (r.hostname, r.gpu_index)):
        if fault.hostname not in pools or not fresh(fault.reported_at):
            continue
        read_at = fault.reported_at.isoformat()
        if fault.recovery_action not in (None, "None"):
            decide(
                fault.hostname,
                "recovery_action",
                f"the driver asks for recovery ({fault.recovery_action}) "
                f"on GPU {fault.gpu_index}",
                gpu_index=fault.gpu_index,
                recovery_action=fault.recovery_action,
                reading_at=read_at,
            )
        if fault.remapped_rows_failure is True:
            decide(
                fault.hostname,
                "remapped_rows",
                f"GPU {fault.gpu_index} has run out of spare memory rows",
                gpu_index=fault.gpu_index,
                reading_at=read_at,
            )

    # Xids stay within XID_WINDOW for a day, so a resolved host would trip
    # again on the Xid it was resolved for. A resolve covers every Xid up to
    # the scan that saw it 'resolving'; only newer ones count after that.
    floors: dict[str, datetime] = {}
    for host in pools:
        key = (kind, f"rule:xid:{host}")
        state = states.get(key, InfraSubjectState(*key))
        episode = open_episodes.get((kind, host))
        if episode is not None and episode.details.get("stage") == "resolving":
            out_states.append(replace(state, last_reported_at=now))
            floors[host] = now
        elif state.last_reported_at is not None:
            floors[host] = state.last_reported_at
    repeats: dict[tuple[str, str, int], list[XidEvent]] = defaultdict(list)
    for event in sorted(xid_events, key=lambda e: (e.hostname, e.at)):
        host = event.hostname
        floor = floors.get(host)
        if (
            host not in pools
            or now - event.at > XID_WINDOW
            or (floor is not None and event.at <= floor)
        ):
            continue
        gpu = event.bus_id or "unknown"
        if event.xid in FIRST_SIGHT_XIDS or (
            event.xid in B200_FIRST_SIGHT_XIDS and pools[host][0] == "b200"
        ):
            decide(
                host,
                "xid",
                f"Xid {event.xid} on GPU {gpu}",
                xid=event.xid,
                bus_id=event.bus_id,
                at=event.at.isoformat(),
            )
        elif event.xid in REPEAT_XIDS and floor and event.at - floor <= PROBATION:
            decide(
                host,
                "xid_probation",
                f"Xid {event.xid} on GPU {gpu} within 24 h of its last resolve",
                xid=event.xid,
                bus_id=event.bus_id,
                at=event.at.isoformat(),
                resolved_at=floor.isoformat(),
            )
        elif event.xid in REPEAT_XIDS:
            repeats[(host, event.bus_id, event.xid)].append(event)
    for (host, bus_id, xid), events in sorted(repeats.items()):
        if len(events) >= XID_REPEATS:
            decide(
                host,
                "xid_repeat",
                f"Xid {xid} {len(events)} times on GPU {bus_id or 'unknown'} in 24 h",
                xid=xid,
                bus_id=bus_id,
                count=len(events),
                first_at=events[0].at.isoformat(),
                last_at=events[-1].at.isoformat(),
            )

    latest = {reading.hostname: reading for reading in host_faults}

    def probes_failing(host: str) -> bool | None:
        """True when every network probe failed, None when not read."""
        reading = latest.get(host)
        if reading is None or not fresh(reading.reported_at):
            return None
        probes = [p for p in reading.network_probes or [] if isinstance(p, dict)]
        if not probes:
            return None
        return not any(probe.get("ok") is True for probe in probes)

    disk = thresholds.get(InfraAlertType.DISK_USAGE.value)
    dead = thresholds.get(InfraAlertType.GPU_DEAD_MEMORY.value)
    count = thresholds.get(InfraAlertType.GPU_COUNT.value)
    checks = HOST_FAULT_CHECKS
    for host in sorted(pools):
        cluster, pool = pools[host]
        reading = latest.get(host)
        if reading is not None and check(
            host, "gpu_hang", reading.gpu_query_hung, reading.reported_at
        ):
            decide(
                host,
                "gpu_hang",
                f"the GPU query hung on {checks} consecutive checks",
                reading_at=reading.reported_at.isoformat(),
            )

        # A host whose probes all fail is at fault only while most of its
        # pool still reaches out; otherwise it is a shared incident.
        failing = probes_failing(host)
        if failing:
            peers = [
                result
                for other, (_, other_pool) in pools.items()
                if other != host and other_pool == pool
                for result in [probes_failing(other)]
                if result is not None
            ]
            if 2 * peers.count(False) <= len(peers):
                failing = None
        if reading is not None and check(host, "network", failing, reading.reported_at):
            decide(
                host,
                "network",
                "every network probe failed on "
                f"{checks} consecutive checks while most of the pool passed",
                probes=len(reading.network_probes or []),
                reading_at=reading.reported_at.isoformat(),
            )

        if disk is not None and disk.enabled:
            # A shared volume filling up is every mounting host's problem,
            # not this host's; the disk alert pages for it once.
            mounts = [
                mount
                for mount in disk_mounts
                if mount.hostname == host
                and mount.error is None
                and mount.total_bytes > 0
                and mount.fstype.lower() not in SHARED_DISK_FSTYPES
            ]
            full = [m for m in mounts if m.used_percent >= disk.threshold_value]
            at = max((m.reported_at for m in mounts), default=None)
            if check(host, "disk", bool(full) if mounts else None, at) and at:
                worst = max(full, key=lambda m: m.used_percent)
                decide(
                    host,
                    "disk",
                    f"disk {worst.mount_point} at {worst.used_percent:.0f}% "
                    f"used on {checks} consecutive checks",
                    mount_point=worst.mount_point,
                    used_percent=round(worst.used_percent, 1),
                    threshold_percent=disk.threshold_value,
                    reading_at=at.isoformat(),
                )

        if dead is not None and dead.enabled:
            gpus = [
                r
                for r in gpu_dead_memory
                if r.hostname == host and fresh(r.reported_at)
            ]
            held = [r for r in gpus if r.dead_proc_mem_mb >= dead.threshold_value]
            at = max((r.reported_at for r in gpus), default=None)
            if check(host, "dead_memory", bool(held) if gpus else None, at) and at:
                worst_gpu = max(held, key=lambda r: r.dead_proc_mem_mb)
                decide(
                    host,
                    "dead_memory",
                    f"{worst_gpu.dead_proc_mem_mb:.0f} MiB held by dead "
                    f"processes on GPU {worst_gpu.gpu_index} on {checks} "
                    "consecutive checks",
                    gpu_index=worst_gpu.gpu_index,
                    dead_proc_mem_mb=worst_gpu.dead_proc_mem_mb,
                    threshold_mib=dead.threshold_value,
                    reading_at=at.isoformat(),
                )

        if cluster != "h200":
            continue
        # Bare metal only: Kubernetes nodes have no checkout slots, and a
        # node short of GPUs only goes into the daily summary.
        if reading is not None:
            slots = reading.root_owned_slots
            if check(
                host,
                "root_owned",
                bool(slots) if slots is not None else None,
                reading.reported_at,
            ):
                decide(
                    host,
                    "root_owned",
                    f"root-owned files in {len(slots or [])} checkout slot(s) "
                    f"on {checks} consecutive checks",
                    slots=len(slots or []),
                    reading_at=reading.reported_at.isoformat(),
                )
        observed = next((r for r in gpu_counts if r.hostname == host), None)
        if count is not None and count.enabled and observed is not None:
            # The same ratcheting baseline the GPU-count alert keeps.
            previous = states.get((InfraAlertType.GPU_COUNT.value, f"gpu-count:{host}"))
            baseline = max(
                int(previous.details.get("baseline_gpus") or 0) if previous else 0,
                observed.observed_gpus,
            )
            missing = baseline - observed.observed_gpus
            if check(
                host,
                "gpu_count",
                missing >= count.threshold_value,
                observed.reported_at,
            ):
                decide(
                    host,
                    "gpu_count",
                    f"{observed.observed_gpus} of {baseline} GPUs usable on "
                    f"{checks} consecutive checks",
                    observed_gpus=observed.observed_gpus,
                    baseline_gpus=baseline,
                    reading_at=observed.reported_at.isoformat(),
                )
    return [*hardware, *host_fault], out_states


# The job-failure trigger reads a day of builds from Buildkite on every
# refresh, so it runs at most this often; the scan caches its decisions in
# this quarantine subject state in between.
JOB_FAILURE_REFRESH = timedelta(minutes=15)
JOB_FAILURE_CACHE_KEY = "trigger:job_failure"

# A dry-run ('would') quarantine closes itself, without a post, once its
# decision has been absent this many consecutive scans.
DRY_RUN_EXPIRY_SCANS = 2

# The actuators run every minute; one that has not confirmed a quarantine
# ('out') or a resolve ('returned') this long after the command is stuck, and
# the host may be half out. Posted once per stage.
ACTUATOR_CONFIRM_TIMEOUT = timedelta(minutes=10)


def _actuator_stuck(
    episode: InfraAlertEpisode, stage: Any, actuator: Any, now: datetime
) -> bool:
    if episode.details.get("actuator_stuck") == stage:
        return False
    if stage == "quarantining" and actuator not in ("out", "drained"):
        since = episode.details.get("commanded_at")
    elif stage == "resolving" and actuator != "returned":
        since = episode.details.get("resolve_requested_at")
    else:
        return False
    started = datetime.fromisoformat(str(since)) if since else episode.opened_at
    return now - started >= ACTUATOR_CONFIRM_TIMEOUT


def _stage_change(
    episode: InfraAlertEpisode,
    patch: dict[str, Any],
    *,
    resolved_at: datetime | None = None,
    silent: bool = False,
) -> QuarantineStageChange:
    return QuarantineStageChange(
        episode=replace(
            episode, details={**episode.details, **patch}, resolved_at=resolved_at
        ),
        from_stage=str(episode.details.get("stage")),
        patch=patch,
        silent=silent,
    )


# Safety limits (design §4.3). A pool keeps at most a quarter of its hosts
# out, but always allows one; more than FLEET_BREAKER_LIMIT new quarantines
# in one scan plus the past hour points at the detector, not the hosts.
FLEET_BREAKER_LIMIT = 3
FLEET_BREAKER_WINDOW = timedelta(hours=1)
OUT_STAGES = frozenset({"quarantining", "quarantined", "resolving"})
# Why a limit blocked a decision; it opens (or would open) as 'held'.
# A host quarantined again this soon after a resolve was likely not fixed;
# the post asks a person to look rather than resolve it the same way again.
REPEAT_WINDOW = timedelta(days=7)
# Subject state recording when each host was last commanded out, so the
# breaker counts the past hour's commands even once their episodes resolve.
BREAKER_RECORD_KEY = "limits:commands"
# Limit details a later verdict replaces; cleared when a held or dry-run
# episode moves on, so an old hold or page doesn't follow it.
LIMIT_DETAILS = ("held_reason", "would_hold", "breaker_count", "paged", "repeat_of")
HELD_REASONS = {
    "pool_cap": "pool cap",
    "last_host": "last serving host in its pool",
    "detector_suspect": "detector suspect",
}


def _quarantine_limits(
    *,
    now: datetime,
    live: bool,
    wanted: Mapping[str, QuarantineDecision],
    episodes: Mapping[str, InfraAlertEpisode],
    pool_sizes: Mapping[str, int],
    commands: Mapping[str, datetime] | None = None,
) -> tuple[dict[str, str], int]:
    """Verdict per host whose decision would take it out this scan: 'apply',
    'page' (applied: a hardware fault on the last serving host), or a
    HELD_REASONS key; plus the breaker's count.

    Pool sizes are every known host in the pool, so an unknown pool reads as
    one whose last host this is. In dry run a 'would' episode stands in for
    the out stages, so the verdicts say what the limits would do. `commands`
    is when each host was last commanded out (BREAKER_RECORD_KEY), which the
    breaker counts alongside the hosts still out. A breaker hold sticks: the
    host stays held while its decision stands.
    """

    def is_out(episode: InfraAlertEpisode) -> bool:
        stage = episode.details.get("stage")
        return stage in OUT_STAGES or (
            not live and stage == "would" and not episode.details.get("would_hold")
        )

    def commanded_at(episode: InfraAlertEpisode) -> datetime:
        at = episode.details.get("commanded_at")
        return datetime.fromisoformat(str(at)) if at else episode.opened_at

    out_episodes = [episode for episode in episodes.values() if is_out(episode)]
    out = Counter(str(episode.details.get("pool")) for episode in out_episodes)
    recent = len(
        {
            e.subject_key
            for e in out_episodes
            if now - commanded_at(e) <= FLEET_BREAKER_WINDOW
        }
        | {
            host
            for host, at in (commands or {}).items()
            if now - at <= FLEET_BREAKER_WINDOW
        }
    )

    def stage(host: str) -> Any:
        episode = episodes.get(host)
        return episode.details.get("stage") if episode is not None else None

    candidates = [
        host
        for host in wanted
        if stage(host) is None or (live and stage(host) in ("would", "held"))
    ]
    # Held hosts have waited longest; hardware faults come next.
    candidates.sort(
        key=lambda host: (stage(host) != "held", not wanted[host].hardware, host)
    )
    verdicts: dict[str, str] = {}
    for host in candidates:
        decision = wanted[host]
        episode = episodes.get(host)
        held_by = episode.details.get("held_reason") if episode else None
        if stage(host) == "held" and held_by == "detector_suspect":
            verdicts[host] = "detector_suspect"
            continue
        size, taken = pool_sizes.get(decision.pool, 0), out[decision.pool]
        last_host = size - taken <= 1
        # A hardware fault skips the cap (design §4.4): a broken GPU only
        # fails the jobs it takes. The breaker below still counts it.
        if taken >= max(1, size // 4) and not decision.hardware:
            verdicts[host] = "pool_cap"
        elif last_host and not decision.hardware:
            verdicts[host] = "last_host"
        else:
            verdicts[host] = "page" if last_host else "apply"
            out[decision.pool] += 1
    applied = [
        host for host, verdict in verdicts.items() if verdict in ("apply", "page")
    ]
    count = len(applied) + recent
    if applied and count > FLEET_BREAKER_LIMIT:
        verdicts.update(dict.fromkeys(applied, "detector_suspect"))
    return verdicts, count


def plan_quarantine(
    *,
    now: datetime,
    live: bool,
    decisions: Iterable[QuarantineDecision],
    states: Mapping[tuple[str, str], InfraSubjectState],
    open_episodes: Mapping[tuple[str, str], InfraAlertEpisode],
    pool_sizes: Mapping[str, int] | None = None,
) -> InfraScanPlan:
    """Advance the quarantine sequence by one scan.

    A decision for a host with no open quarantine opens one: 'would' in dry
    run or for a dry-run trigger, 'quarantining' when live, or 'held' when a
    safety limit (_quarantine_limits) blocks it. A held episode moves to
    quarantining on a later scan once the limits allow it. The actuators
    report through the dashboard into details['actuator_state']; 'drained'
    moves quarantining to quarantined and 'returned' moves resolving (set by
    the operator resolve endpoint) to resolved. A dry-run or held episode
    closes silently once its decision is gone (or, for a held one, only a
    dry-run trigger names it) for DRY_RUN_EXPIRY_SCANS scans; a live one
    never closes by itself.
    """
    kind = InfraAlertType.QUARANTINE.value
    wanted: dict[str, QuarantineDecision] = {}
    for wanted_decision in decisions:
        wanted.setdefault(wanted_decision.host.strip().lower(), wanted_decision)
    out_states: list[InfraSubjectState] = []
    opened: list[InfraAlertEpisode] = []
    changes: list[QuarantineStageChange] = []
    episodes = {
        subject_key: episode
        for (alert_type, subject_key), episode in open_episodes.items()
        if alert_type == kind
    }
    record = states.get((kind, BREAKER_RECORD_KEY))
    recorded: dict[str, str] = record.details["commands"] if record else {}
    commands = {host: datetime.fromisoformat(at) for host, at in recorded.items()}
    verdicts, breaker_count = _quarantine_limits(
        now=now,
        live=live,
        # When live, a dry-run trigger's decision takes no slot.
        wanted={
            host: decision
            for host, decision in wanted.items()
            if not (live and decision.dry_run)
        },
        episodes=episodes,
        pool_sizes=pool_sizes or {},
        commands=commands,
    )
    for host in sorted(set(wanted) | set(episodes)):
        decision = wanted.get(host)
        episode = episodes.get(host)
        state = states.get((kind, host), InfraSubjectState(kind, host))
        absent = int(state.details.get("absent_scans") or 0)
        next_absent = 0
        command = (
            {
                "cluster": decision.cluster,
                "pool": decision.pool,
                "reason": decision.reason,
                "evidence": decision.evidence,
                "commanded_at": now.isoformat(),
            }
            if decision is not None
            else {}
        )
        verdict = verdicts.get(host)
        if verdict in HELD_REASONS:
            limit: dict[str, Any] = {"held_reason" if live else "would_hold": verdict}
            if verdict == "detector_suspect":
                limit["breaker_count"] = breaker_count
        elif verdict == "page":
            limit = {"paged": True}
        else:
            limit = {}
        last_resolve = state.details.get("last_resolve")
        if isinstance(last_resolve, dict) and now - datetime.fromisoformat(
            str(last_resolve.get("at"))
        ) <= REPEAT_WINDOW:
            limit["repeat_of"] = last_resolve
        state_details = dict(state.details)
        stage = episode.details.get("stage") if episode is not None else None
        actuator = episode.details.get("actuator_state") if episode else None
        acts = live and decision is not None and not decision.dry_run
        if episode is None:
            if not acts:
                opened_stage = "would"
            elif verdict in HELD_REASONS:
                opened_stage = "held"
            else:
                opened_stage = "quarantining"
            opened.append(
                InfraAlertEpisode(
                    alert_type=kind,
                    subject_key=host,
                    opened_at=now,
                    details={
                        "hostname": host,
                        "stage": opened_stage,
                        **command,
                        **limit,
                    },
                )
            )
        elif stage in ("would", "held") and acts:
            # Dry run was switched off, or a held one may now go ahead. A
            # held one still blocked for the same reason stays as it is,
            # without a post; a new reason (the breaker tripping) is posted.
            moved = dict.fromkeys(LIMIT_DETAILS) | command | limit
            if verdict not in HELD_REASONS:
                changes.append(
                    _stage_change(episode, {**moved, "stage": "quarantining"})
                )
            elif episode.details.get("held_reason") != verdict:
                changes.append(_stage_change(episode, {**moved, "stage": "held"}))
        elif stage in ("would", "held") and (
            decision is None or (stage == "held" and decision.dry_run)
        ):
            # Gone, or only a dry-run trigger still names a held host.
            next_absent = absent + 1
            if next_absent >= DRY_RUN_EXPIRY_SCANS:
                next_absent = 0
                changes.append(
                    _stage_change(
                        episode,
                        {"stage": "resolved", "resolution": "decision_cleared"},
                        resolved_at=now,
                        silent=True,
                    )
                )
        elif stage == "quarantining" and actuator == "drained":
            changes.append(
                _stage_change(
                    episode, {"stage": "quarantined", "quarantined_at": now.isoformat()}
                )
            )
        elif stage == "resolving" and actuator == "returned":
            changes.append(
                _stage_change(episode, {"stage": "resolved"}, resolved_at=now)
            )
            state_details["last_resolve"] = {
                "at": now.isoformat(),
                "by": episode.details.get("resolved_by"),
                "fix": episode.details.get("resolve_reason"),
                "reason": episode.details.get("reason"),
            }
        elif episode is not None and _actuator_stuck(episode, stage, actuator, now):
            change = _stage_change(episode, {"actuator_stuck": stage})
            changes.append(replace(change, notice="actuator_stuck"))
        if next_absent != absent:
            state_details["absent_scans"] = next_absent
        if state_details != state.details:
            out_states.append(replace(state, details=state_details))
    # Record this scan's commands for the breaker, keeping the past hour's.
    commanded = [
        *(e.subject_key for e in opened if e.details["stage"] == "quarantining"),
        *(
            c.episode.subject_key
            for c in changes
            if c.patch.get("stage") == "quarantining"
        ),
    ]
    kept = {
        host: at.isoformat()
        for host, at in commands.items()
        if now - at <= FLEET_BREAKER_WINDOW
    } | dict.fromkeys(commanded, now.isoformat())
    if kept != recorded:
        out_states.append(
            InfraSubjectState(kind, BREAKER_RECORD_KEY, details={"commands": kept})
        )
    return InfraScanPlan(
        states=tuple(out_states), opened=tuple(opened), stage_changes=tuple(changes)
    )


def _pool_sizes(
    pools: Mapping[str, tuple[str, str]],
    open_episodes: Mapping[tuple[str, str], InfraAlertEpisode],
) -> Counter[str]:
    """Hosts per pool: every mapped host, plus a host out of CI that no longer
    maps (a quarantined bare-metal host whose agents went away), so taking a
    host out never shrinks its own pool's cap."""
    members = {host: pool for host, (_, pool) in pools.items()}
    for (alert_type, host), episode in open_episodes.items():
        if (
            alert_type == InfraAlertType.QUARANTINE.value
            and episode.details.get("stage") in OUT_STAGES
        ):
            members.setdefault(host, str(episode.details.get("pool")))
    return Counter(members.values())


def plan_infra_scan(
    *,
    now: datetime,
    thresholds: Mapping[str, InfraThreshold],
    expected_hosts: frozenset[str],
    latest_reports: Mapping[str, datetime],
    disk_mounts: list[DiskMountObservation],
    gpu_temperatures: list[GpuTemperatureObservation],
    gpu_dead_memory: list[GpuDeadMemoryObservation],
    gpu_counts: list[GpuCountObservation],
    states: Mapping[tuple[str, str], InfraSubjectState],
    open_episodes: Mapping[tuple[str, str], InfraAlertEpisode],
    quarantine_decisions: Iterable[QuarantineDecision] = (),
    quarantine_live: bool = False,
    pools: Mapping[str, tuple[str, str]] | None = None,
    gpu_faults: list[GpuFaultObservation] | None = None,
    host_faults: list[HostFaultObservation] | None = None,
    xid_events: list[XidEvent] | None = None,
) -> InfraScanPlan:
    """Decide state upserts and episode transitions for one scan.

    Disabled threshold rows suppress their alert type entirely. The
    quarantine sequence always runs, so an open episode keeps advancing on
    actuator reports even when no decision names its host. Its decisions are
    the trigger rules' first, then `quarantine_decisions`.
    """
    rule_decisions, rule_states = plan_trigger_rules(
        now=now,
        pools=pools or {},
        thresholds=thresholds,
        gpu_faults=gpu_faults or [],
        host_faults=host_faults or [],
        xid_events=xid_events or [],
        disk_mounts=disk_mounts,
        gpu_dead_memory=gpu_dead_memory,
        gpu_counts=gpu_counts,
        states=states,
        open_episodes=open_episodes,
    )
    plans: list[InfraScanPlan] = [
        InfraScanPlan(states=tuple(rule_states)),
        plan_quarantine(
            now=now,
            live=quarantine_live,
            decisions=[*rule_decisions, *quarantine_decisions],
            states=states,
            open_episodes=open_episodes,
            pool_sizes=_pool_sizes(pools or {}, open_episodes),
        ),
    ]
    unreporting = thresholds.get(InfraAlertType.UNREPORTING.value)
    if unreporting is not None and unreporting.enabled:
        plans.append(
            _plan_unreporting(
                now=now,
                threshold=unreporting,
                expected_hosts=expected_hosts,
                latest_reports=latest_reports,
                states=states,
                open_episodes=open_episodes,
            )
        )
    disk_usage = thresholds.get(InfraAlertType.DISK_USAGE.value)
    if disk_usage is not None and disk_usage.enabled:
        plans.append(
            _plan_disk_usage(
                now=now,
                threshold=disk_usage,
                disk_mounts=disk_mounts,
                states=states,
                open_episodes=open_episodes,
            )
        )
    gpu_temperature = thresholds.get(InfraAlertType.GPU_TEMPERATURE.value)
    if gpu_temperature is not None and gpu_temperature.enabled:
        plans.append(
            _plan_gpu_temperature(
                now=now,
                threshold=gpu_temperature,
                gpu_temperatures=gpu_temperatures,
                states=states,
                open_episodes=open_episodes,
            )
        )
    gpu_dead_memory_threshold = thresholds.get(InfraAlertType.GPU_DEAD_MEMORY.value)
    if gpu_dead_memory_threshold is not None and gpu_dead_memory_threshold.enabled:
        plans.append(
            _plan_gpu_dead_memory(
                now=now,
                threshold=gpu_dead_memory_threshold,
                gpu_dead_memory=gpu_dead_memory,
                states=states,
                open_episodes=open_episodes,
            )
        )
    gpu_count = thresholds.get(InfraAlertType.GPU_COUNT.value)
    if gpu_count is not None and gpu_count.enabled:
        plans.append(
            _plan_gpu_count(
                now=now,
                threshold=gpu_count,
                gpu_counts=gpu_counts,
                states=states,
                open_episodes=open_episodes,
            )
        )
    return InfraScanPlan(
        states=tuple(state for plan in plans for state in plan.states),
        opened=tuple(episode for plan in plans for episode in plan.opened),
        resolved=tuple(episode for plan in plans for episode in plan.resolved),
        stage_changes=tuple(change for plan in plans for change in plan.stage_changes),
    )


def _escape(value: Any) -> str:
    return html.escape(str(value or ""), quote=False)


def _code(value: Any) -> str:
    return f"`{_escape(value).replace('`', "'")}`"


def _utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _render_disk_subject(details: Mapping[str, Any], subject_key: str) -> str:
    device = details.get("device")
    fstype = details.get("fstype")
    if device and fstype:
        return f"{_code(device)} ({_escape(fstype)})"
    return _code(subject_key)


# Placeholder until the quarantine runbook page exists. The infra channel is
# public: link only an access-controlled page, and keep resolve steps (endpoint,
# token, commands) out of every post. Only the operator token holders resolve.
QUARANTINE_RUNBOOK = "Runbook: to be linked before quarantine goes live."


PAGE_NOTE = "It is the last serving host in its pool; this pages a person."


def _repeat_note(episode: InfraAlertEpisode) -> str:
    repeat = episode.details.get("repeat_of")
    if not isinstance(repeat, dict):
        return ""
    return (
        f"\nQuarantined again within 7 days of {_escape(repeat.get('by'))}'s "
        "resolve, so the fix may not have held; this pages a person."
    )


def _render_quarantine(episode: InfraAlertEpisode) -> str:
    host = _code(episode.subject_key)
    reason = _escape(episode.details.get("reason"))
    stage = episode.details.get("stage")
    paged = bool(episode.details.get("paged"))
    if stage == "would":
        hold = HELD_REASONS.get(str(episode.details.get("would_hold")))
        if hold:
            reason += f" (would be held: {hold})"
        elif paged:
            reason += " (last serving host: would page a person)"
        if episode.details.get("repeat_of"):
            reason += " (again within 7 days of a resolve: would page a person)"
        return f":eyes: *Quarantine (dry run)* — would quarantine {host}: {reason}"
    if stage == "held":
        held_by = HELD_REASONS.get(str(episode.details.get("held_reason")), "a limit")
        return (
            f":double_vertical_bar: *Quarantine held* ({held_by}) — {host} keeps "
            f"serving and is quarantined once a slot frees if this still holds: "
            f"{reason}" + _repeat_note(episode)
        )
    if stage == "quarantining":
        return (
            f":construction: *Quarantine* — {host} will be quarantined once its "
            f"running jobs finish: {reason}"
            + (f"\n{PAGE_NOTE}" if paged else "")
            + _repeat_note(episode)
        )
    if stage == "quarantined":
        return f":no_entry: *Quarantine* — {host} is quarantined\n{QUARANTINE_RUNBOOK}"
    if stage == "resolved":
        by = _escape(episode.details.get("resolved_by") or "unknown")
        # The actuator explains what it left alone, such as a person's own
        # cordon that predates the quarantine.
        observed = episode.details.get("actuator_observed")
        note = observed.get("note") if isinstance(observed, dict) else None
        return (
            f":white_check_mark: *Quarantine* — {host} is back in service "
            f"(resolved by {by})" + (f"; {_escape(note)}" if note else "")
        )
    raise ValueError(f"no quarantine renderer for stage: {stage}")


def _render_detector_suspect(episodes: list[InfraAlertEpisode]) -> str:
    hosts = ", ".join(_code(episode.subject_key) for episode in episodes)
    count = _escape(episodes[0].details.get("breaker_count"))
    return (
        f":warning: *Quarantine detector suspect* — {count} new quarantines "
        f"within an hour (limit {FLEET_BREAKER_LIMIT}), so none from this scan "
        f"were applied. Held: {hosts}\nThey stay held while their decisions "
        "stand: a person needs to check the detector, or what these hosts share."
    )


def _render_actuator_stuck(episode: InfraAlertEpisode) -> str:
    host = _code(episode.subject_key)
    if episode.details.get("stage") == "resolving":
        doing = "has not confirmed returning"
    else:
        doing = "has not confirmed taking out"
    minutes = int(ACTUATOR_CONFIRM_TIMEOUT.total_seconds() // 60)
    return (
        f":warning: *Quarantine* — the actuator {doing} {host} after "
        f"{minutes} min; the host may be half out. Check the actuator on its "
        "cluster or host."
    )


def _render_open(episode: InfraAlertEpisode) -> str:
    if episode.alert_type == InfraAlertType.QUARANTINE:
        return _render_quarantine(episode)
    if episode.alert_type == InfraAlertType.UNREPORTING:
        hostname = _code(episode.details.get("hostname") or episode.subject_key)
        minutes = _escape(episode.details.get("threshold_minutes"))
        scans = _escape(episode.details.get("consecutive_scans"))
        last = episode.details.get("last_reported_at")
        seen = (
            f"Last report: {_escape(_utc(datetime.fromisoformat(str(last))))}"
            if last
            else "No report has ever been received."
        )
        return "\n".join(
            [
                f":rotating_light: *Infra alert* — host {hostname} stopped reporting",
                (
                    f"No successful report for over {minutes} minutes "
                    f"({scans} consecutive scans). {seen}"
                ),
            ]
        )
    if episode.alert_type == InfraAlertType.DISK_USAGE:
        disk = _render_disk_subject(episode.details, episode.subject_key)
        percent = _escape(episode.details.get("max_used_percent"))
        threshold = _escape(episode.details.get("threshold_percent"))
        scans = _escape(episode.details.get("consecutive_scans"))
        lines = [
            f":rotating_light: *Infra alert* — disk {disk} at {percent}% used "
            f"(threshold {threshold}%, {scans} consecutive scans)",
        ]
        mounts = episode.details.get("mounts")
        if isinstance(mounts, list) and mounts:
            rendered = ", ".join(
                f"{_code(mount.get('hostname'))}:{_escape(mount.get('mount_point'))} "
                f"({_escape(mount.get('used_percent'))}%)"
                for mount in mounts
                if isinstance(mount, dict)
            )
            if rendered:
                lines.append(f"Breaching mounts: {rendered}")
        return "\n".join(lines)
    if episode.alert_type == InfraAlertType.GPU_TEMPERATURE:
        hostname = _code(episode.details.get("hostname"))
        gpu_index = _escape(episode.details.get("gpu_index"))
        temperature = _escape(episode.details.get("temperature_c"))
        threshold = _escape(episode.details.get("threshold_celsius"))
        scans = _escape(episode.details.get("consecutive_scans"))
        return (
            f":rotating_light: *Infra alert* — GPU {gpu_index} on {hostname} "
            f"at {temperature}°C (threshold {threshold}°C, "
            f"{scans} consecutive scans)"
        )
    if episode.alert_type == InfraAlertType.GPU_DEAD_MEMORY:
        hostname = _code(episode.details.get("hostname"))
        gpu_index = _escape(episode.details.get("gpu_index"))
        dead_mem = _escape(episode.details.get("dead_proc_mem_mb"))
        threshold = _escape(episode.details.get("threshold_mib"))
        scans = _escape(episode.details.get("consecutive_scans"))
        return (
            f":rotating_light: *Infra alert* — GPU {gpu_index} on {hostname} "
            f"has {dead_mem} MiB held by dead processes "
            f"(threshold {threshold} MiB, {scans} consecutive scans)"
        )
    if episode.alert_type == InfraAlertType.GPU_COUNT:
        hostname = _code(episode.details.get("hostname"))
        observed = _escape(episode.details.get("observed_gpus"))
        baseline = _escape(episode.details.get("baseline_gpus"))
        missing = _escape(episode.details.get("missing_gpus"))
        scans = _escape(episode.details.get("consecutive_scans"))
        return "\n".join(
            [
                f":rotating_light: *Infra alert* — {hostname} is reporting "
                f"{observed} of {baseline} GPUs ({missing} missing, "
                f"{scans} consecutive scans)",
                (
                    "The host stays Ready and may still be accepting work. "
                    "Check `dmesg` for an Xid, and whether the scheduler is "
                    "still advertising GPU capacity for it."
                ),
            ]
        )
    raise ValueError(f"no open renderer for alert type: {episode.alert_type}")


def _render_resolve(episode: InfraAlertEpisode) -> str:
    if episode.alert_type == InfraAlertType.UNREPORTING:
        hostname = _code(episode.details.get("hostname") or episode.subject_key)
        if episode.details.get("resolution") == "retired":
            return (
                f":package: *Infra retired* — host {hostname} stopped reporting "
                "and was auto-retired after 7 days absent from every expected "
                "source; it no longer alerts."
            )
        return f":white_check_mark: *Infra resolved* — host {hostname} is reporting again"
    if episode.alert_type == InfraAlertType.DISK_USAGE:
        disk = _render_disk_subject(episode.details, episode.subject_key)
        threshold = _escape(episode.details.get("threshold_percent"))
        percent = _escape(episode.details.get("max_used_percent"))
        return (
            f":white_check_mark: *Infra resolved* — disk {disk} back below "
            f"{threshold}% used (now {percent}%)"
        )
    if episode.alert_type == InfraAlertType.GPU_TEMPERATURE:
        hostname = _code(episode.details.get("hostname"))
        gpu_index = _escape(episode.details.get("gpu_index"))
        threshold = _escape(episode.details.get("threshold_celsius"))
        temperature = _escape(episode.details.get("temperature_c"))
        return (
            f":white_check_mark: *Infra resolved* — GPU {gpu_index} on "
            f"{hostname} back below {threshold}°C (now {temperature}°C)"
        )
    if episode.alert_type == InfraAlertType.GPU_DEAD_MEMORY:
        hostname = _code(episode.details.get("hostname"))
        gpu_index = _escape(episode.details.get("gpu_index"))
        threshold = _escape(episode.details.get("threshold_mib"))
        dead_mem = _escape(episode.details.get("dead_proc_mem_mb"))
        return (
            f":white_check_mark: *Infra resolved* — GPU {gpu_index} on "
            f"{hostname} dead-process memory back below {threshold} MiB "
            f"(now {dead_mem} MiB)"
        )
    if episode.alert_type == InfraAlertType.GPU_COUNT:
        hostname = _code(episode.details.get("hostname"))
        observed = _escape(episode.details.get("observed_gpus"))
        return (
            f":white_check_mark: *Infra resolved* — {hostname} is reporting "
            f"all {observed} GPUs again"
        )
    raise ValueError(f"no resolve renderer for alert type: {episode.alert_type}")


InfraNotificationFactory = Callable[[InfraScanPlan], list[NotificationIntent]]


def _intent(
    episode: InfraAlertEpisode,
    *,
    verb: str,
    text: str,
    delivery_mode: DeliveryMode,
) -> NotificationIntent:
    digest = hashlib.sha256(
        f"{episode.alert_type}\0{episode.subject_key}".encode()
    ).hexdigest()[:16]
    epoch = int(episode.opened_at.timestamp())
    # ':resolve' edits the paired ':open' message in place (see runtime);
    # quarantine stage posts use their stage as the verb and post fresh.
    delivery_id = f"infra:{episode.alert_type}:{digest}:{epoch}:{verb}"
    return NotificationIntent(
        delivery_id=delivery_id,
        alert_ref=f"infra:{episode.alert_type}:{episode.subject_key}",
        alert_path=AlertPath.INFRA,
        delivery_mode=delivery_mode,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination=slack_channel(),
        payload=headed_payload(
            text,
            **(
                {"source": "QUARANTINE", "icon": "🚧"}
                if episode.alert_type == InfraAlertType.QUARANTINE
                else {"source": "INFRA", "icon": "🖥️"}
            ),
        ),
    )


def infra_notifications(
    plan: InfraScanPlan,
    *,
    delivery_mode: DeliveryMode,
    operator_destination: str | None = None,
) -> list[NotificationIntent]:
    """Render exactly one intent per applied transition: open, resolve, and
    each non-silent quarantine stage change.

    A live quarantine that needs a person (a hardware fault on the last
    serving host, a repeat offender, or a tripped breaker) also goes to
    `operator_destination`, the worker-failure DM, when it is set.
    """
    # A tripped breaker holds every new quarantine of the scan, newly opened
    # or moved from held or dry run; one post says so for all of them.
    tripped = [
        change
        for change in plan.stage_changes
        if not change.silent and change.patch.get("held_reason") == "detector_suspect"
    ]
    suspect = [
        *(
            episode
            for episode in plan.opened
            if episode.details.get("held_reason") == "detector_suspect"
        ),
        *(change.episode for change in tripped),
    ]
    channel = [
        *(
            _intent(
                episode,
                verb="open",
                text=_render_open(episode),
                delivery_mode=delivery_mode,
            )
            for episode in plan.opened
            if episode not in suspect
        ),
        *(
            [
                _intent(
                    suspect[0],
                    verb="held:detector_suspect",
                    text=_render_detector_suspect(suspect),
                    delivery_mode=delivery_mode,
                )
            ]
            if suspect
            else []
        ),
        *(
            _intent(
                episode,
                verb="resolve",
                text=_render_resolve(episode),
                delivery_mode=delivery_mode,
            )
            for episode in plan.resolved
        ),
        *(
            _intent(
                change.episode,
                verb=str(change.episode.details["stage"])
                + (f":{change.notice}" if change.notice else ""),
                text=(
                    _render_actuator_stuck(change.episode)
                    if change.notice == "actuator_stuck"
                    else _render_quarantine(change.episode)
                ),
                delivery_mode=delivery_mode,
            )
            for change in plan.stage_changes
            if not change.silent and change not in tripped
        ),
    ]
    if not operator_destination:
        return channel
    # The command, not every later stage of it: an opened episode, or one a
    # held or dry-run stage moved to quarantining or held.
    commanded = {
        f"infra:{episode.alert_type}:{episode.subject_key}"
        for episode in [
            *plan.opened,
            *(
                change.episode
                for change in plan.stage_changes
                if not change.silent
                and change.patch.get("stage") in ("quarantining", "held")
            ),
        ]
        if episode.details.get("stage") != "would"
        and (
            episode.details.get("paged")
            or episode.details.get("repeat_of")
            or episode.details.get("held_reason") == "detector_suspect"
        )
    }
    return channel + [
        replace(
            intent,
            delivery_id=f"{intent.delivery_id}:operator",
            destination=operator_destination,
        )
        for intent in channel
        if intent.alert_ref in commanded
    ]


class InfraScanHandler:
    """Run one infra health scan and atomically persist its durable effects."""

    def __init__(
        self,
        *,
        hosts: ExpectedHostSource,
        snapshots: InfraSnapshotPort,
        store: InfraStore,
        clock: Clock,
        delivery_mode: DeliveryMode = DeliveryMode.LIVE,
        quarantine_decisions: Callable[[], Iterable[QuarantineDecision]] = tuple,
        job_failure_decisions: (
            Callable[[datetime], Iterable[QuarantineDecision]] | None
        ) = None,
        quarantine_live: bool = False,
        operator_destination: str | None = None,
    ) -> None:
        self._hosts = hosts
        self._snapshots = snapshots
        self._store = store
        self._clock = clock
        self._delivery_mode = delivery_mode
        # Decisions beyond the reading-based trigger rules, which the scan
        # evaluates itself. The job-failure trigger reads Buildkite, so it is
        # cached (see _job_failures).
        self._quarantine_decisions = quarantine_decisions
        self._job_failure_decisions = job_failure_decisions
        self._quarantine_live = quarantine_live
        self._operator_destination = operator_destination

    def _job_failures(
        self, now: datetime, states: Mapping[tuple[str, str], InfraSubjectState]
    ) -> tuple[list[QuarantineDecision], tuple[InfraSubjectState, ...]]:
        """The job-failure trigger's decisions, refreshed every
        JOB_FAILURE_REFRESH and cached in subject state between scans (each
        scan is its own process). A failed fetch yields no decisions and
        retries next scan; it never fails the scan.

        Every one is dry run: the trigger goes live only after its own review
        (design §6), not when quarantine does."""
        if self._job_failure_decisions is None:
            return [], ()
        key = (InfraAlertType.QUARANTINE.value, JOB_FAILURE_CACHE_KEY)
        cached = states.get(key)
        if (
            cached is not None
            and cached.last_reported_at is not None
            and now - cached.last_reported_at < JOB_FAILURE_REFRESH
        ):
            return [
                QuarantineDecision(**{**item, "dry_run": True})
                for item in cached.details["decisions"]
            ], ()
        try:
            decisions = [
                replace(decision, dry_run=True)
                for decision in self._job_failure_decisions(now)
            ]
        except Exception as exc:
            print(
                f"job-failure trigger skipped: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
            return [], ()
        return decisions, (
            InfraSubjectState(
                *key,
                last_reported_at=now,
                details={"decisions": [asdict(item) for item in decisions]},
            ),
        )

    def __call__(self, command: ScheduledCommand) -> HandlerCompletion:
        now = command.target_time
        # The roster is reporter-derived: hosts seen in the retirement window
        # are the fleet that can silently die. External inventories (Buildkite
        # gpu-queue agents) proved to be ephemeral pods and autoscaled CI
        # instances that never run reporters — pure never-reported noise.
        expected = frozenset(
            hostname.lower()
            for hostname in self._hosts.expected_hosts()
            if hostname.strip()
        ) | self._snapshots.recent_gpu_hosts(since=now - RETIREMENT_AGE)
        snapshot = self._store.infra_state()
        states = {
            (state.alert_type, state.subject_key): state for state in snapshot.states
        }
        gpu_faults = self._snapshots.gpu_faults()
        host_faults = self._snapshots.host_faults()
        pools = pilot_pools(
            {fault.hostname for fault in gpu_faults}
            | {reading.hostname for reading in host_faults},
            self._snapshots.agent_queues(),
        )
        job_failures, cache = self._job_failures(now, states)
        plan = plan_infra_scan(
            now=now,
            thresholds={
                threshold.alert_type: threshold
                for threshold in self._snapshots.infra_thresholds()
            },
            expected_hosts=expected,
            latest_reports={
                report.hostname: report.reported_at
                for report in self._snapshots.latest_reports()
            },
            disk_mounts=self._snapshots.disk_mounts(),
            gpu_temperatures=self._snapshots.gpu_temperatures(),
            gpu_dead_memory=self._snapshots.gpu_dead_memory(),
            gpu_counts=self._snapshots.gpu_counts(),
            states=states,
            open_episodes={
                (episode.alert_type, episode.subject_key): episode
                for episode in snapshot.open_episodes
            },
            quarantine_decisions=[*job_failures, *self._quarantine_decisions()],
            quarantine_live=self._quarantine_live,
            pools=pools,
            gpu_faults=gpu_faults,
            host_faults=host_faults,
            xid_events=self._snapshots.xid_events(
                hostnames=sorted(pools), since=now - XID_WINDOW
            ),
        )
        plan = replace(plan, states=plan.states + cache)
        self._store.commit_infra_scan(
            command=command,
            plan=plan,
            now=self._clock.now(),
            notification_factory=lambda applied: infra_notifications(
                applied,
                delivery_mode=self._delivery_mode,
                operator_destination=self._operator_destination,
            ),
        )
        return HandlerCompletion.TRANSACTIONAL


class UnionExpectedHostSource:
    """The expected-host set is the union of every configured source."""

    def __init__(self, sources: Iterable[ExpectedHostSource]) -> None:
        self._sources = list(sources)

    def expected_hosts(self) -> frozenset[str]:
        hosts: set[str] = set()
        for source in self._sources:
            hosts.update(source.expected_hosts())
        return frozenset(hostname.lower() for hostname in hosts if hostname.strip())


class KubectlNodesSource:
    """Node names from one Kubernetes cluster, read through kubectl."""

    def __init__(
        self,
        *,
        kubeconfig: str,
        kubectl: str = "kubectl",
        timeout_seconds: float = 30.0,
    ) -> None:
        self._kubeconfig = kubeconfig
        self._kubectl = kubectl
        self._timeout_seconds = timeout_seconds

    def expected_hosts(self) -> frozenset[str]:
        result = subprocess.run(
            [
                self._kubectl,
                "--kubeconfig",
                self._kubeconfig,
                "get",
                "nodes",
                "-o",
                "json",
            ],
            capture_output=True,
            text=True,
            timeout=self._timeout_seconds,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"kubectl get nodes failed: {result.stderr.strip()[:500]}"
            )
        payload = json.loads(result.stdout)
        items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            raise RuntimeError("kubectl get nodes returned an invalid response")
        return frozenset(
            name
            for item in items
            if isinstance(item, dict)
            and isinstance(item.get("metadata"), dict)
            for name in [str(item["metadata"].get("name") or "").strip().lower()]
            if name
        )
