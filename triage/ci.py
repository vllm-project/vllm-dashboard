"""CI status of open PRs: Buildkite's PR build for the head commit, job by job,
and which of its failures are also failing on main.

vLLM's CI is one Buildkite pipeline (vllm/ci). A PR gets a build only when
someone runs `/ci run` (or the `ready` label lets it start); until then the
head commit has no `buildkite/ci...` status on GitHub, and the PR's CI is
"not started". GitHub only shows that one rolled-up status, so the per-job
picture comes from Buildkite: one REST call for the build GitHub points at
(`GET .../builds/<n>`, jobs embedded), made only while the build is unknown
or still running. A finished build is never fetched again.

Whether a failed job also fails on main comes from the Main CI tables the
alerting worker keeps (alerting_main_ci_job_states / _job_alerts, refreshed
every two minutes), matched on the same job key alerting.main_ci builds
(`step:<step key>|name:<step name>`, shard suffixes folded): failing on
main now, or failed on main in the last MAIN_RECENT_DAYS (flaky). No extra
Buildkite polling of main.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Collection, Mapping
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Protocol

from alerting.main_ci import build_job_observations

CiState = Literal["passed", "failed", "running", "canceled", "not_started"]

# Whose move: a finished PR build with a failure main doesn't share is the
# author's to fix (prepass.whose_move adds "ci_pr_failures"). "Main shares
# it" means the same job is failing on main now, or failed on main within
# MAIN_RECENT_DAYS (flaky or just fixed: likely not the PR either). Jobs
# that lost their agent don't count. Set to False to go back to counting
# only pre-commit/DCO (prepass.AUTHOR_CHECKS).
CI_PR_ONLY_FAILURES_WAIT_ON_AUTHOR = True
MAIN_RECENT_DAYS = 7

# Failed jobs (steps) kept per PR; the rest are only counted. The dashboard
# and Slack show fewer.
MAX_FAILED_JOBS = 50

BUILD_URL = re.compile(r"^https://buildkite\.com/vllm/ci/builds/(\d+)")
# GitHub status contexts Buildkite posts for PR builds ("buildkite/ci/pr").
BUILDKITE_CONTEXT = "buildkite/ci"

_PASSED = frozenset({"passed"})
_FAILED = frozenset({"failed", "timed_out"})
# Not finished yet: queued, waiting on dependencies, or running.
_UNFINISHED = frozenset({
    "pending", "waiting", "scheduled", "assigned", "accepted", "reserved", "limited",
    "limiting", "running", "canceling", "timing_out",
})
# Everything else (waiting_failed, blocked, skipped, broken, canceled, expired,
# not_run, ...) never ran or was stopped: not counted.
_RUNNING_BUILD = frozenset({"creating", "scheduled", "running", "failing", "canceling", "blocked"})
_CANCELED_BUILD = frozenset({"canceled", "skipped", "not_run"})


@dataclass
class FailedJob:
    name: str
    key: str
    url: str
    # Jobs of this step that failed (shards of one step fold into one entry).
    count: int = 1
    # The same job is failing on main right now (None: main state unknown).
    on_main: bool | None = None
    # Not failing on main now, but failed there in the last MAIN_RECENT_DAYS.
    recent_on_main: bool = False
    # Lost its agent or never got an exit code: infrastructure, not the PR.
    infra: bool = False


@dataclass
class CiSummary:
    head_sha: str
    state: CiState
    build_number: int | None = None
    build_url: str | None = None
    build_state: str | None = None
    jobs_total: int = 0
    jobs_passed: int = 0
    jobs_running: int = 0
    jobs_failed: int = 0
    # Of jobs_failed: the same job fails on main now / failed on main in the
    # last MAIN_RECENT_DAYS (not now) / main doesn't share it (not infra).
    jobs_failed_on_main: int = 0
    jobs_failed_recent_on_main: int = 0
    jobs_failed_pr_only: int = 0
    # Whether main's job states were readable and fresh when on_main was set.
    main_known: bool = False
    failed_jobs: list[FailedJob] = field(default_factory=list)

    def as_json(self) -> dict[str, Any]:
        return asdict(self)


def build_number_from_url(url: str | None) -> int | None:
    match = BUILD_URL.match(url or "")
    return int(match.group(1)) if match else None


def is_finished(ci: Mapping[str, Any] | None) -> bool:
    return bool(ci) and str((ci or {}).get("state")) in ("passed", "failed", "canceled")


def summarize_build(build: Mapping[str, Any], head_sha: str) -> CiSummary:
    """Counts and failed jobs of one Buildkite build (fetched without retried
    jobs, so each job is its latest attempt). Soft-failed jobs and jobs that
    never ran are not counted."""
    jobs = [j for j in build.get("jobs") or [] if isinstance(j, dict) and j.get("type") == "script"]
    keys = {o.job_id: (o.job_key, o.job_name) for o in build_job_observations(dict(build)) if o.failed}
    passed = running = 0
    failed: dict[str, FailedJob] = {}
    for job in jobs:
        job_state = str(job.get("state") or "")
        if job_state in _PASSED:
            passed += 1
        elif job_state in _UNFINISHED:
            running += 1
        elif job_state in _FAILED and not job.get("soft_failed"):
            name = str(job.get("name") or job.get("step_key") or "?").strip()
            key, step_name = keys.get(str(job.get("id")), (f"name:{name}", name))
            exit_status = job.get("exit_status")
            infra = not isinstance(exit_status, int) or exit_status < 0
            if key in failed:
                failed[key].count += 1
                failed[key].infra = failed[key].infra and infra
            else:
                failed[key] = FailedJob(name=step_name, key=key, url=str(job.get("web_url") or ""), infra=infra)
    n_failed = sum(f.count for f in failed.values())
    build_state = str(build.get("state") or "")
    state: CiState
    if build_state in _CANCELED_BUILD:
        state = "canceled"
    elif build_state in _RUNNING_BUILD and (running or build_state != "blocked"):
        state = "running"
    else:
        # passed / failed, or "blocked" on an optional block step with nothing left to run.
        state = "failed" if n_failed or build_state == "failed" else "passed"
    return CiSummary(
        head_sha=head_sha, state=state, build_number=int(build["number"]) if build.get("number") else None,
        build_url=str(build.get("web_url") or "") or None, build_state=build_state,
        jobs_total=passed + running + n_failed, jobs_passed=passed, jobs_running=running, jobs_failed=n_failed,
        failed_jobs=sorted(failed.values(), key=lambda f: (-f.count, f.name)),
    )


@dataclass(frozen=True)
class MainJobs:
    """Main CI job keys failing now, and those that failed in the last
    MAIN_RECENT_DAYS (a superset in practice)."""

    failing: frozenset[str]
    recent: frozenset[str] = frozenset()


def failing_on_main(key: str, main_failing: Collection[str]) -> bool:
    """The job (same step key and step name) is failing on main. A key with
    a step part also matches a main job of that step when main has exactly
    one job for it (a step renamed in this PR stays unmatched: that is the
    PR's doing)."""
    if key in main_failing:
        return True
    if not key.startswith("step:"):
        return False
    step = key.split("|", 1)[0] + "|"
    same_step = [k for k in main_failing if k.startswith(step)]
    return len(same_step) == 1


def mark_main(summary: CiSummary, main: MainJobs | None) -> CiSummary:
    """Set on_main / recent_on_main per failed job and the counts. `main`
    None: main's state is unknown (unreadable or stale). Failed jobs past
    MAX_FAILED_JOBS, when re-marking a stored summary, count as neither."""
    summary.main_known = main is not None
    on_main = recent = pr_only = 0
    for job in summary.failed_jobs:
        job.on_main = failing_on_main(job.key, main.failing) if main is not None else None
        job.recent_on_main = bool(main and not job.on_main and failing_on_main(job.key, main.recent))
        if job.on_main:
            on_main += job.count
        elif job.recent_on_main:
            recent += job.count
        elif not job.infra:
            pr_only += job.count
    summary.jobs_failed_on_main = on_main
    summary.jobs_failed_recent_on_main = recent
    summary.jobs_failed_pr_only = pr_only if main is not None else 0
    return summary


def summary_from_json(data: Mapping[str, Any]) -> CiSummary:
    fields = {k: data[k] for k in CiSummary.__dataclass_fields__ if k in data and k != "failed_jobs"}
    jobs = [FailedJob(**{k: j[k] for k in FailedJob.__dataclass_fields__ if k in j})
            for j in data.get("failed_jobs") or [] if isinstance(j, Mapping)]
    return CiSummary(**fields, failed_jobs=jobs)


def capped(summary: CiSummary) -> CiSummary:
    summary.failed_jobs = summary.failed_jobs[:MAX_FAILED_JOBS]
    return summary


def ci_waits_on_author(ci: Mapping[str, Any] | None) -> bool:
    """The PR's finished build failed on a job main doesn't share (not
    failing there now or in the last MAIN_RECENT_DAYS, and didn't just lose
    its agent): the author's move. Running builds are not; nor is anything
    when main's state is unknown."""
    return bool(
        CI_PR_ONLY_FAILURES_WAIT_ON_AUTHOR
        and ci
        and ci.get("state") == "failed"
        and ci.get("main_known")
        and int(ci.get("jobs_failed_pr_only") or 0) > 0
    )


def pr_only_job_names(ci: Mapping[str, Any] | None, limit: int = 3) -> list[str]:
    """Names of failed jobs not failing on main (for "why it waits")."""
    jobs = (ci or {}).get("failed_jobs") or []
    return [str(j.get("name")) for j in jobs
            if not j.get("on_main") and not j.get("recent_on_main") and not j.get("infra")][:limit]


class BuildkiteBuildPort(Protocol):
    """alerting.full_ci.BuildkiteRestClient: one build with its jobs."""

    def get_build(self, build_number: int, *, include_retried_jobs: bool = False) -> dict[str, Any]: ...


def next_summary(
    *,
    head_sha: str,
    build_url: str | None,
    stored: Mapping[str, Any] | None,
    main: MainJobs | None,
    fetch: Callable[[int], Mapping[str, Any]] | None,
) -> CiSummary | None:
    """The PR's CI summary now. GitHub says which build the head commit's
    status points at (`build_url`). A finished build already stored for that
    commit is reused, only re-marked against main; otherwise the build is
    fetched. `fetch` None (this run's Buildkite budget is spent): None,
    keep what is stored and try again next run."""
    number = build_number_from_url(build_url)
    if number is None:
        return mark_main(CiSummary(head_sha=head_sha, state="not_started"), main)
    if (
        stored
        and stored.get("head_sha") == head_sha
        and stored.get("build_number") == number
        and is_finished(stored)
    ):
        return mark_main(summary_from_json(stored), main)
    if fetch is None:
        return None
    return capped(mark_main(summarize_build(fetch(number), head_sha), main))
