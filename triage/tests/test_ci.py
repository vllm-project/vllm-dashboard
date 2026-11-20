"""PR CI status (triage/ci.py): job counts from a Buildkite build, matching
failed jobs against main, whose move, the Slack fragment, and the ingest
refresh that ties GitHub, Buildkite and the store together."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from alerting.commands import ScheduledCommand
from triage import ci as ci_module
from triage.ci import (
    CiSummary,
    MainJobs,
    ci_waits_on_author,
    failing_on_main,
    mark_main,
    next_summary,
    summarize_build,
)
from triage.config import default_config
from triage.github import PrStatus
from triage.github_graphql import head_commit
from triage.notify import _item_line, _waiting_line, ci_fragment
from triage.pipeline import IngestHandler
from triage.prepass import whose_move
from triage.store import DigestEntry, StoredItemState

NOW = datetime(2026, 11, 20, 9, 0, tzinfo=timezone.utc)
SHA = "21ab14cb702a19808abe9a9c622bb98172718a6e"
BUILD_URL = "https://buildkite.com/vllm/ci/builds/104586"


def job(name: str, state: str, step_key: str | None = None, **kw: Any) -> dict[str, Any]:
    n = job.counter = getattr(job, "counter", 0) + 1  # type: ignore[attr-defined]
    out = {
        "id": f"job-{n}", "type": "script", "name": name, "step_key": step_key, "state": state,
        "web_url": f"{BUILD_URL}#job-{n}", "soft_failed": False,
        "exit_status": 1 if state in ("failed", "timed_out") else (0 if state == "passed" else None),
        "finished_at": "2026-11-20T08:30:00Z" if state in ("passed", "failed", "timed_out") else None,
    }
    out.update(kw)
    return out


def build(state: str, jobs: list[dict[str, Any]], number: int = 104586) -> dict[str, Any]:
    return {"id": f"b-{number}", "number": number, "state": state, "commit": SHA,
            "web_url": f"https://buildkite.com/vllm/ci/builds/{number}", "message": "PR #68900 /ci run",
            "jobs": [{"type": "manual", "state": "blocked", "name": None}, *jobs]}


FAILED_BUILD = build("failed", [
    *[job(f":nvidia: Passing {i}", "passed", f"p{i}") for i in range(38)],
    job(":nvidia: (H200) Multimodal Processor Shard 1/4", "failed", "mm-processor",
        parallel_group_index=0, parallel_group_total=4),
    job(":nvidia: (H200) Multimodal Processor Shard 2/4", "failed", "mm-processor",
        parallel_group_index=1, parallel_group_total=4),
    job(":github: GitHub pre-commit check", "failed", "pre-commit"),
    job("Intel HPU Test", "failed", "intel-hpu", soft_failed=True),  # soft fail: not counted
    job(":docker: Lost agent", "failed", "lost", exit_status=-1),     # infra
    job(":nvidia: Downstream", "waiting_failed", "downstream"),       # never ran: not counted
])
MAIN_KEYS = frozenset({
    "step:mm-processor|name::nvidia: (H200) Multimodal Processor",
    "step:other|name:Other",
})
MAIN_FAILING = MainJobs(failing=MAIN_KEYS, recent=MAIN_KEYS)


def main(failing: set[str] | frozenset[str], recent: set[str] | frozenset[str] = frozenset()) -> MainJobs:
    return MainJobs(failing=frozenset(failing), recent=frozenset(failing) | frozenset(recent))


def test_counts_and_failed_jobs_of_a_finished_build() -> None:
    summary = summarize_build(FAILED_BUILD, SHA)
    assert (summary.state, summary.jobs_total, summary.jobs_passed, summary.jobs_running, summary.jobs_failed) == (
        "failed", 42, 38, 0, 4)
    jobs = {j.key: (j.name, j.count, j.infra) for j in summary.failed_jobs}
    assert jobs == {
        # Shards of one step fold into one entry, keyed as Main CI keys it.
        "step:mm-processor|name::nvidia: (H200) Multimodal Processor": (":nvidia: (H200) Multimodal Processor", 2, False),
        "step:pre-commit|name::github: GitHub pre-commit check": (":github: GitHub pre-commit check", 1, False),
        "step:lost|name::docker: Lost agent": (":docker: Lost agent", 1, True),
    }
    mark_main(summary, MAIN_FAILING)
    assert (summary.jobs_failed_on_main, summary.jobs_failed_pr_only, summary.main_known) == (2, 1, True)
    assert ci_waits_on_author(summary.as_json())  # pre-commit fails only here
    # Main unknown: nothing is "PR only", so nobody is blamed.
    unknown = mark_main(summarize_build(FAILED_BUILD, SHA), None)
    assert (unknown.jobs_failed_pr_only, unknown.main_known) == (0, False)
    assert {j.on_main for j in unknown.failed_jobs} == {None}
    assert not ci_waits_on_author(unknown.as_json())


def test_build_states() -> None:
    running = summarize_build(build("failing", [job("a", "passed"), job("b", "running"), job("c", "waiting"),
                                                job("d", "failed")]), SHA)
    assert (running.state, running.jobs_total, running.jobs_passed, running.jobs_running, running.jobs_failed) == (
        "running", 4, 1, 2, 1)
    # A failing but unfinished build is not the author's move yet.
    assert not ci_waits_on_author(mark_main(running, main(set())).as_json())
    # "blocked" on the optional "run more jobs" step with nothing left to run: done.
    assert summarize_build(build("blocked", [job("a", "passed")]), SHA).state == "passed"
    assert summarize_build(build("blocked", [job("a", "passed"), job("b", "running")]), SHA).state == "running"
    assert summarize_build(build("canceled", [job("a", "passed"), job("b", "canceled")]), SHA).state == "canceled"
    assert summarize_build(build("passed", [job("a", "passed"), job("x", "failed", soft_failed=True)]), SHA).state == "passed"


def test_matching_failed_jobs_against_main() -> None:
    key = "step:mm-processor|name::nvidia: (H200) Multimodal Processor"
    assert failing_on_main(key, MAIN_KEYS)
    # Same step, renamed (one main job for that step): still the same job.
    assert failing_on_main("step:other|name:Other (renamed)", MAIN_KEYS)
    # A matrix step with several cells failing on main: only an exact match counts.
    matrix = frozenset({"step:m|name:cell A", "step:m|name:cell B"})
    assert failing_on_main("step:m|name:cell A", matrix)
    assert not failing_on_main("step:m|name:cell C", matrix)
    assert not failing_on_main("name:no step key", MAIN_KEYS)


def test_all_failures_also_on_main_is_not_the_authors_move() -> None:
    summary = mark_main(summarize_build(build("failed", [
        job("ok", "passed", "ok"), job("broken on main", "failed", "other")]), SHA),
        main({"step:other|name:broken on main"}))
    assert (summary.jobs_failed, summary.jobs_failed_on_main, summary.jobs_failed_pr_only) == (1, 1, 0)
    assert not ci_waits_on_author(summary.as_json())


def test_a_job_that_failed_on_main_this_week_is_not_blamed_on_the_pr() -> None:
    pre_commit = "step:pre-commit|name::github: GitHub pre-commit check"
    summary = mark_main(summarize_build(FAILED_BUILD, SHA), main(MAIN_KEYS, recent={pre_commit}))
    assert (summary.jobs_failed_on_main, summary.jobs_failed_recent_on_main, summary.jobs_failed_pr_only) == (2, 1, 0)
    assert [j.recent_on_main for j in summary.failed_jobs if j.key == pre_commit] == [True]
    assert not ci_waits_on_author(summary.as_json())
    assert ci_fragment(summary.as_json()) == "CI: 38/42 ✓, 4 ✗ (2 also failing on main, 1 flaky on main)"
    assert ci_fragment(summary.as_json(), "vi") == "CI: 38/42 ✓, 4 ✗ (2 cũng lỗi trên main, 1 chập chờn trên main)"


def test_next_summary_fetches_only_what_it_must() -> None:
    fetched: list[int] = []

    def fetch(number: int) -> dict[str, Any]:
        fetched.append(number)
        return FAILED_BUILD

    not_started = next_summary(head_sha=SHA, build_url=None, stored=None, main=MAIN_FAILING, fetch=fetch)
    assert not_started is not None and not_started.state == "not_started" and fetched == []
    first = next_summary(head_sha=SHA, build_url=BUILD_URL, stored=None, main=MAIN_FAILING, fetch=fetch)
    assert first is not None and fetched == [104586]
    # Finished and stored for this commit: re-marked against main, not fetched.
    again = next_summary(head_sha=SHA, build_url=BUILD_URL, stored=first.as_json(), main=main(set()),
                         fetch=fetch)
    assert again is not None and fetched == [104586]
    assert (again.jobs_failed_on_main, again.jobs_failed_pr_only) == (0, 3)
    # A newer build for the commit (another `/ci run`): fetched; none left in the budget: keep what's stored.
    newer = "https://buildkite.com/vllm/ci/builds/104600"
    assert next_summary(head_sha=SHA, build_url=newer, stored=first.as_json(), main=None, fetch=None) is None
    next_summary(head_sha=SHA, build_url=newer, stored=first.as_json(), main=None, fetch=fetch)
    assert fetched == [104586, 104600]


def test_failed_jobs_are_capped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ci_module, "MAX_FAILED_JOBS", 2)
    many = build("failed", [job(f"f{i}", "failed", f"f{i}") for i in range(5)])
    summary = next_summary(head_sha=SHA, build_url=BUILD_URL, stored=None, main=main({"step:f4|name:f4"}),
                           fetch=lambda n: many)
    assert summary is not None
    assert (len(summary.failed_jobs), summary.jobs_failed, summary.jobs_failed_on_main, summary.jobs_failed_pr_only) == (
        2, 5, 1, 4)


def test_head_commit_reads_the_buildkite_status() -> None:
    commits = {"nodes": [{"commit": {"oid": SHA, "status": {"contexts": [
        {"context": "docs/readthedocs.org:vllm", "state": "SUCCESS", "targetUrl": "https://app.readthedocs.org/x"},
        {"context": "buildkite/ci/pr", "state": "PENDING", "targetUrl": "https://buildkite.com/vllm/ci/builds/104580"},
        {"context": "buildkite/ci/pr", "state": "FAILURE", "targetUrl": BUILD_URL},
    ]}}}]}
    assert head_commit(commits) == (SHA, BUILD_URL)
    assert head_commit({"nodes": [{"commit": {"oid": SHA, "status": None}}]}) == (SHA, None)
    assert head_commit(None) == (None, None)


def test_whose_move_with_ci() -> None:
    failed = mark_main(summarize_build(FAILED_BUILD, SHA), MAIN_FAILING).as_json()
    fields = whose_move(draft=False, review_decision=None, mergeable="MERGEABLE", failing_checks=[], ci=failed)
    assert fields == {"waiting_on": "author", "waiting_reasons": ["ci_pr_failures"], "mergeable": "MERGEABLE",
                      "failing_checks": [], "ci_pr_only_jobs": [":github: GitHub pre-commit check"]}
    on_main = mark_main(summarize_build(FAILED_BUILD, SHA), main(MAIN_KEYS | {
        "step:pre-commit|name::github: GitHub pre-commit check"})).as_json()
    assert whose_move(draft=False, review_decision=None, mergeable="MERGEABLE", failing_checks=[], ci=on_main) == {
        "waiting_on": "reviewer", "waiting_reasons": [], "mergeable": "MERGEABLE",
        "failing_checks": [], "ci_pr_only_jobs": []}


def test_the_rule_can_be_switched_off(monkeypatch: pytest.MonkeyPatch) -> None:
    failed = mark_main(summarize_build(FAILED_BUILD, SHA), MAIN_FAILING).as_json()
    monkeypatch.setattr(ci_module, "CI_PR_ONLY_FAILURES_WAIT_ON_AUTHOR", False)
    assert whose_move(draft=False, review_decision=None, mergeable=None, failing_checks=[], ci=failed)["waiting_on"] == "reviewer"


def test_slack_fragment() -> None:
    failed = mark_main(summarize_build(FAILED_BUILD, SHA), MAIN_FAILING).as_json()
    assert ci_fragment(failed) == "CI: 38/42 ✓, 4 ✗ (2 also failing on main)"
    assert ci_fragment(failed, "vi") == "CI: 38/42 ✓, 4 ✗ (2 cũng lỗi trên main)"
    all_main = {**failed, "jobs_failed_on_main": 4}
    assert ci_fragment(all_main) == "CI: 38/42 ✓, 4 ✗ (also failing on main)"
    assert ci_fragment(all_main, "vi") == "CI: 38/42 ✓, 4 ✗ (cũng lỗi trên main)"
    assert ci_fragment({**failed, "jobs_failed_on_main": 0}) == "CI: 38/42 ✓, 4 ✗ (only on this PR)"
    assert ci_fragment({**failed, "main_known": False}) == "CI: 38/42 ✓, 4 ✗"
    running = CiSummary(head_sha=SHA, state="running", jobs_total=41, jobs_passed=20, jobs_running=21).as_json()
    assert ci_fragment(running) == "CI: 20/41 ✓, 21 running"
    assert ci_fragment(running, "vi") == "CI: 20/41 ✓, 21 đang chạy"
    assert ci_fragment(CiSummary(head_sha=SHA, state="passed", jobs_total=41, jobs_passed=41).as_json()) == "CI: 41/41 ✓"
    assert ci_fragment({"state": "not_started"}, "vi") == "CI: chưa chạy"
    assert ci_fragment(None) == ""
    entry = DigestEntry(1, "vllm-project/vllm#68900", "Fix MoE", "https://github.com/vllm-project/vllm/pull/68900",
                        80, "route", "", [], ci=running, assigned_at=NOW - timedelta(days=4))
    assert "\nCI: 20/41 ✓, 21 running" in _item_line(entry)
    assert _waiting_line(entry, NOW, "en").endswith(" · CI: 20/41 ✓, 21 running")


# --- the ingest refresh -------------------------------------------------------


class Store:
    def __init__(self) -> None:
        self.waiting: list[tuple[str, int, dict[str, Any]]] = []
        self.due: list[tuple[str, int, dict[str, Any]]] = []
        self.ci: dict[str, dict[str, Any]] = {}
        self.main: MainJobs | None = MAIN_FAILING
        self.prepass_updates: list[tuple[str, dict[str, Any]]] = []

    def cursor(self, name: str) -> datetime | None:
        return NOW

    def set_cursor(self, name: str, value: datetime) -> None:
        pass

    def item_state(self, key: str) -> StoredItemState | None:
        return None

    def waiting_prs(self, repo: str, *, limit: int) -> list[tuple[str, int, dict[str, Any]]]:
        return self.waiting

    def ci_due(self, repo: str, *, now: datetime, limit: int) -> list[tuple[str, int, dict[str, Any]]]:
        return self.due[:limit]

    def pr_ci(self, keys: Any) -> dict[str, dict[str, Any]]:
        return {k: self.ci[k] for k in keys if k in self.ci}

    def save_pr_ci(self, item_key: str, ci: dict[str, Any], *, now: datetime) -> None:
        self.ci[item_key] = ci

    def main_ci_jobs(self, *, now: datetime) -> MainJobs | None:
        return self.main

    def update_prepass(self, item_key: str, fields: dict[str, Any]) -> None:
        self.prepass_updates.append((item_key, fields))


class GitHub:
    reads_pr_status = True

    def __init__(self, statuses: dict[int, PrStatus]) -> None:
        self.statuses = statuses
        self.asked: list[list[int]] = []

    def updated_items(self, repo: str, since: datetime, *, max_items: int) -> list[Any]:
        return []

    def prefetch(self, repo: str, **kw: Any) -> None:
        pass

    def pr_statuses(self, repo: str, numbers: list[int]) -> dict[int, PrStatus]:
        self.asked.append(numbers)
        return {n: s for n, s in self.statuses.items() if n in numbers}


class Buildkite:
    def __init__(self, builds: dict[int, dict[str, Any]]) -> None:
        self.builds = builds
        self.fetched: list[int] = []

    def get_build(self, build_number: int, *, include_retried_jobs: bool = False) -> dict[str, Any]:
        self.fetched.append(build_number)
        if build_number not in self.builds:
            raise RuntimeError("GET /builds failed with HTTP 404")
        return self.builds[build_number]


def status(head: str = SHA, build_url: str | None = BUILD_URL, **kw: Any) -> PrStatus:
    return PrStatus(state=kw.pop("state", "open"), draft=False, review_decision=None, mergeable="MERGEABLE",
                    failing_checks=[], head_sha=head, ci_build_url=build_url)


def test_ingest_refreshes_ci_and_whose_move() -> None:
    store = Store()
    reviewer = {"waiting_on": "reviewer", "waiting_reasons": [], "mergeable": "MERGEABLE", "failing_checks": []}
    store.due = [("k1", 1, dict(reviewer)), ("k2", 2, dict(reviewer)), ("k3", 3, dict(reviewer)),
                 ("k4", 4, dict(reviewer))]
    store.waiting = [("k5", 5, {"waiting_on": "author", "waiting_reasons": ["draft"], "failing_checks": []})]
    github = GitHub({1: status(), 2: status(build_url=None), 3: status(build_url="https://buildkite.com/vllm/ci/builds/9"),
                     4: status(state="merged"), 5: status(build_url=None)})
    buildkite = Buildkite({104586: FAILED_BUILD})
    handler = IngestHandler(store=store, github=github, config=default_config(), clock=type("C", (), {  # type: ignore[arg-type]
        "now": staticmethod(lambda: NOW)})(), buildkite=buildkite)
    handler(ScheduledCommand("triage_ingest", NOW))
    assert github.asked == [[1, 2, 3, 4, 5]]  # one batch: waiting PRs and PRs due a CI check
    assert buildkite.fetched == [104586, 9]
    assert (store.ci["k1"]["state"], store.ci["k1"]["jobs_failed_pr_only"]) == ("failed", 1)
    assert store.ci["k2"]["state"] == "not_started"
    assert "k3" not in store.ci  # Buildkite error: kept as it was, logged
    # k1 fails a job main doesn't: the author's move. k2 (CI not started)
    # gets the new, empty ci_pr_only_jobs once. k5 isn't due a CI check and
    # has no CI row, so only its GitHub state counts (no longer a draft).
    assert sorted(store.prepass_updates) == [
        ("k1", {"waiting_on": "author", "waiting_reasons": ["ci_pr_failures"], "mergeable": "MERGEABLE",
                "failing_checks": [], "ci_pr_only_jobs": [":github: GitHub pre-commit check"]}),
        ("k2", {"waiting_on": "reviewer", "waiting_reasons": [], "mergeable": "MERGEABLE",
                "failing_checks": [], "ci_pr_only_jobs": []}),
        ("k5", {"waiting_on": "reviewer", "waiting_reasons": [], "mergeable": "MERGEABLE", "failing_checks": []}),
    ]

    # Next run: k1's finished build isn't fetched again; main now fails pre-commit too.
    store.prepass_updates.clear()
    store.due = [("k1", 1, {"waiting_on": "author", "waiting_reasons": ["ci_pr_failures"], "mergeable": "MERGEABLE",
                            "failing_checks": [], "ci_pr_only_jobs": [":github: GitHub pre-commit check"]})]
    store.waiting = []
    store.main = main(MAIN_KEYS | {"step:pre-commit|name::github: GitHub pre-commit check",
                                   "step:lost|name::docker: Lost agent"})
    handler(ScheduledCommand("triage_ingest", NOW))
    assert buildkite.fetched == [104586, 9]
    assert store.ci["k1"]["jobs_failed_on_main"] == 4
    assert store.prepass_updates == [("k1", {"waiting_on": "reviewer", "waiting_reasons": [], "mergeable": "MERGEABLE",
                                             "failing_checks": [], "ci_pr_only_jobs": []})]

    # A new commit: the stored CI is for the old one and doesn't count.
    store.prepass_updates.clear()
    store.main = None
    github.statuses = {1: status(head="f" * 40, build_url=None)}
    handler(ScheduledCommand("triage_ingest", NOW))
    k1 = store.ci["k1"]
    assert (k1["head_sha"], k1["state"], k1["main_known"]) == ("f" * 40, "not_started", False)


def test_build_fetches_per_run_are_capped() -> None:
    store = Store()
    store.due = [(f"k{n}", n, {}) for n in range(1, 6)]
    github = GitHub({n: status(build_url=f"https://buildkite.com/vllm/ci/builds/{100 + n}") for n in range(1, 6)})
    buildkite = Buildkite({100 + n: build("running", [job("a", "running")], number=100 + n) for n in range(1, 6)})
    IngestHandler(store=store, github=github, config=default_config(),  # type: ignore[arg-type]
                  clock=type("C", (), {"now": staticmethod(lambda: NOW)})(), buildkite=buildkite,
                  ci_build_fetch_limit=2)(ScheduledCommand("triage_ingest", NOW))
    assert buildkite.fetched == [101, 102]
    assert sorted(store.ci) == ["k1", "k2"]  # the rest stay due for the next run


def test_without_buildkite_nothing_changes() -> None:
    store = Store()
    store.due = [("k1", 1, {})]
    github = GitHub({1: status()})
    IngestHandler(store=store, github=github, config=default_config(),  # type: ignore[arg-type]
                  clock=type("C", (), {"now": staticmethod(lambda: NOW)})())(ScheduledCommand("triage_ingest", NOW))
    assert github.asked == [] and store.ci == {}


def test_ci_on_grouped_digest_lines() -> None:
    issue = DigestEntry(1, "vllm-project/vllm#100", "Crash", "https://github.com/vllm-project/vllm/issues/100",
                        90, "page", "", [], kind="issue")
    fix = DigestEntry(2, "vllm-project/vllm#101", "Fix crash", "https://github.com/vllm-project/vllm/pull/101",
                      60, "route", "", [], kind="pr", fixes=("vllm-project/vllm#100",),
                      ci=CiSummary(head_sha=SHA, state="passed", jobs_total=41, jobs_passed=41).as_json())
    line = _item_line(issue, fixes=[fix])
    assert "↳ fix: <https://github.com/vllm-project/vllm/pull/101|#101 Fix crash> · CI: 41/41 ✓" in line
    assert "· CI: 41/41 ✓" in _waiting_line(issue, NOW, "vi", fixes=[fix])
