"""Quarantine trigger rules (design §4.2), planned one scan at a time."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from alerting.infra import (
    DiskMountObservation,
    GpuCountObservation,
    GpuDeadMemoryObservation,
    GpuFaultObservation,
    HostFaultObservation,
    InfraAlertEpisode,
    InfraAlertType,
    InfraSubjectState,
    InfraThreshold,
    QuarantineDecision,
    XidEvent,
    pilot_pools,
    plan_trigger_rules,
)

START = datetime(2026, 9, 2, 10, 0, tzinfo=timezone.utc)
POOLS = {
    "gpu-node-7": ("h200", "h200_35gb"),
    "gpu-node-8": ("h200", "h200_35gb"),
    "gpu-node-9": ("h200", "h200_35gb"),
    "k8s-node-1": ("b200", "b200-k8s"),
}


def threshold(alert_type: InfraAlertType, value: float) -> InfraThreshold:
    return InfraThreshold(alert_type.value, value, "", 2, True)


THRESHOLDS = {
    t.alert_type: t
    for t in (
        threshold(InfraAlertType.DISK_USAGE, 90),
        threshold(InfraAlertType.GPU_DEAD_MEMORY, 4096),
        threshold(InfraAlertType.GPU_COUNT, 1),
    )
}


class Scans:
    """Plans scans five minutes apart, carrying subject state like the store."""

    def __init__(self, pools: dict[str, tuple[str, str]] | None = None) -> None:
        self.pools = POOLS if pools is None else pools
        self.thresholds = dict(THRESHOLDS)
        self.now = START
        self.states: dict[tuple[str, str], InfraSubjectState] = {}
        self.open_episodes: dict[tuple[str, str], InfraAlertEpisode] = {}

    def run(
        self, *, advance: bool = True, **observations: Any
    ) -> list[QuarantineDecision]:
        decisions, states = plan_trigger_rules(
            now=self.now,
            pools=self.pools,
            thresholds=self.thresholds,
            gpu_faults=observations.get("gpu_faults", []),
            host_faults=observations.get("host_faults", []),
            xid_events=observations.get("xid_events", []),
            disk_mounts=observations.get("disk_mounts", []),
            gpu_dead_memory=observations.get("gpu_dead_memory", []),
            gpu_counts=observations.get("gpu_counts", []),
            states=self.states,
            open_episodes=self.open_episodes,
        )
        for state in states:
            self.states[(state.alert_type, state.subject_key)] = state
        if advance:
            self.now += timedelta(minutes=5)
        return decisions

    def reading_at(self, age_seconds: float = 10) -> datetime:
        return self.now - timedelta(seconds=age_seconds)


def rules(decisions: list[QuarantineDecision]) -> list[tuple[str, str]]:
    return [(d.host, d.evidence["rule"]) for d in decisions]


def gpu(scans: Scans, host: str = "gpu-node-7", **fields: Any) -> GpuFaultObservation:
    return GpuFaultObservation(
        hostname=host,
        gpu_index=fields.pop("gpu_index", 3),
        recovery_action=fields.pop("recovery_action", "None"),
        remapped_rows_failure=fields.pop("remapped_rows_failure", False),
        reported_at=fields.pop("reported_at", scans.reading_at()),
    )


def host(scans: Scans, name: str = "gpu-node-7", **fields: Any) -> HostFaultObservation:
    return HostFaultObservation(
        hostname=name,
        gpu_query_hung=fields.get("gpu_query_hung", False),
        network_probes=fields.get("network_probes", [{"target": "a", "ok": True}]),
        root_owned_slots=fields.get("root_owned_slots", []),
        reported_at=fields.get("reported_at", scans.reading_at()),
        docker_ok=fields.get("docker_ok", True),
        docker_error=fields.get("docker_error"),
    )


def xid(
    code: int, at: datetime, *, name: str = "gpu-node-7", bus: str = "0000:1b:00.0"
) -> XidEvent:
    return XidEvent(hostname=name, bus_id=bus, xid=code, at=at)


def test_pilot_pools_map_k8s_nodes_by_name_and_bare_metal_by_agent_queue() -> None:
    pools = pilot_pools(
        {"inf-4x8h100-test", "dgxb200-test", "gpu-node-7", "other-gpu-1"},
        [
            ("GPU-Node-7.example.com", "h200_35gb"),
            ("gpu-node-9", "H200"),
            ("gpu-node-8", "h200_18gb"),
            ("ci-pod-abc", "b200-k8s"),  # a k8s agent's hostname is its pod
            ("cpu-host-1", "cpu_queue"),
        ],
    )
    assert pools == {
        "inf-4x8h100-test": ("h100", "mithril-h100-pool"),
        "dgxb200-test": ("b200", "b200-k8s"),
        "gpu-node-7": ("h200", "h200_35gb"),
        "gpu-node-9": ("h200", "H200"),
        "gpu-node-8": ("h200", "h200_18gb"),
    }


def test_recovery_action_trips_on_one_fresh_reading_only() -> None:
    scans = Scans()
    [decision] = scans.run(gpu_faults=[gpu(scans, recovery_action="Reset")])
    assert decision.hardware
    assert (decision.cluster, decision.pool) == ("h200", "h200_35gb")
    assert decision.reason == "the driver asks for recovery (Reset) on GPU 3"
    assert decision.evidence["rule"] == "recovery_action"

    for action in ("None", None):
        assert scans.run(gpu_faults=[gpu(scans, recovery_action=action)]) == []
    stale = gpu(scans, recovery_action="Reset", reported_at=scans.reading_at(61))
    assert scans.run(gpu_faults=[stale]) == []
    edge = gpu(scans, recovery_action="Reset", reported_at=scans.reading_at(60))
    assert len(scans.run(gpu_faults=[edge])) == 1  # 60 s old is still fresh
    other = gpu(scans, host="other-gpu-1", recovery_action="Reset")
    assert scans.run(gpu_faults=[other]) == []


def test_row_remap_failure_trips_and_unreadable_is_never_healthy_or_failing() -> None:
    scans = Scans()
    [decision] = scans.run(gpu_faults=[gpu(scans, remapped_rows_failure=True)])
    assert (decision.host, decision.evidence["rule"]) == ("gpu-node-7", "remapped_rows")
    assert decision.hardware
    assert decision.reason == "GPU 3 has run out of spare memory rows"
    # MIG hosts read NULL: missing, so no trip either way.
    assert scans.run(gpu_faults=[gpu(scans, remapped_rows_failure=None)]) == []


def test_hardware_xids_trip_on_first_sight_and_app_xids_never() -> None:
    scans = Scans()
    [decision] = scans.run(xid_events=[xid(79, START - timedelta(hours=3))])
    assert decision.hardware
    assert decision.reason == "Xid 79 on GPU 0000:1b:00.0"
    assert scans.run(xid_events=[xid(13, START), xid(43, START), xid(31, START)]) == []
    # Out of the 24 h window; exactly 24 h old is still in it.
    assert scans.run(xid_events=[xid(79, scans.now - timedelta(hours=25))]) == []
    assert len(scans.run(xid_events=[xid(79, scans.now - timedelta(hours=24))])) == 1


@pytest.mark.parametrize("code", [48, 54, 64, 79, 110, 140, 143, 157, 171, 172])
def test_every_first_sight_xid_trips_on_one_event(code: int) -> None:
    scans = Scans()
    assert rules(scans.run(xid_events=[xid(code, START)])) == [("gpu-node-7", "xid")]


@pytest.mark.parametrize("code", range(144, 151))
def test_every_nvlink_xid_trips_on_b200_and_never_elsewhere(code: int) -> None:
    scans = Scans()
    event = xid(code, START, name="k8s-node-1", bus="")
    assert rules(scans.run(xid_events=[event])) == [("k8s-node-1", "xid")]
    assert scans.run(xid_events=[xid(code, START)]) == []


def test_xids_past_the_nvlink_range_never_trip_on_first_sight() -> None:
    scans = Scans()
    assert scans.run(xid_events=[xid(151, START, name="k8s-node-1", bus="")]) == []


@pytest.mark.parametrize("code", [46, 62, 74, 95, 109, 119, 120, 136, 158])
def test_every_reset_class_xid_trips_on_its_third_event_only(code: int) -> None:
    scans = Scans()
    at = [START - timedelta(hours=h) for h in (20, 10, 1)]
    assert scans.run(xid_events=[xid(code, t) for t in at[:2]]) == []
    assert rules(scans.run(xid_events=[xid(code, t) for t in at])) == [
        ("gpu-node-7", "xid_repeat")
    ]


def test_nvlink_xids_trip_on_first_sight_only_on_b200() -> None:
    scans = Scans()
    event = xid(145, START, name="k8s-node-1", bus="")
    [decision] = scans.run(xid_events=[event])
    assert decision.cluster == "b200"
    assert decision.reason == "Xid 145 on GPU unknown"
    assert scans.run(xid_events=[xid(145, START)]) == []  # an h200 host


def test_reset_class_xids_trip_on_three_of_one_xid_on_one_gpu_in_a_day() -> None:
    scans = Scans()
    at = [START - timedelta(hours=h) for h in (20, 10, 1)]
    [decision] = scans.run(xid_events=[xid(95, t) for t in at])
    assert decision.hardware
    assert decision.evidence["count"] == 3
    assert decision.reason == "Xid 95 3 times on GPU 0000:1b:00.0 in 24 h"

    # Two GPUs, two different Xids, or one event outside the day: no trip.
    split = [xid(95, at[0]), xid(95, at[1]), xid(95, at[2], bus="0000:2c:00.0")]
    assert scans.run(xid_events=split) == []
    mixed = [xid(95, at[0]), xid(95, at[1]), xid(74, at[2])]
    assert scans.run(xid_events=mixed) == []
    old = [xid(95, scans.now - timedelta(hours=25)), xid(95, at[1]), xid(95, at[2])]
    assert scans.run(xid_events=old) == []

    # Kubernetes Xids carry no bus id; they count per host.
    k8s = [xid(62, t, name="k8s-node-1", bus="") for t in reversed(at)]
    [decision] = scans.run(xid_events=k8s)
    assert (decision.host, decision.evidence["rule"]) == ("k8s-node-1", "xid_repeat")
    assert decision.reason == "Xid 62 3 times on GPU unknown in 24 h"
    assert decision.evidence["first_at"] == at[0].isoformat()
    assert decision.evidence["last_at"] == at[2].isoformat()


def test_a_resolve_covers_the_xids_seen_before_it() -> None:
    scans = Scans()
    events = [xid(79, START - timedelta(hours=1))]
    assert len(scans.run(xid_events=events)) == 1

    scans.open_episodes[("quarantine", "gpu-node-7")] = InfraAlertEpisode(
        alert_type="quarantine",
        subject_key="gpu-node-7",
        opened_at=START,
        details={"stage": "resolving"},
    )
    resolved_at = scans.now
    assert scans.run(xid_events=events) == []  # the resolving scan itself
    scans.open_episodes.clear()
    assert scans.run(xid_events=events) == []
    # An Xid at the resolve cutoff is covered too.
    assert scans.run(xid_events=[*events, xid(48, resolved_at)]) == []

    newer = [*events, xid(48, scans.now - timedelta(minutes=1))]
    assert rules(scans.run(xid_events=newer)) == [("gpu-node-7", "xid")]


def test_a_waiting_resolve_covers_xids_up_to_its_request_only() -> None:
    scans = Scans()
    requested = scans.now - timedelta(minutes=10)
    scans.open_episodes[("quarantine", "gpu-node-7")] = InfraAlertEpisode(
        alert_type="quarantine",
        subject_key="gpu-node-7",
        opened_at=START,
        details={
            "stage": "resolve_requested",
            "resolve_requested_at": requested.isoformat(),
        },
    )
    covered = [xid(79, requested)]
    assert scans.run(xid_events=covered, advance=False) == []
    assert scans.states[("quarantine", "rule:xid:gpu-node-7")].last_reported_at == (
        requested
    )
    # One after the request, while it waits, sends the resolve back.
    newer = [*covered, xid(79, requested + timedelta(seconds=1))]
    assert rules(scans.run(xid_events=newer)) == [("gpu-node-7", "xid")]


def resolve(scans: Scans, name: str = "gpu-node-7") -> datetime:
    """Runs the scan that sees the host 'resolving'; returns the cutoff."""
    scans.open_episodes[("quarantine", name)] = InfraAlertEpisode(
        alert_type="quarantine",
        subject_key=name,
        opened_at=START,
        details={"stage": "resolving"},
    )
    resolved_at = scans.now
    scans.run()
    scans.open_episodes.clear()
    return resolved_at


def test_one_reset_class_xid_trips_while_the_host_is_on_probation() -> None:
    scans = Scans()
    resolved_at = resolve(scans)
    [decision] = scans.run(xid_events=[xid(62, scans.now - timedelta(minutes=1))])
    assert decision.hardware
    assert decision.evidence["rule"] == "xid_probation"
    assert decision.evidence["resolved_at"] == resolved_at.isoformat()
    assert decision.reason == (
        "Xid 62 on GPU 0000:1b:00.0 within 24 h of its last resolve"
    )


def test_probation_ends_a_day_after_the_resolve() -> None:
    scans = Scans()
    resolved_at = resolve(scans)
    day = timedelta(hours=24)
    scans.now = resolved_at + day
    assert rules(scans.run(xid_events=[xid(62, resolved_at + day)])) == [
        ("gpu-node-7", "xid_probation")
    ]
    later = resolved_at + day + timedelta(seconds=1)
    scans.now = later
    assert scans.run(xid_events=[xid(62, later)]) == []


def test_a_host_never_resolved_is_never_on_probation() -> None:
    scans = Scans()
    assert scans.run(xid_events=[xid(62, START)]) == []
    assert scans.run(xid_events=[xid(13, START)]) == []  # not a trigger Xid


def test_host_fault_trips_on_the_second_consecutive_fresh_failing_check() -> None:
    scans = Scans()
    assert scans.run(host_faults=[host(scans, gpu_query_hung=True)]) == []
    [decision] = scans.run(host_faults=[host(scans, gpu_query_hung=True)])
    assert not decision.hardware
    assert decision.reason == "the GPU query hung on 2 consecutive checks"


def test_a_missing_reading_neither_advances_nor_resets_the_streak() -> None:
    scans = Scans()
    assert scans.run(host_faults=[host(scans, gpu_query_hung=True)]) == []
    assert scans.run(host_faults=[]) == []  # reporter silent
    assert scans.run(host_faults=[host(scans, gpu_query_hung=None)]) == []
    stale = host(scans, gpu_query_hung=True, reported_at=scans.reading_at(61))
    assert scans.run(host_faults=[stale]) == []
    assert rules(scans.run(host_faults=[host(scans, gpu_query_hung=True)])) == [
        ("gpu-node-7", "gpu_hang")
    ]


def test_a_passing_check_resets_the_streak() -> None:
    scans = Scans()
    scans.run(host_faults=[host(scans, gpu_query_hung=True)])
    scans.run(host_faults=[host(scans, gpu_query_hung=False)])
    assert scans.run(host_faults=[host(scans, gpu_query_hung=True)]) == []


def test_a_reading_an_earlier_check_used_never_counts_again() -> None:
    scans = Scans()
    reading = host(scans, gpu_query_hung=True)
    assert scans.run(host_faults=[reading], advance=False) == []
    # A re-run of the scan sees the same, still fresh, reading.
    assert scans.run(host_faults=[reading], advance=False) == []
    scans.now += timedelta(seconds=30)
    assert len(scans.run(host_faults=[host(scans, gpu_query_hung=True)])) == 1


def network(scans: Scans, ok: dict[str, bool]) -> list[HostFaultObservation]:
    return [
        host(
            scans,
            name,
            network_probes=[
                {"target": "a", "ok": passed},
                {"target": "b", "ok": passed},
            ],
        )
        for name, passed in ok.items()
    ]


def test_network_trips_when_only_this_host_cannot_reach_out() -> None:
    scans = Scans()
    alone = {"gpu-node-7": False, "gpu-node-8": True, "gpu-node-9": True}
    assert scans.run(host_faults=network(scans, alone)) == []
    [decision] = scans.run(host_faults=network(scans, alone))
    assert decision.evidence["rule"] == "network"
    assert decision.evidence["probes"] == 2
    assert decision.reason == (
        "every network probe failed on 2 consecutive checks "
        "while most of the pool passed"
    )


def test_network_failing_across_most_of_the_pool_is_a_shared_incident() -> None:
    scans = Scans()
    alone = {"gpu-node-7": False, "gpu-node-8": True, "gpu-node-9": True}
    shared = {"gpu-node-7": False, "gpu-node-8": False, "gpu-node-9": True}
    assert scans.run(host_faults=network(scans, alone)) == []
    for _ in range(3):
        assert scans.run(host_faults=network(scans, shared)) == []
    # The shared scans counted as missing: the streak resumes, not restarts.
    assert rules(scans.run(host_faults=network(scans, alone))) == [
        ("gpu-node-7", "network")
    ]

    # No peer with a fresh reading: nothing to compare with, no trip.
    lone = Scans()
    for _ in range(3):
        assert lone.run(host_faults=network(lone, {"gpu-node-7": False})) == []


B200 = {f"dgxb200-{n}": ("b200", "b200-k8s") for n in (11, 15, 16)}


def failed(scans: Scans, name: str, *errors: str) -> HostFaultObservation:
    return host(
        scans,
        name,
        network_probes=[
            {"target": str(i), "ok": False, "error": e} for i, e in enumerate(errors)
        ],
    )


def test_network_dns_failing_while_a_k8s_peer_is_down_is_a_shared_incident() -> None:
    # 2026-10-19: while dgxb200-11 rebooted, its CoreDNS replica stayed in the
    # kube-dns service, and lookups from dgxb200-16's pods stalled.
    scans = Scans(B200)

    def scan(*errors: str, at: Scans = scans) -> list[HostFaultObservation]:
        readings = [failed(at, "dgxb200-16", *errors), host(at, "dgxb200-15")]
        if at is not scans:
            readings.append(host(at, "dgxb200-11"))
        return readings

    for _ in range(3):
        assert scans.run(host_faults=scan("timeout", "dns", "timeout")) == []
    # A failure DNS can't cause is still this host's own.
    assert scans.run(host_faults=scan("timeout", "connect")) == []
    assert rules(scans.run(host_faults=scan("timeout", "connect"))) == [
        ("dgxb200-16", "network")
    ]

    # With every peer read, DNS failures count as usual, whatever the
    # other clusters do.
    up = Scans({**B200, "inf-4x8h100-1": ("h100", "mithril-h100-pool")})
    assert up.run(host_faults=scan("dns", "dns", at=up)) == []
    assert rules(up.run(host_faults=scan("dns", "dns", at=up))) == [
        ("dgxb200-16", "network")
    ]


def test_network_dns_failing_on_bare_metal_ignores_unread_peers() -> None:
    # Bare-metal hosts resolve through their own DNS, not a cluster's.
    scans = Scans()
    for _ in range(2):
        decisions = scans.run(
            host_faults=[failed(scans, "gpu-node-7", "dns"), host(scans, "gpu-node-8")]
        )
    assert rules(decisions) == [("gpu-node-7", "network")]


def test_network_ignores_hosts_in_other_pools() -> None:
    scans = Scans()
    ok = {"gpu-node-7": False, "gpu-node-8": True, "gpu-node-9": True}
    ok["k8s-node-1"] = False  # down too, but in another pool
    assert scans.run(host_faults=network(scans, ok)) == []
    assert rules(scans.run(host_faults=network(scans, ok))) == [
        ("gpu-node-7", "network")
    ]


def disk_mount(
    scans: Scans,
    *,
    fstype: str = "ext4",
    used: float = 95.0,
    mount_point: str = "/mnt/local",
    total: int = 10000,
) -> DiskMountObservation:
    return DiskMountObservation(
        hostname="gpu-node-7",
        mount_point=mount_point,
        device="/dev/nvme0n1",
        fstype=fstype,
        role="workspace",
        used_bytes=round(used * total / 100),
        total_bytes=total,
        error=None,
        reported_at=scans.reading_at(),
    )


def test_a_full_local_disk_trips_on_two_checks_and_a_shared_volume_never() -> None:
    scans = Scans()
    assert scans.run(disk_mounts=[disk_mount(scans)]) == []
    [decision] = scans.run(disk_mounts=[disk_mount(scans)])
    assert decision.reason == "disk /mnt/local at 95% used on 2 consecutive checks"

    shared = Scans()
    for _ in range(3):
        assert shared.run(disk_mounts=[disk_mount(shared, fstype="nfs4")]) == []

    disabled = Scans()
    disabled.thresholds["disk_usage"] = InfraThreshold("disk_usage", 90, "%", 2, False)
    for _ in range(3):
        assert disabled.run(disk_mounts=[disk_mount(disabled)]) == []


def test_a_disk_at_exactly_the_threshold_trips() -> None:
    scans = Scans()
    assert scans.run(disk_mounts=[disk_mount(scans, used=90.0)]) == []
    assert rules(scans.run(disk_mounts=[disk_mount(scans, used=90.0)])) == [
        ("gpu-node-7", "disk")
    ]


def test_the_disk_decision_names_the_fullest_mount() -> None:
    scans = Scans()

    def mounts() -> list[DiskMountObservation]:
        return [
            disk_mount(scans, used=92.34),
            disk_mount(scans, used=97.06, mount_point="/mnt/scratch"),
        ]

    assert scans.run(disk_mounts=mounts()) == []
    [decision] = scans.run(disk_mounts=mounts())
    assert decision.reason == "disk /mnt/scratch at 97% used on 2 consecutive checks"
    assert decision.evidence["rule"] == "disk"
    assert decision.evidence["used_percent"] == 97.1
    assert decision.evidence["threshold_percent"] == 90


def test_a_zero_size_mount_is_unread_but_any_real_size_counts() -> None:
    scans = Scans()
    for _ in range(3):
        assert scans.run(disk_mounts=[disk_mount(scans, used=0, total=0)]) == []
    tiny = Scans()
    assert tiny.run(disk_mounts=[disk_mount(tiny, used=100, total=1)]) == []
    assert len(tiny.run(disk_mounts=[disk_mount(tiny, used=100, total=1)])) == 1


def test_dead_process_memory_trips_on_two_checks_at_the_alert_threshold() -> None:
    scans = Scans()

    def held(mb: float) -> list[GpuDeadMemoryObservation]:
        return [GpuDeadMemoryObservation("gpu-node-7", 2, mb, scans.reading_at())]

    assert scans.run(gpu_dead_memory=held(4096)) == []
    [decision] = scans.run(gpu_dead_memory=held(5000))
    assert decision.reason == (
        "5000 MiB held by dead processes on GPU 2 on 2 consecutive checks"
    )
    assert scans.run(gpu_dead_memory=held(100)) == []


def test_the_dead_memory_decision_names_the_worst_gpu() -> None:
    scans = Scans()

    def held() -> list[GpuDeadMemoryObservation]:
        return [
            GpuDeadMemoryObservation("gpu-node-7", 2, 5000, scans.reading_at()),
            GpuDeadMemoryObservation("gpu-node-7", 5, 6000, scans.reading_at()),
        ]

    assert scans.run(gpu_dead_memory=held()) == []
    [decision] = scans.run(gpu_dead_memory=held())
    assert decision.evidence["rule"] == "dead_memory"
    assert decision.reason == (
        "6000 MiB held by dead processes on GPU 5 on 2 consecutive checks"
    )


def test_root_owned_slots_trip_on_bare_metal_only() -> None:
    scans = Scans()
    slots = ["/mnt/local/buildkite-agent/builds/agent-1"]
    for _ in range(2):
        decisions = scans.run(
            host_faults=[
                host(scans, root_owned_slots=slots),
                host(scans, "k8s-node-1", root_owned_slots=slots),
            ]
        )
    assert rules(decisions) == [("gpu-node-7", "root_owned")]
    assert "agent-1" not in decisions[0].reason
    assert decisions[0].reason == (
        "root-owned files in 1 checkout slot(s) on 2 consecutive checks"
    )
    assert decisions[0].evidence["slots"] == 1


def test_broken_docker_trips_on_bare_metal_only() -> None:
    scans = Scans()
    broken = {"docker_ok": False, "docker_error": "the docker0 bridge is missing"}
    for _ in range(2):
        decisions = scans.run(
            host_faults=[host(scans, **broken), host(scans, "k8s-node-1", **broken)]
        )
    assert rules(decisions) == [("gpu-node-7", "docker")]
    assert decisions[0].reason == (
        "Docker can't start containers (the docker0 bridge is missing) "
        "on 2 consecutive checks"
    )
    assert decisions[0].evidence["error"] == "the docker0 bridge is missing"
    assert not decisions[0].hardware


def test_a_docker_reading_that_wasnt_taken_neither_trips_nor_resets() -> None:
    scans = Scans()
    broken = {"docker_ok": False, "docker_error": "docker info timed out"}
    assert scans.run(host_faults=[host(scans, **broken)]) == []
    assert scans.run(host_faults=[host(scans, docker_ok=None)]) == []
    assert rules(scans.run(host_faults=[host(scans, **broken)])) == [
        ("gpu-node-7", "docker")
    ]
    # A passing reading starts the streak over.
    scans = Scans()
    assert scans.run(host_faults=[host(scans, **broken)]) == []
    assert scans.run(host_faults=[host(scans)]) == []
    assert scans.run(host_faults=[host(scans, **broken)]) == []


def test_a_kubernetes_node_never_hides_the_bare_metal_hosts_after_it() -> None:
    scans = Scans(
        {"b200-node-1": ("b200", "b200-k8s"), "gpu-node-7": ("h200", "h200_35gb")}
    )
    slots = ["/mnt/local/buildkite-agent/builds/agent-1"]
    assert scans.run(host_faults=[host(scans, root_owned_slots=slots)]) == []
    assert rules(scans.run(host_faults=[host(scans, root_owned_slots=slots)])) == [
        ("gpu-node-7", "root_owned")
    ]


def test_fewer_gpus_than_the_baseline_trips_on_h200_only() -> None:
    scans = Scans()
    for name in ("gpu-node-7", "k8s-node-1"):
        scans.states[("gpu_count", f"gpu-count:{name}")] = InfraSubjectState(
            "gpu_count", f"gpu-count:{name}", details={"baseline_gpus": 8}
        )

    def counts() -> list[GpuCountObservation]:
        return [
            GpuCountObservation(name, 7, scans.reading_at())
            for name in ("gpu-node-7", "k8s-node-1")
        ]

    assert scans.run(gpu_counts=counts()) == []
    [decision] = scans.run(gpu_counts=counts())
    assert decision.host == "gpu-node-7"
    assert decision.evidence["rule"] == "gpu_count"
    assert decision.reason == "7 of 8 GPUs usable on 2 consecutive checks"


def test_gpu_count_reads_each_hosts_own_count_against_its_baseline() -> None:
    scans = Scans()
    for name in ("gpu-node-7", "gpu-node-8"):
        scans.states[("gpu_count", f"gpu-count:{name}")] = InfraSubjectState(
            "gpu_count", f"gpu-count:{name}", details={"baseline_gpus": 8}
        )

    def counts() -> list[GpuCountObservation]:
        return [
            GpuCountObservation("gpu-node-7", 6, scans.reading_at()),
            GpuCountObservation("gpu-node-8", 8, scans.reading_at()),
        ]

    assert scans.run(gpu_counts=counts()) == []
    [decision] = scans.run(gpu_counts=counts())
    assert decision.host == "gpu-node-7"
    assert decision.reason == "6 of 8 GPUs usable on 2 consecutive checks"


def test_gpu_count_without_a_baseline_never_trips() -> None:
    scans = Scans()
    scans.states[("gpu_count", "gpu-count:gpu-node-8")] = InfraSubjectState(
        "gpu_count", "gpu-count:gpu-node-8"
    )
    for _ in range(3):
        observed = [
            GpuCountObservation(name, 0, scans.reading_at())
            for name in ("gpu-node-7", "gpu-node-8")
        ]
        assert scans.run(gpu_counts=observed) == []


def test_hardware_decisions_come_first_so_they_win_for_a_host() -> None:
    scans = Scans()
    scans.run(host_faults=[host(scans, gpu_query_hung=True)])
    decisions = scans.run(
        host_faults=[host(scans, gpu_query_hung=True)],
        xid_events=[xid(79, START)],
    )
    assert rules(decisions) == [("gpu-node-7", "xid"), ("gpu-node-7", "gpu_hang")]


def test_gpu_fault_decisions_run_in_host_then_gpu_order_with_their_reading() -> None:
    scans = Scans()
    stale = gpu(
        scans, gpu_index=0, recovery_action="Reset", reported_at=scans.reading_at(61)
    )
    reading = scans.reading_at()
    decisions = scans.run(
        gpu_faults=[
            gpu(scans, "gpu-node-8", gpu_index=1, remapped_rows_failure=True),
            gpu(scans, gpu_index=5, recovery_action="Reset"),
            stale,
        ]
    )
    assert [(d.host, d.evidence["gpu_index"]) for d in decisions] == [
        ("gpu-node-7", 5),
        ("gpu-node-8", 1),
    ]
    assert {d.evidence["reading_at"] for d in decisions} == {reading.isoformat()}


def test_streaks_persist_under_stable_per_rule_subject_keys() -> None:
    """Subject state outlives a deploy, so its keys must not drift."""
    scans = Scans()
    scans.states[("gpu_count", "gpu-count:gpu-node-7")] = InfraSubjectState(
        "gpu_count", "gpu-count:gpu-node-7", details={"baseline_gpus": 8}
    )
    scans.open_episodes[("quarantine", "gpu-node-7")] = InfraAlertEpisode(
        alert_type="quarantine",
        subject_key="gpu-node-7",
        opened_at=START,
        details={"stage": "resolving"},
    )
    failing = network(
        scans, {"gpu-node-7": False, "gpu-node-8": True, "gpu-node-9": True}
    )
    failing[0] = host(
        scans,
        gpu_query_hung=True,
        network_probes=[{"target": "a", "ok": False}],
        root_owned_slots=["agent-1"],
        docker_ok=False,
        docker_error="the docker0 bridge is missing",
    )
    scans.run(
        host_faults=failing,
        disk_mounts=[disk_mount(scans)],
        gpu_dead_memory=[
            GpuDeadMemoryObservation("gpu-node-7", 2, 5000, scans.reading_at())
        ],
        gpu_counts=[GpuCountObservation("gpu-node-7", 7, scans.reading_at())],
    )
    assert sorted(key for kind, key in scans.states if kind == "quarantine") == [
        "rule:dead_memory:gpu-node-7",
        "rule:disk:gpu-node-7",
        "rule:docker:gpu-node-7",
        "rule:gpu_count:gpu-node-7",
        "rule:gpu_hang:gpu-node-7",
        "rule:network:gpu-node-7",
        "rule:root_owned:gpu-node-7",
        "rule:xid:gpu-node-7",
    ]
