"""Infra unreporting-host scans through the scheduled-command seam."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from alerting.commands import ScheduledCommand
from alerting.full_ci import BuildkiteRestClient
from alerting.infra import (
    RETIREMENT_AGE,
    BuildkiteGpuQueueAgentsSource,
    HostReport,
    InfraScanHandler,
    InfraThreshold,
    InfraAlertType,
    KubectlNodesSource,
    UnionExpectedHostSource,
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


def test_first_fresh_report_resolves_episode_with_exactly_two_messages() -> None:
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
    assert len(slack.deliveries) == 2
    assert "stopped reporting" in slack.deliveries[0].payload["text"]
    assert "reporting again" in slack.deliveries[1].payload["text"]


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
    assert len(slack.deliveries) == 3
    assert "stopped reporting" in slack.deliveries[2].payload["text"]


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
    assert len(slack.deliveries) == 2
    assert "auto-retired" in slack.deliveries[1].payload["text"]

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


class _FixtureAgentClient:
    def __init__(self, agents: list[dict[str, Any]]) -> None:
        self.agents = agents
        self.queues: list[str] = []

    def list_agents(self, *, queue: str) -> list[dict[str, Any]]:
        self.queues.append(queue)
        return self.agents


def test_buildkite_agents_source_lowercases_gpu_queue_hostnames() -> None:
    client = _FixtureAgentClient(
        [
            {"hostname": "H200-CI-1"},
            {"hostname": "h200-ci-2"},
            {"hostname": "  "},
            {"name": "no-hostname"},
        ]
    )

    source = BuildkiteGpuQueueAgentsSource(buildkite=client)
    assert source.expected_hosts() == frozenset({"h200-ci-1", "h200-ci-2"})
    assert client.queues == ["gpu"]


class _RecordingAgentsClient(BuildkiteRestClient):
    def __init__(self) -> None:
        super().__init__(token="not-used")
        self.urls: list[str] = []

    def _get_json(self, url: str) -> Any:
        self.urls.append(url)
        return []


def test_buildkite_rest_client_queries_the_agents_endpoint_with_queue() -> None:
    client = _RecordingAgentsClient()

    assert client.list_agents(queue="gpu") == []
    assert client.urls == [
        "https://api.buildkite.com/v2/organizations/vllm/agents"
        "?queue=gpu&per_page=100&page=1"
    ]


def test_expected_host_set_is_the_union_of_sources() -> None:
    source = UnionExpectedHostSource(
        [FixtureHosts({"GPU-H100-01"}), FixtureHosts({"h200-ci-1"})]
    )

    assert source.expected_hosts() == frozenset({"gpu-h100-01", "h200-ci-1"})
