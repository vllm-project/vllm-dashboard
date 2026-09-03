"""Infra health alerting: unreporting hosts, disk usage, and GPU temperature.

One five-minute scan reconciles the expected-host set against the latest
reported telemetry. An episode opens only after a breach sustains across the
configured consecutive scan count and resolves on the first positive
observation, so every episode produces exactly two Slack messages: open and
resolve. Unreporting wording always says a host "stopped reporting"; the
alert never claims a machine is down. Disk usage is keyed by the shared
(fstype, device) group — not hostname — so a fleet-wide NFS volume pages
once no matter how many hosts mount it; mounts with role 'other' or a
per-mount error never alert. GPU temperature is keyed per host and GPU.
RAM, load, and network are display-only and never alert.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import subprocess
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any, Protocol

from alerting.commands import ScheduledCommand
from alerting.fast_ci import ALERTS_SLACK_CHANNEL
from alerting.ports import (
    AlertPath,
    Clock,
    DeliveryMode,
    DestinationMode,
    NotificationIntent,
)
from alerting.runtime import HandlerCompletion


def slack_channel() -> str:
    """The channel infra alert intents post to.

    SLACK_CI_INFRA_ALERT_CHANNEL (set from secrets manager) wins when set;
    falls back to the shared alerts channel so delivery keeps working before
    the secret is deployed. Channel naming follows the per-path convention:
    SLACK_CI_NOTIFICATIONS_CHANNEL (Full CI), SLACK_CI_FAST_FAILURE_ALERT_CHANNEL
    (Fast CI), SLACK_CI_INFRA_ALERT_CHANNEL (infra/queue alerts).
    """
    return os.environ.get("SLACK_CI_INFRA_ALERT_CHANNEL", ALERTS_SLACK_CHANNEL)

# A host absent from every expected source and silent for this long is
# auto-retired: it stops alerting and stays queryable for the dashboard.
RETIREMENT_AGE = timedelta(days=7)
# Only these mount roles alert on disk usage; 'other' and errored mounts
# never do. RAM, load, and network are display-only and never alert.
DISK_ALERT_ROLES = frozenset({"workspace", "images", "data", "system"})


class InfraAlertType(StrEnum):
    UNREPORTING = "unreporting"
    DISK_USAGE = "disk_usage"
    GPU_TEMPERATURE = "gpu_temperature"


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
class InfraScanPlan:
    """The state upserts and episode transitions one scan decided."""

    states: tuple[InfraSubjectState, ...] = ()
    opened: tuple[InfraAlertEpisode, ...] = ()
    resolved: tuple[InfraAlertEpisode, ...] = ()


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


def _disk_subject(fstype: str, device: str) -> str:
    return f"disk:{fstype.lower()}:{device.lower()}"


def _plan_disk_usage(
    *,
    now: datetime,
    threshold: InfraThreshold,
    disk_mounts: list[DiskMountObservation],
    states: Mapping[tuple[str, str], InfraSubjectState],
    open_episodes: Mapping[tuple[str, str], InfraAlertEpisode],
) -> InfraScanPlan:
    """Plan shared-volume episodes, deduplicated by (fstype, device).

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
            mount.role not in DISK_ALERT_ROLES
            or mount.error is not None
            or mount.total_bytes <= 0
        ):
            continue
        subject = _disk_subject(mount.fstype, mount.device)
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


def plan_infra_scan(
    *,
    now: datetime,
    thresholds: Mapping[str, InfraThreshold],
    expected_hosts: frozenset[str],
    latest_reports: Mapping[str, datetime],
    disk_mounts: list[DiskMountObservation],
    gpu_temperatures: list[GpuTemperatureObservation],
    states: Mapping[tuple[str, str], InfraSubjectState],
    open_episodes: Mapping[tuple[str, str], InfraAlertEpisode],
) -> InfraScanPlan:
    """Decide state upserts and episode transitions for one scan.

    Disabled threshold rows suppress their alert type entirely.
    """
    plans: list[InfraScanPlan] = []
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
    return InfraScanPlan(
        states=tuple(state for plan in plans for state in plan.states),
        opened=tuple(episode for plan in plans for episode in plan.opened),
        resolved=tuple(episode for plan in plans for episode in plan.resolved),
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


def _render_open(episode: InfraAlertEpisode) -> str:
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
    raise ValueError(f"no resolve renderer for alert type: {episode.alert_type}")


InfraNotificationFactory = Callable[[InfraScanPlan], list[NotificationIntent]]


def _intent(
    episode: InfraAlertEpisode,
    *,
    opening: bool,
    delivery_mode: DeliveryMode,
) -> NotificationIntent:
    digest = hashlib.sha256(
        f"{episode.alert_type}\0{episode.subject_key}".encode()
    ).hexdigest()[:16]
    epoch = int(episode.opened_at.timestamp())
    verb = "open" if opening else "resolve"
    delivery_id = f"infra:{episode.alert_type}:{digest}:{epoch}:{verb}"
    return NotificationIntent(
        delivery_id=delivery_id,
        alert_ref=f"infra:{episode.alert_type}:{episode.subject_key}",
        alert_path=AlertPath.INFRA,
        delivery_mode=delivery_mode,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination=slack_channel(),
        payload={
            "text": _render_open(episode) if opening else _render_resolve(episode)
        },
    )


def infra_notifications(
    plan: InfraScanPlan, *, delivery_mode: DeliveryMode
) -> list[NotificationIntent]:
    """Render exactly one intent per applied transition: open and resolve."""
    return [
        *(
            _intent(episode, opening=True, delivery_mode=delivery_mode)
            for episode in plan.opened
        ),
        *(
            _intent(episode, opening=False, delivery_mode=delivery_mode)
            for episode in plan.resolved
        ),
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
    ) -> None:
        self._hosts = hosts
        self._snapshots = snapshots
        self._store = store
        self._clock = clock
        self._delivery_mode = delivery_mode

    def __call__(self, command: ScheduledCommand) -> HandlerCompletion:
        now = command.target_time
        expected = frozenset(
            hostname.lower()
            for hostname in self._hosts.expected_hosts()
            if hostname.strip()
        ) | self._snapshots.recent_gpu_hosts(since=now - RETIREMENT_AGE)
        snapshot = self._store.infra_state()
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
            states={
                (state.alert_type, state.subject_key): state
                for state in snapshot.states
            },
            open_episodes={
                (episode.alert_type, episode.subject_key): episode
                for episode in snapshot.open_episodes
            },
        )
        self._store.commit_infra_scan(
            command=command,
            plan=plan,
            now=self._clock.now(),
            notification_factory=lambda applied: infra_notifications(
                applied, delivery_mode=self._delivery_mode
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


class BuildkiteAgentPort(Protocol):
    def list_agents(self, *, queue: str) -> list[dict[str, Any]]: ...


class BuildkiteGpuQueueAgentsSource:
    """GPU-queue Buildkite agents, keyed by their lowercased hostname.

    These cover the bare-metal hosts that run reporters without being
    Kubernetes nodes.
    """

    def __init__(self, *, buildkite: BuildkiteAgentPort, queue: str = "gpu") -> None:
        self._buildkite = buildkite
        self._queue = queue

    def expected_hosts(self) -> frozenset[str]:
        return frozenset(
            hostname
            for agent in self._buildkite.list_agents(queue=self._queue)
            for hostname in [str(agent.get("hostname") or "").strip().lower()]
            if hostname
        )
