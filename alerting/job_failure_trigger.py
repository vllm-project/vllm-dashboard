"""Dry-run quarantine trigger: a pilot host whose recent jobs all failed.

A host trips when its last ``count`` finished jobs (canceled ones ignored)
all failed, and:

- they come from at least ``min_builds`` different builds, so one broken
  build cannot trip a host on its own;
- in each of those builds another host of the same cluster passed a job,
  so the build itself was runnable;
- the other hosts of the cluster failed less than ``pool_failure_ceiling``
  of the jobs they finished in the ``pool_window`` before the host's last
  failure, so a cluster-wide outage is not blamed on one host.

The trigger only produces decisions. Nothing here pauses or taints a host.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Protocol

from alerting.infra import PILOT_QUEUES, QuarantineDecision

FAILED_STATES = frozenset({"failed", "timed_out"})
COUNTED_STATES = FAILED_STATES | {"passed"}


@dataclass(frozen=True)
class FinishedJob:
    host: str
    cluster: str
    pool: str
    build_number: int
    state: str
    finished_at: datetime
    job_id: str = ""

    @property
    def failed(self) -> bool:
        return self.state in FAILED_STATES


@dataclass(frozen=True)
class Trip:
    host: str
    cluster: str
    pool: str
    jobs: tuple[FinishedJob, ...]
    pool_failure_rate: float


def failure_streak_trips(
    jobs: list[FinishedJob],
    *,
    count: int = 10,
    min_builds: int = 3,
    pool_failure_ceiling: float = 0.5,
    pool_window: timedelta = timedelta(minutes=60),
) -> list[Trip]:
    counted = sorted(
        (job for job in jobs if job.state in COUNTED_STATES),
        key=lambda job: job.finished_at,
    )
    by_host: dict[str, list[FinishedJob]] = defaultdict(list)
    passers: dict[tuple[str, int], set[str]] = defaultdict(set)
    for job in counted:
        by_host[job.host].append(job)
        if not job.failed:
            passers[(job.cluster, job.build_number)].add(job.host)

    trips: list[Trip] = []
    for host, host_jobs in by_host.items():
        window = host_jobs[-count:]
        if len(window) < count or not all(job.failed for job in window):
            continue
        cluster = window[-1].cluster
        builds = {job.build_number for job in window}
        if len(builds) < min_builds:
            continue
        if not all(passers[(cluster, build)] - {host} for build in builds):
            continue
        end = window[-1].finished_at
        others = [
            job
            for job in counted
            if job.cluster == cluster
            and job.host != host
            and end - pool_window <= job.finished_at <= end
        ]
        rate = sum(job.failed for job in others) / len(others) if others else 0.0
        if rate >= pool_failure_ceiling:
            continue
        trips.append(Trip(host, cluster, window[-1].pool, tuple(window), rate))
    return sorted(trips, key=lambda trip: trip.host)


def finished_jobs(builds: list[dict[str, Any]]) -> list[FinishedJob]:
    """Map Buildkite builds (jobs embedded) to finished jobs on pilot hosts.

    Jobs with no agent (k8s ``stack_error``) carry no host and are dropped.
    """
    jobs: list[FinishedJob] = []
    for build in builds:
        for job in build.get("jobs") or []:
            if not isinstance(job, dict) or job.get("type") != "script":
                continue
            queue = next(
                (
                    rule.split("=", 1)[1]
                    for rule in job.get("agent_query_rules") or []
                    if rule.startswith("queue=")
                ),
                "",
            )
            agent = job.get("agent") or {}
            finished = job.get("finished_at")
            if queue not in PILOT_QUEUES or not agent or not finished:
                continue
            node = next(
                (
                    item.split("=", 1)[1]
                    for item in agent.get("meta_data") or []
                    if item.startswith("k8s:node=")
                ),
                None,
            )
            # k8s pools name the node only in meta_data; bare metal in hostname.
            host = str(node or agent.get("hostname") or "").lower()
            if not host:
                continue
            jobs.append(
                FinishedJob(
                    host=host,
                    cluster=PILOT_QUEUES[queue],
                    pool=queue,
                    build_number=int(build["number"]),
                    state=str(job.get("state") or ""),
                    finished_at=datetime.fromisoformat(
                        str(finished).replace("Z", "+00:00")
                    ),
                    job_id=str(job.get("id") or ""),
                )
            )
    return jobs


def decisions(trips: list[Trip]) -> list[QuarantineDecision]:
    return [
        QuarantineDecision(
            host=trip.host,
            cluster=trip.cluster,
            pool=trip.pool,
            reason=(
                f"last {len(trip.jobs)} jobs failed across "
                f"{len({job.build_number for job in trip.jobs})} builds"
            ),
            evidence={
                "failed_jobs": len(trip.jobs),
                "builds": sorted({job.build_number for job in trip.jobs}),
                "job_ids": [job.job_id for job in trip.jobs],
                "first_failed_at": trip.jobs[0].finished_at.isoformat(),
                "last_failed_at": trip.jobs[-1].finished_at.isoformat(),
                "pool_failure_rate": round(trip.pool_failure_rate, 3),
            },
        )
        for trip in trips
    ]


class RecentBuildsPort(Protocol):
    def list_job_builds(
        self, *, observed_from: datetime, up_to: datetime, branch: str | None
    ) -> list[dict[str, Any]]: ...


def dry_run_decisions(
    buildkite: RecentBuildsPort,
    *,
    now: datetime,
    lookback: timedelta = timedelta(hours=24),
) -> list[QuarantineDecision]:
    """Fetch recent builds and return the decisions the trigger would make."""
    # ponytail: re-reads a full day of builds per call; low-volume whole-GPU
    # hosts need that much history for 10 jobs. Cache by build if it costs too much.
    # Builds that finished in the window plus those still running, on every
    # branch: what counts is when each job finished, and a recent pass can sit
    # in a build created long before the window.
    builds = buildkite.list_job_builds(
        observed_from=now - lookback, up_to=now, branch=None
    )
    return decisions(failure_streak_trips(finished_jobs(builds)))
