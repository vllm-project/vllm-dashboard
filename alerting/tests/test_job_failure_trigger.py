"""Job-failure quarantine trigger: rule semantics and Buildkite mapping."""

from datetime import datetime, timedelta, timezone
from typing import Any

from alerting.infra import QuarantineDecision
from alerting.job_failure_trigger import (
    FinishedJob,
    dry_run_decisions,
    failure_streak_trips,
    finished_jobs,
)

T0 = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
CLUSTER = "h200"


def job(host: str, build: int, state: str, minute: int) -> FinishedJob:
    return FinishedJob(
        host=host,
        cluster=CLUSTER,
        pool="h200_35gb",
        build_number=build,
        state=state,
        finished_at=T0 + timedelta(minutes=minute),
        job_id=f"{host}-{build}-{minute}",
    )


def healthy_peer(builds: range) -> list[FinishedJob]:
    # Another host passing one job in each build keeps the build guard satisfied.
    return [job("peer", build, "passed", 0) for build in builds]


def streak(host: str = "bad", n: int = 10, start: int = 1) -> list[FinishedJob]:
    # n failures spread over builds 1..4.
    return [job(host, 1 + i % 4, "failed", start + i) for i in range(n)]


def hosts(jobs: list[FinishedJob]) -> list[str]:
    return [trip.host for trip in failure_streak_trips(jobs)]


def test_ten_failures_across_three_builds_trip() -> None:
    trips = failure_streak_trips(streak() + healthy_peer(range(1, 5)))
    assert [trip.host for trip in trips] == ["bad"]
    assert len(trips[0].jobs) == 10


def test_nine_failures_do_not_trip() -> None:
    assert hosts(streak(n=9) + healthy_peer(range(1, 5))) == []


def test_canceled_jobs_are_ignored() -> None:
    jobs = streak(n=5) + [job("bad", 1, "canceled", 7)] + streak(n=5, start=8)
    assert hosts(jobs + healthy_peer(range(1, 5))) == ["bad"]
    # A canceled job does not count toward the ten either.
    assert (
        hosts(streak(n=9) + [job("bad", 2, "canceled", 20)] + healthy_peer(range(1, 5)))
        == []
    )


def test_timed_out_counts_as_failure() -> None:
    jobs = streak(n=9) + [job("bad", 3, "timed_out", 30)]
    assert hosts(jobs + healthy_peer(range(1, 5))) == ["bad"]


def test_fewer_than_three_builds_do_not_trip() -> None:
    jobs = [job("bad", 1 + i % 2, "failed", i) for i in range(20)]
    assert hosts(jobs + healthy_peer(range(1, 3))) == []


def test_a_pass_resets_the_streak() -> None:
    jobs = streak(n=9) + [job("bad", 2, "passed", 15)] + streak(n=9, start=20)
    assert hosts(jobs + healthy_peer(range(1, 5))) == []
    # Ten more failures after the pass trip again.
    assert hosts(jobs + streak(n=1, start=40) + healthy_peer(range(1, 5))) == ["bad"]


def test_build_with_no_passing_peer_does_not_trip() -> None:
    # Build 4 passed nowhere else: it may simply be broken.
    assert hosts(streak() + healthy_peer(range(1, 4))) == []


def test_cluster_wide_failure_does_not_trip() -> None:
    # Peers fail as often as they pass in the hour before: an outage, not a host.
    peers = healthy_peer(range(1, 5)) + [
        job("peer2", 9, "failed", 5 + i) for i in range(4)
    ]
    assert hosts(streak() + peers) == []


def test_finished_jobs_maps_hosts_and_drops_agentless_jobs() -> None:
    def bk_job(
        queue: str, agent: dict[str, Any] | None, state: str = "failed"
    ) -> dict[str, Any]:
        return {
            "id": "j",
            "type": "script",
            "state": state,
            "agent_query_rules": [f"queue={queue}"],
            "agent": agent,
            "finished_at": "2026-10-01T12:00:00Z",
        }

    builds = [
        {
            "number": 7,
            "jobs": [
                bk_job(
                    "h200_35gb",
                    {"hostname": "gpu-host-c", "meta_data": ["queue=h200_35gb"]},
                ),
                bk_job(
                    "mithril-h100-pool",
                    {
                        "hostname": "buildkite-pod-x",
                        "meta_data": ["k8s:node=k8s-node-1"],
                    },
                ),
                bk_job(
                    "b200-k8s",
                    {"hostname": "K8S-Node-2", "meta_data": ["k8s:node=k8s-node-2"]},
                ),
                bk_job("b200-k8s", None),  # stack_error: no agent, no host
                bk_job("cpu_queue_premerge", {"hostname": "ip-10-0-0-1"}),
            ],
        }
    ]
    mapped = finished_jobs(builds)
    assert [(j.host, j.cluster, j.pool) for j in mapped] == [
        ("gpu-host-c", "h200", "h200_35gb"),
        ("k8s-node-1", "h100", "mithril-h100-pool"),
        ("k8s-node-2", "b200", "b200-k8s"),
    ]


def test_dry_run_decisions_from_buildkite_builds() -> None:
    def build(number: int, host: str, state: str, minute: int) -> dict[str, Any]:
        return {
            "number": number,
            "jobs": [
                {
                    "id": f"{host}-{number}-{minute}",
                    "type": "script",
                    "state": state,
                    "agent_query_rules": ["queue=h200_18gb"],
                    "agent": {"hostname": host, "meta_data": []},
                    "finished_at": (T0 + timedelta(minutes=minute)).isoformat(),
                }
            ],
        }

    builds = [build(1 + i % 3, "gpu-host-a", "failed", i) for i in range(10)]
    builds += [build(n, "gpu-host-b", "passed", 0) for n in (1, 2, 3)]

    class FakeBuildkite:
        def list_job_builds(
            self, *, observed_from: datetime, up_to: datetime, branch: str | None
        ) -> list[dict[str, Any]]:
            assert up_to - observed_from == timedelta(hours=24)
            assert branch is None
            return builds

    [decision] = dry_run_decisions(FakeBuildkite(), now=T0 + timedelta(hours=1))
    assert (decision.host, decision.cluster, decision.pool) == (
        "gpu-host-a",
        "h200",
        "h200_18gb",
    )
    assert decision.reason == "last 10 jobs failed across 3 builds"
    assert decision.hardware is False  # job failures are not a hardware rule
    assert isinstance(decision, QuarantineDecision)
    assert decision.evidence["builds"] == [1, 2, 3]
    assert decision.evidence["failed_jobs"] == 10
