"""CI selector health through the scheduled-command seam."""

from __future__ import annotations

import gzip
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from alerting.commands import ScheduledCommand
from alerting.memory import (
    FixedClock,
    InMemoryAutomationExecutionStore,
    InMemoryOutboxStore,
    InMemorySelectorHealthStore,
    RecordingSlackPort,
)
from alerting.ports import AlertPath, DeliveryMode
from alerting.runtime import AlertingRuntime, ProcessStatus
from alerting.selector_health import (
    DEFAULT_THRESHOLDS,
    BuildkiteSelectorSource,
    Component,
    ComponentStatus,
    DecisionOutcome,
    FullRunRecord,
    RecordingReading,
    RunComponent,
    SelectorAlertEpisode,
    SelectorDecision,
    SelectorHealthHandler,
    SelectorHealthThresholds,
    decision_kernel_builds,
    fnrec_summary_reading,
    grade_rows,
    kernel_table_stats,
    kernrec_summary_readings,
    map_component,
    parse_decision,
    parse_fnrec_log,
    parse_kernrec_log,
    plan_selector_health,
    recording_component,
    render_open,
    selector_notifications,
    source_map_stats,
)

# 2026-10-30 23:45 UTC: the 16:45 Pacific scan after the day's daily run.
NOW = datetime(2026, 10, 30, 23, 45, tzinfo=timezone.utc)
SHA = "665bfc8aaeb7eca008ca4102cbba68efdc4efabb"


def stamp(line: str) -> str:
    """A raw Buildkite log line: timestamp marker, ANSI color, line stamp."""
    return f"_bk;t=1761641783000\x07\x1b[32m[2026-10-28T08:56:23Z]\x1b[0m {line}"


KERNREC_97886_LOG = "\n".join(
    stamp(line)
    for line in [
        'Successfully downloaded "kernel_symbol_map.rocm.json.gz" 780 KiB',
        "15399 recording files from 300 jobs",
        "wrote out/kernel_table.json.gz (0 KiB): {'steps': 0, 'unique_kernels': 0, "
        "'processes': 0, 'rows_usable': 0, 'rows_incomplete': 0, 'rows_with_drops': 0}",
        '  "rows_usable": 0,',
        "cuda has no valid table/map pair; retaining artifacts without publishing",
        "wrote out/kernel_table.rocm.json.gz (297 KiB): {'steps': 215, "
        "'unique_kernels': 8047, 'processes': 15399, 'rows_usable': 193, "
        "'rows_incomplete': 0, 'rows_with_drops': 0}",
        f"published; latest.rocm.json -> {SHA}",
    ]
)
# The 2026-10-24..30 outage: a setup script broke under /bin/sh, so no job
# delivered a CUDA kernel recording, and the collect still passed.
KERNREC_OUTAGE_LOG = "\n".join(
    stamp(line) for line in ["0 recording files from 0 jobs", "nothing to fold; done"]
)
KERNREC_96933_LOG = "\n".join(
    stamp(line)
    for line in [
        "6872 recording files from 386 jobs",
        "wrote out/kernel_table.json.gz (434 KiB): {'steps': 250, "
        "'unique_kernels': 19704, 'processes': 6872, 'rows_usable': 243, "
        "'rows_incomplete': 0, 'rows_with_drops': 0}",
        "published; latest.json -> 7651825993d001759107c66cdf6983535900c874",
    ]
)
FNREC_98403_LOG = "\n".join(
    stamp(line)
    for line in [
        "expecting 678 jobs",
        "build-98403: 668/678 started jobs recorded (0.99)   no dir 0",
        "",
        "439 rows (0 keyless)",
        "  wrote out/table.json.gz",
        "published; latest.json -> b91df5a9f76a7b0b574e6918f31860484bdef231",
    ]
)


# --- Log and summary parsing -----------------------------------------------


def test_kernel_log_of_build_97886_publishes_rocm_but_not_cuda() -> None:
    readings = parse_kernrec_log(KERNREC_97886_LOG)

    cuda = readings[Component.KERNREC_CUDA]
    assert cuda.armed and not cuda.published
    assert cuda.rows == 0
    assert cuda.verdict == "no valid table/map pair"
    rocm = readings[Component.KERNREC_ROCM]
    assert rocm.armed and rocm.published
    assert (rocm.rows, rocm.usable_rows) == (215, 193)
    assert rocm.published_commit == SHA
    assert rocm.verdict == "ok"


def test_kernel_log_with_nothing_to_fold_arms_cuda_and_leaves_rocm_off() -> None:
    readings = parse_kernrec_log(KERNREC_OUTAGE_LOG)

    cuda = readings[Component.KERNREC_CUDA]
    assert cuda.armed and not cuda.published
    assert cuda.delivered_jobs == 0
    assert cuda.verdict == "nothing to fold (0 jobs delivered recordings)"
    assert not readings[Component.KERNREC_ROCM].armed


def test_kernel_log_before_rocm_publishes_cuda_only() -> None:
    readings = parse_kernrec_log(KERNREC_96933_LOG)

    assert readings[Component.KERNREC_CUDA].published
    assert readings[Component.KERNREC_CUDA].rows == 250
    assert readings[Component.KERNREC_CUDA].usable_rows == 243
    assert not readings[Component.KERNREC_ROCM].armed


def test_python_log_reads_expected_delivered_rows_and_publish() -> None:
    reading = parse_fnrec_log(FNREC_98403_LOG)

    assert reading == RecordingReading(
        armed=True,
        expected_jobs=678,
        delivered_jobs=668,
        rows=439,
        verdict="ok",
        published=True,
        published_commit="b91df5a9f76a7b0b574e6918f31860484bdef231",
    )


@pytest.mark.parametrize(
    ("line", "verdict"),
    [
        ("nothing to fold; done", "nothing to fold"),
        ("table has no usable rows", "table has no usable rows"),
        (
            "REFUSING to publish: 12 rows short on shards",
            "REFUSING to publish: 12 rows short on shards",
        ),
    ],
)
def test_python_log_without_a_publish_keeps_its_reason(line: str, verdict: str) -> None:
    reading = parse_fnrec_log(stamp(line))

    assert not reading.published
    assert reading.verdict == verdict


def test_kernel_summary_grades_each_backend_on_its_own_verdict() -> None:
    readings = kernrec_summary_readings(
        {
            "recorder": "kernrec",
            "build": 99001,
            "commit": SHA,
            "backends": {
                "cuda": {
                    "expected_jobs": 250,
                    "delivered_jobs": 0,
                    "usable_rows": 0,
                    "verdict": "no recordings delivered",
                },
                "rocm": {
                    "expected_jobs": 215,
                    "delivered_jobs": 215,
                    "usable_rows": 193,
                    "verdict": "ok",
                },
            },
        }
    )

    assert readings[Component.KERNREC_CUDA] == RecordingReading(
        armed=True,
        expected_jobs=250,
        delivered_jobs=0,
        usable_rows=0,
        verdict="no recordings delivered",
    )
    assert readings[Component.KERNREC_ROCM].published
    assert readings[Component.KERNREC_ROCM].published_commit == SHA


def test_kernel_summary_with_no_expected_jobs_leaves_the_backend_off() -> None:
    readings = kernrec_summary_readings(
        {
            "backends": {
                "cuda": {"expected_jobs": 10, "delivered_jobs": 10, "usable_rows": 9, "verdict": "ok"},
                "rocm": {"expected_jobs": 0, "delivered_jobs": 0, "usable_rows": 0, "verdict": "not armed"},
            }
        }
    )

    assert not readings[Component.KERNREC_ROCM].armed


def test_python_summary_short_on_jobs_is_broken() -> None:
    reading = fnrec_summary_reading(
        {
            "recorder": "fnrec",
            "build": 99001,
            "commit": SHA,
            "expected_jobs": 678,
            "delivered_jobs": 500,
            "rows": 400,
            "verdict": "ok",
            "exit_status": 0,
        }
    )
    graded = recording_component(
        Component.FNREC,
        {"state": "passed", "soft_failed": False, "exit_status": 0},
        reading,
        source="summary",
        blame_job=True,
    )

    assert graded.status == ComponentStatus.BROKEN
    assert graded.verdict == "delivered 500 of 678 expected jobs"


def test_soft_failed_collect_is_broken_even_with_an_ok_verdict() -> None:
    graded = recording_component(
        Component.FNREC,
        {"state": "failed", "soft_failed": True, "exit_status": 1},
        RecordingReading(armed=True, verdict="ok", published=True, rows=3),
        source="log",
        blame_job=True,
    )

    assert graded.status == ComponentStatus.BROKEN
    assert graded.verdict == "collect job failed (soft-failed), exit 1"


def test_decision_outcomes_and_record_builds() -> None:
    applied = parse_decision(
        {
            "applied": True,
            "skipped": None,
            "fallback": None,
            "seconds": 274.6,
            "ci_infra_commit": "40a0cb04104ed6b102c7833b951a5ca204b29f72",
            "records": {
                "fnrec": {"build": 98403, "commit": "b91df5a"},
                "kernrec": {"build": 96933, "commit": "7651825"},
            },
        },
        build_number=98641,
        created_at=NOW,
        branch="brandonpelfrey:pynvvideocodec-decoder-caps-cache",
        pull_request=64618,
    )
    assert applied.outcome == DecisionOutcome.APPLIED
    assert (applied.fnrec_build, applied.kernrec_build) == (98403, 96933)
    assert applied.seconds == 274.6

    skipped = parse_decision(
        {"applied": False, "skipped": "steps named explicitly by VLLM_CI_ONLY_STEP_KEYS"},
        build_number=98639,
        created_at=NOW,
        branch="refs/pull/64181/head",
        pull_request=None,
    )
    assert skipped.outcome == DecisionOutcome.SKIPPED
    assert skipped.reason == "steps named explicitly by VLLM_CI_ONLY_STEP_KEYS"

    fallback = parse_decision(
        {"applied": False, "fallback": "selector failed: exit 1"},
        build_number=1,
        created_at=NOW,
        branch="a:b",
        pull_request=None,
    )
    assert fallback.outcome == DecisionOutcome.FALLBACK

    missing = parse_decision(
        None, build_number=2, created_at=NOW, branch="a:docs", pull_request=7
    )
    assert missing.outcome == DecisionOutcome.MISSING


# --- Planner ---------------------------------------------------------------


def ok(component: Component, *, rows: int = 400, published: bool = True) -> RunComponent:
    return RunComponent(
        component.value,
        ComponentStatus.OK.value,
        job_state="passed",
        rows=rows,
        verdict="ok",
        published=published,
        source="log",
    )


def broken(component: Component, verdict: str, **fields: Any) -> RunComponent:
    return RunComponent(
        component.value,
        ComponentStatus.BROKEN.value,
        job_state="passed",
        verdict=verdict,
        source="log",
        **fields,
    )


def off(component: Component) -> RunComponent:
    return RunComponent(component.value, ComponentStatus.OFF.value)


def run(
    build_number: int,
    created_at: datetime,
    *components: RunComponent,
    settled: bool = True,
) -> FullRunRecord:
    kind = "nightly" if created_at.hour == 6 else "daily"
    return FullRunRecord(
        build_number=build_number,
        kind=kind,
        created_at=created_at,
        commit_sha=SHA,
        build_state="failed",
        settled=settled,
        components=components,
    )


def at(day: int, hour: int) -> datetime:
    return datetime(2026, 10, day, hour, tzinfo=timezone.utc)


def healthy_run(build_number: int, created_at: datetime) -> FullRunRecord:
    return run(
        build_number,
        created_at,
        ok(Component.FNREC),
        ok(Component.KERNREC_CUDA),
        ok(Component.KERNREC_ROCM),
    )


def outage_run(build_number: int, created_at: datetime) -> FullRunRecord:
    """Kernel collect passed but nothing was folded; fnrec was fine."""
    return run(
        build_number,
        created_at,
        ok(Component.FNREC),
        broken(
            Component.KERNREC_CUDA,
            "nothing to fold (0 jobs delivered recordings)",
            delivered_jobs=0,
        ),
        off(Component.KERNREC_ROCM),
    )


def subjects(episodes: tuple[SelectorAlertEpisode, ...]) -> list[tuple[str, str]]:
    return [(episode.condition, episode.subject_key) for episode in episodes]


def test_oct_24_outage_opens_an_episode_for_cuda_kernels_only() -> None:
    runs = [
        run(96933, at(23, 18), ok(Component.FNREC), ok(Component.KERNREC_CUDA), off(Component.KERNREC_ROCM)),
        outage_run(97001, at(24, 6)),
    ]

    plan = plan_selector_health(
        now=at(24, 12), runs=runs, decisions=[], open_episodes=[]
    )

    assert subjects(plan.opened) == [("run_incomplete", "kernrec_cuda")]
    details = plan.opened[0].details
    assert details["build_number"] == 97001
    assert details["delivered_jobs"] == 0
    assert details["last_published"]["build_number"] == 96933


def test_six_day_outage_goes_stale_after_30_hours() -> None:
    runs = [
        run(96933, at(23, 18), ok(Component.FNREC), ok(Component.KERNREC_CUDA), off(Component.KERNREC_ROCM)),
        outage_run(97001, at(24, 6)),
        outage_run(97101, at(24, 18)),
        outage_run(97201, at(25, 6)),
    ]

    plan = plan_selector_health(
        now=at(25, 12), runs=runs, decisions=[], open_episodes=[]
    )

    assert subjects(plan.opened) == [
        ("run_incomplete", "kernrec_cuda"),
        ("stale", "kernrec_cuda"),
    ]
    stale = plan.opened[1].details
    assert stale["stale_hours"] == 36.0
    assert stale["last_published"]["build_number"] == 96933
    # ROCm never published, so it cannot be stale.
    assert ("stale", "kernrec_rocm") not in subjects(plan.opened)


def test_build_97886_pattern_opens_cuda_but_not_rocm() -> None:
    runs = [
        healthy_run(97700, at(27, 18)),
        run(
            97886,
            at(28, 6),
            ok(Component.FNREC, rows=424),
            broken(Component.KERNREC_CUDA, "no valid table/map pair", rows=0),
            ok(Component.KERNREC_ROCM, rows=193),
        ),
    ]

    plan = plan_selector_health(
        now=at(28, 12), runs=runs, decisions=[], open_episodes=[]
    )

    assert subjects(plan.opened) == [("run_incomplete", "kernrec_cuda")]


def test_only_the_latest_completed_run_is_graded() -> None:
    runs = [
        outage_run(97001, at(29, 18)),
        healthy_run(97100, at(30, 6)),
        # Still collecting: not completed, so it neither opens nor resolves.
        replace(outage_run(97200, at(30, 18)), settled=False),
    ]

    plan = plan_selector_health(now=NOW, runs=runs, decisions=[], open_episodes=[])

    assert plan.opened == ()


def test_healthy_run_resolves_open_episodes_on_first_observation() -> None:
    open_episodes = [
        SelectorAlertEpisode("run_incomplete", "kernrec_cuda", at(29, 12), alert_id=1),
        SelectorAlertEpisode("stale", "kernrec_cuda", at(29, 12), alert_id=2),
    ]

    plan = plan_selector_health(
        now=NOW,
        runs=[outage_run(97001, at(29, 18)), healthy_run(97100, at(30, 18))],
        decisions=[],
        open_episodes=open_episodes,
    )

    assert plan.opened == ()
    assert subjects(plan.resolved) == [
        ("run_incomplete", "kernrec_cuda"),
        ("stale", "kernrec_cuda"),
    ]
    assert all(episode.resolved_at == NOW for episode in plan.resolved)


def test_an_open_episode_is_not_reopened() -> None:
    open_episode = SelectorAlertEpisode("run_incomplete", "kernrec_cuda", at(29, 12))

    plan = plan_selector_health(
        now=NOW,
        runs=[outage_run(97001, at(30, 18))],
        decisions=[],
        open_episodes=[open_episode],
    )

    assert ("run_incomplete", "kernrec_cuda") not in subjects(plan.opened)
    assert plan.resolved == ()


def test_fnrec_never_published_in_history_is_stale() -> None:
    runs = [
        run(
            97001,
            at(30, 6),
            broken(Component.FNREC, "nothing to fold"),
            ok(Component.KERNREC_CUDA),
            off(Component.KERNREC_ROCM),
        )
    ]

    plan = plan_selector_health(now=NOW, runs=runs, decisions=[], open_episodes=[])

    assert ("stale", "fnrec") in subjects(plan.opened)
    stale = next(e for e in plan.opened if e.condition == "stale")
    assert stale.details["last_published"] is None


def decision(
    build_number: int,
    created_at: datetime,
    *,
    outcome: DecisionOutcome = DecisionOutcome.APPLIED,
    reason: str | None = None,
    fnrec_build: int | None = 97100,
    kernrec_build: int | None = 97100,
    branch: str = "someone:feature",
) -> SelectorDecision:
    return SelectorDecision(
        build_number=build_number,
        created_at=created_at,
        branch=branch,
        outcome=outcome.value,
        reason=reason,
        seconds=200.0,
        fnrec_build=fnrec_build,
        kernrec_build=kernrec_build,
        ci_infra_commit="40a0cb0",
    )


def test_pr_decisions_on_an_old_recording_open_pr_stale() -> None:
    runs = [
        healthy_run(96933, at(23, 18)),
        healthy_run(97100, at(30, 6)),
        healthy_run(97200, at(30, 18)),
    ]
    decisions = [
        decision(98000 + index, NOW - timedelta(hours=1), kernrec_build=96933, fnrec_build=97200)
        for index in range(5)
    ]

    plan = plan_selector_health(
        now=NOW, runs=runs, decisions=decisions, open_episodes=[]
    )

    assert subjects(plan.opened) == [("pr_stale", "kernrec")]
    details = plan.opened[0].details
    assert details["median_build"] == 96933
    assert details["newest_published"]["build_number"] == 97200
    assert details["lag_hours"] == 168.0


def test_pr_decisions_on_the_newest_publish_are_healthy() -> None:
    # Six days on 96933 is fine for PRs when 96933 is still the newest CUDA
    # publish: that is the `stale` condition's problem, not pr_stale's.
    runs = [
        healthy_run(96933, at(23, 18)),
        outage_run(97200, at(30, 18)),
    ]
    decisions = [decision(98000, NOW - timedelta(hours=1), kernrec_build=96933, fnrec_build=97200)]
    open_episode = SelectorAlertEpisode("pr_stale", "kernrec", at(29, 1))

    plan = plan_selector_health(
        now=NOW, runs=runs, decisions=decisions, open_episodes=[open_episode]
    )

    assert ("pr_stale", "kernrec") in subjects(plan.resolved)


def test_pr_decisions_older_than_the_window_are_not_observations() -> None:
    runs = [healthy_run(96933, at(23, 18)), healthy_run(97200, at(30, 18))]
    decisions = [decision(98000, NOW - timedelta(hours=7), kernrec_build=96933)]
    open_episode = SelectorAlertEpisode("pr_stale", "kernrec", at(29, 1))

    plan = plan_selector_health(
        now=NOW, runs=runs, decisions=decisions, open_episodes=[open_episode]
    )

    assert plan.opened == () and plan.resolved == ()


def test_selector_errors_above_five_percent_open_pr_errors() -> None:
    decisions = [
        decision(98000 + index, NOW - timedelta(hours=2))
        for index in range(94)
    ] + [
        decision(
            98200 + index,
            NOW - timedelta(hours=3),
            outcome=DecisionOutcome.FALLBACK,
            reason="selector failed: table download timed out" if index % 2 else "gate error: bad key",
        )
        for index in range(6)
    ]

    plan = plan_selector_health(
        now=NOW, runs=[], decisions=decisions, open_episodes=[]
    )

    assert subjects(plan.opened) == [("pr_errors", "selector")]
    details = plan.opened[0].details
    assert (details["errors"], details["builds"], details["rate"]) == (6, 100, 0.06)


@pytest.mark.parametrize(
    ("errors", "healthy"),
    [
        (5, 120),  # 4.0%
        (4, 4),  # 50%, but fewer than five builds
    ],
)
def test_selector_errors_below_either_bar_do_not_alert(errors: int, healthy: int) -> None:
    decisions = [
        decision(98000 + index, NOW - timedelta(hours=1)) for index in range(healthy)
    ] + [
        decision(
            98500 + index,
            NOW - timedelta(hours=1),
            outcome=DecisionOutcome.FALLBACK,
            reason="selector failed: boom",
        )
        for index in range(errors)
    ]

    plan = plan_selector_health(now=NOW, runs=[], decisions=decisions, open_episodes=[])

    assert plan.opened == ()


def test_declined_fallbacks_and_main_builds_are_not_selector_errors() -> None:
    decisions = [
        decision(
            98000 + index,
            NOW - timedelta(hours=1),
            outcome=DecisionOutcome.FALLBACK,
            reason="selector declined: too many changed files",
        )
        for index in range(10)
    ] + [
        decision(
            98100 + index,
            NOW - timedelta(hours=1),
            outcome=DecisionOutcome.FALLBACK,
            reason="selector failed: boom",
            branch="main",
        )
        for index in range(10)
    ]

    plan = plan_selector_health(now=NOW, runs=[], decisions=decisions, open_episodes=[])

    assert plan.opened == ()


def test_thresholds_live_in_one_dataclass() -> None:
    lenient = SelectorHealthThresholds(stale_after=timedelta(hours=48))
    runs = [
        healthy_run(96933, at(29, 6)),
        outage_run(97001, at(29, 18)),
        outage_run(97101, at(30, 6)),
        outage_run(97201, at(30, 18)),
    ]

    assert ("stale", "kernrec_cuda") in subjects(
        plan_selector_health(now=NOW, runs=runs, decisions=[], open_episodes=[]).opened
    )
    assert ("stale", "kernrec_cuda") not in subjects(
        plan_selector_health(
            now=NOW, runs=runs, decisions=[], open_episodes=[], thresholds=lenient
        ).opened
    )
    assert DEFAULT_THRESHOLDS.min_delivered_ratio == 0.8


# --- Rendering -------------------------------------------------------------


def test_open_message_names_component_build_counts_and_staleness() -> None:
    episode = SelectorAlertEpisode(
        "run_incomplete",
        "kernrec_cuda",
        NOW,
        details={
            "component": "kernrec_cuda",
            "build_number": 99001,
            "kind": "daily",
            "expected_jobs": 250,
            "delivered_jobs": 0,
            "rows": 0,
            "verdict": "no recordings delivered",
            "last_published": {"build_number": 96933, "kind": "daily"},
            "stale_hours": 168.0,
        },
    )

    text = render_open(episode)

    assert "CUDA kernel table" in text
    assert "<https://buildkite.com/vllm/ci/builds/99001|#99001>" in text
    assert "delivered 0 of 250 expected jobs" in text
    assert "<https://buildkite.com/vllm/ci/builds/96933|#96933>, 168.0 h" in text


def test_notifications_pair_open_and_resolve_on_the_selector_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SLACK_CI_INFRA_ALERT_CHANNEL", "CINFRA")
    episode = SelectorAlertEpisode(
        "stale",
        "fnrec",
        NOW,
        details={"component": "fnrec", "newest_run": {"build_number": 1}, "stale_hours": 40},
    )
    from alerting.selector_health import SelectorHealthPlan

    opened, resolved = selector_notifications(
        SelectorHealthPlan(opened=(episode,), resolved=(replace(episode, resolved_at=NOW),)),
        delivery_mode=DeliveryMode.SHADOW,
    )

    assert opened.delivery_id.endswith(":open")
    assert resolved.delivery_id == opened.delivery_id[: -len(":open")] + ":resolve"
    assert opened.alert_path is AlertPath.SELECTOR
    assert opened.destination == "CINFRA"
    assert opened.delivery_mode is DeliveryMode.SHADOW


# --- Handler and in-memory store -------------------------------------------


class FixtureSource:
    def __init__(self) -> None:
        self.runs: list[FullRunRecord] = []
        self.new_decisions: list[SelectorDecision] = []
        self.calls: list[tuple[str, frozenset[int]]] = []

    def full_runs(
        self, *, since: datetime, up_to: datetime, settled: frozenset[int]
    ) -> list[FullRunRecord]:
        self.calls.append(("runs", settled))
        return [r for r in self.runs if r.build_number not in settled]

    def decisions(
        self, *, since: datetime, up_to: datetime, known: frozenset[int]
    ) -> list[SelectorDecision]:
        self.calls.append(("decisions", known))
        return [d for d in self.new_decisions if d.build_number not in known]


def make_runtime(
    source: FixtureSource, *, ingest_full_runs: bool = True
) -> tuple[AlertingRuntime, InMemorySelectorHealthStore, RecordingSlackPort, FixedClock]:
    clock = FixedClock(NOW)
    executions = InMemoryAutomationExecutionStore()
    outbox = InMemoryOutboxStore()
    store = InMemorySelectorHealthStore(executions=executions, outbox=outbox)
    slack = RecordingSlackPort(ts="111.222")
    command_type = "selector_health_scan" if ingest_full_runs else "selector_health_pr_scan"
    runtime = AlertingRuntime(
        executions=executions,
        outbox=outbox,
        slack=slack,
        clock=clock,
        handlers={
            command_type: SelectorHealthHandler(
                source=source,
                store=store,
                clock=clock,
                ingest_full_runs=ingest_full_runs,
            )
        },
        alert_path=AlertPath.SELECTOR,
    )
    return runtime, store, slack, clock


def test_episode_posts_once_and_resolve_edits_it_in_place() -> None:
    source = FixtureSource()
    source.runs = [healthy_run(97100, at(30, 6)), outage_run(97200, at(30, 18))]
    runtime, store, slack, clock = make_runtime(source)

    first = ScheduledCommand("selector_health_scan", NOW)
    assert runtime.process_command(first).status is ProcessStatus.COMPLETED
    runtime.dispatch_due_notifications()
    assert [e.subject_key for e in store.open_episodes()] == ["kernrec_cuda"]
    assert len(slack.deliveries) == 1
    assert "CUDA kernel table" in slack.deliveries[0].payload["text"]

    # The outage run is settled, so it is not read again; the next run is fine.
    source.runs = [healthy_run(97300, at(31, 6))]
    clock.advance(minutes=12 * 60)
    second = ScheduledCommand("selector_health_scan", clock.now())
    assert runtime.process_command(second).status is ProcessStatus.COMPLETED
    runtime.dispatch_due_notifications()

    assert store.open_episodes() == []
    assert len(slack.deliveries) == 1
    assert slack.updates and slack.updates[0]["ts"] == "111.222"
    assert ("runs", frozenset({97100, 97200})) in source.calls


def test_hourly_pr_scan_reads_only_new_decisions_and_no_runs() -> None:
    source = FixtureSource()
    source.new_decisions = [decision(98000, NOW - timedelta(hours=1))]
    runtime, store, _, clock = make_runtime(source, ingest_full_runs=False)

    assert (
        runtime.process_command(ScheduledCommand("selector_health_pr_scan", NOW)).status
        is ProcessStatus.COMPLETED
    )
    clock.advance(minutes=60)
    source.new_decisions.append(decision(98001, clock.now()))
    runtime.process_command(ScheduledCommand("selector_health_pr_scan", clock.now()))

    assert [d.build_number for d in store.decisions()] == [98000, 98001]
    assert [kind for kind, _ in source.calls] == ["decisions", "decisions"]
    assert source.calls[1] == ("decisions", frozenset({98000}))


def test_store_opens_one_episode_per_subject_and_rolls_back_failed_commits() -> None:
    source = FixtureSource()
    source.runs = [outage_run(97200, at(30, 18))]
    runtime, store, _, clock = make_runtime(source)

    store.fail_next_commit()
    failed = runtime.process_command(ScheduledCommand("selector_health_scan", NOW))
    assert failed.status is ProcessStatus.FAILED
    assert store.runs() == [] and store.episodes() == []

    clock.advance(minutes=1)
    runtime.process_command(ScheduledCommand("selector_health_scan", clock.now()))
    episodes = store.episodes()
    assert [(e.condition, e.subject_key) for e in episodes] == [
        ("run_incomplete", "kernrec_cuda"),
        ("stale", "kernrec_cuda"),
    ]

    # A plan that opens the same subject again changes nothing.
    duplicate = SelectorAlertEpisode("run_incomplete", "kernrec_cuda", clock.now())
    from alerting.selector_health import SelectorHealthPlan

    store._executions.claim(  # noqa: SLF001 — seed a running execution
        ScheduledCommand("selector_health_scan", clock.now() + timedelta(minutes=1)),
        now=clock.now(),
        lease_until=clock.now() + timedelta(minutes=30),
    )
    store.commit_selector_health(
        command=ScheduledCommand("selector_health_scan", clock.now() + timedelta(minutes=1)),
        plan=SelectorHealthPlan(opened=(duplicate,)),
        now=clock.now(),
        notification_factory=lambda plan: selector_notifications(
            plan, delivery_mode=DeliveryMode.LIVE
        ),
    )
    assert len(store.episodes()) == 2


# --- Buildkite adapter -----------------------------------------------------


class FakeBuildkite:
    def __init__(self) -> None:
        self.builds: list[dict[str, Any]] = []
        self.jobs: dict[int, list[dict[str, Any]]] = {}
        self.artifacts: dict[str, list[dict[str, Any]]] = {}
        self.files: dict[str, bytes] = {}
        self.logs: dict[str, str] = {}
        self.log_reads: list[str] = []
        self.downloads: list[str] = []

    def list_builds(
        self, *, start_time: datetime | None, up_to: datetime, branch: str | None = "main"
    ) -> list[dict[str, Any]]:
        return [b for b in self.builds if branch is None or b["branch"] == branch]

    def list_jobs(self, build_number: int) -> list[dict[str, Any]]:
        return self.jobs.get(build_number, [])

    def list_job_artifacts(self, build_number: int, job_id: str) -> list[dict[str, Any]]:
        return self.artifacts.get(job_id, [])

    def download_artifact(self, download_url: str, *, max_bytes: int) -> bytes:
        self.downloads.append(download_url)
        return self.files[download_url]

    def job_log_tail(self, build_number: int, job_id: str, *, max_bytes: int) -> str:
        self.log_reads.append(job_id)
        return self.logs[job_id]


def job(job_id: str, step_key: str, state: str = "passed", **fields: Any) -> dict[str, Any]:
    return {
        "id": job_id,
        "step_key": step_key,
        "state": state,
        "soft_failed": False,
        "exit_status": 0,
        "started_at": "2026-10-28T06:43:42Z",
        **fields,
    }


def artifact(job_id: str, path: str) -> dict[str, Any]:
    return {"path": path, "download_url": f"https://api.buildkite.com/{job_id}/{path}"}


def full_run_build(number: int) -> dict[str, Any]:
    return {
        "number": number,
        "branch": "main",
        "message": "Full CI run - nightly",
        "state": "failed",
        "commit": SHA,
        "created_at": "2026-10-28T06:00:03.267Z",
    }


def test_adapter_falls_back_to_logs_for_runs_before_ci_infra_881() -> None:
    bk = FakeBuildkite()
    bk.builds = [
        full_run_build(97886),
        {**full_run_build(97887), "message": "Full CI run torch nightly"},
        {**full_run_build(97888), "message": "[Misc] Mention Full CI run - nightly"},
    ]
    bk.jobs[97886] = [
        job("fn", "fnrec-collect"),
        job("kern", "kernrec-collect"),
        job("img", "image-build"),
        job("amd", "image-build-amd"),
    ]
    bk.artifacts = {
        "kern": [artifact("kern", "kernel_table.rocm.json.gz")],
        "img": [artifact("img", "kernel_symbol_map.json.gz")],
        "amd": [artifact("amd", "kernel_symbol_map.rocm.json.gz")],
    }
    bk.files = {
        "https://api.buildkite.com/img/kernel_symbol_map.json.gz": gz(source_map()),
        "https://api.buildkite.com/amd/kernel_symbol_map.rocm.json.gz": gz(
            source_map(backend="rocm")
        ),
        # Not JSON: the table read falls back to the log's counts.
        "https://api.buildkite.com/kern/kernel_table.rocm.json.gz": b"\x1f\x8bnot gzip",
    }
    bk.logs = {"fn": FNREC_98403_LOG, "kern": KERNREC_97886_LOG}

    (record,) = BuildkiteSelectorSource(bk).full_runs(
        since=NOW - timedelta(days=14), up_to=NOW, settled=frozenset()
    )

    assert record.build_number == 97886 and record.kind == "nightly"
    assert record.settled
    status = {item.component: item.status for item in record.components}
    assert status == {
        "fnrec": "ok",
        "kernrec_cuda": "broken",
        "kernrec_rocm": "ok",
        "map_cuda": "ok",
        "map_rocm": "ok",
    }
    cuda = record.component(Component.KERNREC_CUDA)
    assert cuda is not None and cuda.source == "log" and cuda.rows == 0
    rocm = record.component(Component.KERNREC_ROCM)
    assert rocm is not None and (rocm.rows, rocm.usable_rows, rocm.source) == (
        215,
        193,
        "log",
    )
    assert rocm.collected and not cuda.collected
    assert sorted(bk.log_reads) == ["fn", "kern"]


def test_adapter_prefers_summaries_and_blames_a_soft_failed_job_on_its_backend() -> None:
    bk = FakeBuildkite()
    bk.builds = [full_run_build(99001)]
    bk.jobs[99001] = [
        job("fn", "fnrec-collect"),
        job("kern", "kernrec-collect", state="failed", soft_failed=True, exit_status=1),
        job("img", "image-build"),
        job("amd", "image-build-amd", state="running"),
    ]
    bk.artifacts = {
        "fn": [artifact("fn", "fnrec_collect_summary.json")],
        "kern": [artifact("kern", "kernrec_collect_summary.json")],
        "img": [],
    }
    bk.files = {
        "https://api.buildkite.com/fn/fnrec_collect_summary.json": json.dumps(
            {"recorder": "fnrec", "build": 99001, "commit": SHA, "expected_jobs": 678,
             "delivered_jobs": 670, "rows": 440, "verdict": "ok", "exit_status": 0}
        ).encode(),
        "https://api.buildkite.com/kern/kernrec_collect_summary.json": json.dumps(
            {"recorder": "kernrec", "build": 99001, "commit": SHA, "backends": {
                "cuda": {"expected_jobs": 250, "delivered_jobs": 0, "usable_rows": 0,
                         "verdict": "no recordings delivered"},
                "rocm": {"expected_jobs": 215, "delivered_jobs": 215, "usable_rows": 193,
                         "verdict": "ok"}}}
        ).encode(),
    }

    (record,) = BuildkiteSelectorSource(bk).full_runs(
        since=NOW - timedelta(days=14), up_to=NOW, settled=frozenset()
    )

    status = {item.component: item.status for item in record.components}
    # The job soft-failed because CUDA was not whole; ROCm stays ok.
    assert status["kernrec_cuda"] == "broken"
    assert status["kernrec_rocm"] == "ok"
    assert status["fnrec"] == "ok"
    assert status["map_cuda"] == "broken"
    assert status["map_rocm"] == "pending"
    assert bk.log_reads == []
    cuda = record.component(Component.KERNREC_CUDA)
    assert cuda is not None
    assert (cuda.expected_jobs, cuda.delivered_jobs, cuda.source) == (250, 0, "summary")


def test_adapter_leaves_a_run_with_a_running_collect_unsettled() -> None:
    bk = FakeBuildkite()
    bk.builds = [full_run_build(99002)]
    bk.jobs[99002] = [job("fn", "fnrec-collect", state="running"), job("kern", "kernrec-collect")]
    bk.logs = {"kern": KERNREC_96933_LOG}

    (record,) = BuildkiteSelectorSource(bk).full_runs(
        since=NOW - timedelta(days=14), up_to=NOW, settled=frozenset()
    )

    assert not record.settled
    fnrec = record.component(Component.FNREC)
    assert fnrec is not None and fnrec.status == "pending"


def test_adapter_reads_pr_decisions_and_records_missing_ones() -> None:
    bk = FakeBuildkite()
    bk.builds = [
        {"number": 98641, "branch": "a:feature", "state": "passed",
         "created_at": "2026-10-30T08:12:12Z", "pull_request": {"id": "64618"}},
        {"number": 98642, "branch": "a:docs", "state": "passed",
         "created_at": "2026-10-30T08:13:12Z", "pull_request": {"id": "64619"}},
        {"number": 98643, "branch": "b:wip", "state": "running",
         "created_at": "2026-10-30T08:14:12Z"},
        {"number": 98644, "branch": "main", "state": "running",
         "created_at": "2026-10-30T08:15:12Z"},
        {"number": 98600, "branch": "c:old", "state": "passed",
         "created_at": "2026-10-30T07:00:00Z"},
    ]
    bk.jobs = {
        98641: [job("boot1", "bootstrap")],
        98642: [job("boot2", "bootstrap")],
        98643: [job("boot3", "bootstrap", state="running")],
    }
    bk.artifacts = {
        "boot1": [artifact("boot1", ".buildkite/ci_selector_decision.json")],
        "boot2": [artifact("boot2", ".buildkite/pipeline.yaml")],
    }
    bk.files = {
        "https://api.buildkite.com/boot1/.buildkite/ci_selector_decision.json": json.dumps(
            {"applied": True, "seconds": 274.6, "ci_infra_commit": "40a0cb0",
             "records": {"fnrec": {"build": 98403}, "kernrec": {"build": 96933}}}
        ).encode()
    }

    decisions = BuildkiteSelectorSource(bk).decisions(
        since=NOW - timedelta(hours=26), up_to=NOW, known=frozenset({98600})
    )

    assert [(d.build_number, d.outcome) for d in decisions] == [
        (98642, "missing"),
        (98641, "applied"),
    ]
    assert decisions[1].pull_request == 64618
    assert decisions[1].kernrec_build == 96933


# --- Components: kernel tables, source maps, row degradation ---------------

SHA_100914 = "34b780fe66bdf3df173358774eb4f29f684b8368"


def gz(payload: Any) -> bytes:
    return gzip.compress(json.dumps(payload).encode())


def kernel_row(
    *,
    backend: str = "cuda",
    passed: bool = True,
    trace_complete: Any = True,
    **fields: Any,
) -> dict[str, Any]:
    return {
        "jobs": 2,
        "passed": passed,
        "complete": True,
        "processes": 3,
        "dropped": 0,
        "kernels": [0],
        "backend": backend,
        "trace_complete": trace_complete,
        "recording_available": True,
        **fields,
    }


def kernel_table(
    *,
    backend: str = "cuda",
    usable: int,
    trace_incomplete: int,
    not_passed_untraced: int = 0,
    not_passed_traced: int = 0,
) -> dict[str, Any]:
    """A version-3 kernel table with the given row mix."""
    rows: dict[str, Any] = {}
    for count, kind in (
        (usable, {}),
        (trace_incomplete, {"trace_complete": False}),
        (not_passed_untraced, {"passed": False, "trace_complete": False}),
        (not_passed_traced, {"passed": False}),
    ):
        for _ in range(count):
            rows[f"step-{len(rows)}"] = kernel_row(backend=backend, **kind)
    return {"version": 3, "names": ["k0"], "rows": rows}


# The two kernel tables of vllm/ci #100914 (2026-11-08 19:00 UTC): every
# collect passed and published, and the CUDA table had 95 usable rows of 253
# (157 from jobs whose trace was incomplete, 7 from jobs that did not pass).
CUDA_TABLE_100914 = kernel_table(
    usable=95, trace_incomplete=151, not_passed_untraced=6, not_passed_traced=1
)
ROCM_TABLE_100914 = kernel_table(
    backend="rocm", usable=215, trace_incomplete=29, not_passed_traced=1
)


def source_map(
    *, commit: str = SHA, backend: str | None = None, **fields: Any
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "version": 2 if backend else 1,
        "commit": commit,
        "objects": [
            {"source": "csrc/attention/a.cu", "device": True, "symbols": ["a", "b"]},
            {"source": "csrc/attention/a.cu", "device": True, "symbols": ["c"]},
            {"source": "csrc/ops.cpp", "device": False, "symbols": []},
            {"source": ".deps/flashmla/x.cu", "device": True, "symbols": ["d"]},
        ],
    }
    if backend:
        payload["backend"] = backend
    payload.update(fields)
    return payload


def test_kernel_table_counts_rows_failing_each_condition() -> None:
    stats = kernel_table_stats(CUDA_TABLE_100914)

    assert (stats.rows, stats.usable_rows) == (253, 95)
    assert stats.trace_incomplete == 157
    assert stats.not_passed == 7
    assert (stats.dropped, stats.incomplete) == (0, 0)

    mixed = kernel_table_stats(
        {
            "version": 3,
            "rows": {
                "a": kernel_row(),
                "b": kernel_row(dropped=4),
                "c": kernel_row(complete=False),
                "d": kernel_row(backend="unknown"),
                "e": kernel_row(trace_complete=None),
                "f": {key: v for key, v in kernel_row().items() if key != "complete"},
            },
        }
    )
    assert (mixed.rows, mixed.usable_rows) == (6, 2)
    assert (mixed.dropped, mixed.incomplete, mixed.trace_incomplete) == (1, 1, 1)


def test_kernel_table_before_trace_health_counts_usable_as_its_collect_did() -> None:
    # Build 96933's table is version 2: no backend, no trace_complete.
    stats = kernel_table_stats(
        {
            "version": 2,
            "rows": {
                **{f"ok{i}": {"passed": True, "complete": True, "dropped": 0} for i in range(243)},
                **{f"bad{i}": {"passed": False, "complete": True, "dropped": 0} for i in range(7)},
            },
        }
    )

    assert (stats.rows, stats.usable_rows, stats.not_passed) == (250, 243, 7)
    assert stats.trace_incomplete is None


def test_healthy_source_map_counts_objects_symbols_and_csrc_sources() -> None:
    stats = source_map_stats(source_map(), build_commit=SHA, backend="cuda")

    assert stats.problems == ()
    assert (stats.objects, stats.device_objects, stats.symbols, stats.sources) == (
        4,
        3,
        4,
        2,
    )
    rocm = source_map_stats(source_map(backend="rocm"), build_commit=SHA, backend="rocm")
    assert rocm.problems == ()


@pytest.mark.parametrize(
    ("payload", "problem"),
    [
        (
            source_map(objects=[], reason="cuobjdump not found"),
            "map not built: cuobjdump not found",
        ),
        (source_map(objects=[]), "map has no objects"),
        (source_map(commit=SHA_100914), "map built from 34b780fe66bd, run is at 665bfc8aaeb7"),
        (source_map(backend="rocm"), "map is for rocm, expected cuda"),
    ],
)
def test_broken_source_maps_say_why(payload: dict[str, Any], problem: str) -> None:
    stats = source_map_stats(payload, build_commit=SHA, backend="cuda")

    assert stats.problems == (problem,)
    graded = map_component(
        Component.MAP_CUDA,
        job("img", "image-build"),
        ["kernel_symbol_map.json.gz"],
        wanted="kernel_symbol_map.json.gz",
        armed=True,
        stats=stats,
    )
    assert graded.status == ComponentStatus.BROKEN
    assert graded.verdict == problem


def test_absent_map_is_broken_only_when_its_image_build_ran_for_an_armed_backend() -> None:
    def grade(image_job: dict[str, Any] | None, *, armed: bool) -> str:
        return map_component(
            Component.MAP_ROCM,
            image_job,
            [] if image_job is not None else None,
            wanted="kernel_symbol_map.rocm.json.gz",
            armed=armed,
        ).status

    assert grade(job("amd", "image-build-amd"), armed=True) == "broken"
    # Before ROCm was armed (build 96933) the AMD image build uploaded none.
    assert grade(job("amd", "image-build-amd"), armed=False) == "missing"
    assert grade(job("amd", "image-build-amd", started_at=None), armed=True) == "missing"
    assert grade(None, armed=True) == "missing"


def test_decision_today_names_only_the_cuda_kernel_table() -> None:
    decision = parse_decision(
        {
            "applied": True,
            "records": {
                "fnrec": {"build": 100914, "files": ["table.json.gz"]},
                "kernrec": {
                    "backend": "cuda",
                    "build": 100914,
                    "files": ["kernel_symbol_map.json.gz", "kernel_table.json.gz"],
                },
            },
        },
        build_number=101003,
        created_at=NOW,
        branch="a:b",
        pull_request=63721,
    )

    assert decision.kernrec_build == 100914
    assert decision.kernrec_rocm_build is None
    assert decision.kernel_backends == ("cuda",)


@pytest.mark.parametrize(
    "records",
    [
        {"kernrec": {"backend": "cuda", "build": 100914},
         "kernrec_rocm": {"backend": "rocm", "build": 100800}},
        {"kernrec": {"build": 100914}, "kernrec_rocm": {"build": 100800}},
        {"kernrec": [{"backend": "cuda", "build": 100914},
                     {"backend": "rocm", "build": "100800"}]},
        {"kernrec": {"cuda": {"build": 100914}, "rocm": {"build": 100800}}},
    ],
)
def test_decision_with_a_rocm_kernel_entry_names_both_backends(
    records: dict[str, Any],
) -> None:
    decision = parse_decision(
        {"applied": True, "records": {"fnrec": {"build": 100914}, **records}},
        build_number=101100,
        created_at=NOW,
        branch="a:b",
        pull_request=1,
    )

    assert (decision.kernrec_build, decision.kernrec_rocm_build) == (100914, 100800)
    assert decision.kernel_backends == ("cuda", "rocm")


def test_decision_kernel_builds_ignores_unknown_backends_and_bad_builds() -> None:
    assert decision_kernel_builds(
        {"kernrec": {"backend": "xpu", "build": 1}, "kernrec_rocm": {"build": "x"}}
    ) == {"rocm": None}
    assert decision_kernel_builds({"fnrec": {"build": 1}}) == {}


def table_component(
    component: Component, *, rows: int | None, usable: int | None, **fields: Any
) -> RunComponent:
    return replace(ok(component, rows=rows or 0), rows=rows, usable_rows=usable, **fields)


def kernel_run(
    build_number: int, created_at: datetime, *, cuda: tuple[int, int], rocm: tuple[int, int]
) -> FullRunRecord:
    return run(
        build_number,
        created_at,
        table_component(Component.FNREC, rows=492, usable=None),
        table_component(Component.KERNREC_CUDA, rows=cuda[1], usable=cuda[0]),
        table_component(Component.KERNREC_ROCM, rows=rocm[1], usable=rocm[0]),
    )


def nov(day: int, hour: int) -> datetime:
    return datetime(2026, 11, day, hour, tzinfo=timezone.utc)


NOV_NOW = datetime(2026, 11, 9, 0, 45, tzinfo=timezone.utc)


def week_before_100914() -> list[FullRunRecord]:
    """Seven healthy runs: ~243 of 252 CUDA rows, ~215 of 245 ROCm rows."""
    return [
        kernel_run(100000 + index, nov(5 + index // 2, 7 if index % 2 == 0 else 19),
                   cuda=(240 + index, 252), rocm=(212 + index, 245))
        for index in range(7)
    ]


def test_run_100914_degrades_the_cuda_kernel_table_only() -> None:
    latest = kernel_run(100914, nov(8, 19), cuda=(95, 253), rocm=(215, 245))
    latest = replace(
        latest,
        components=tuple(
            replace(item, rows_not_passed=7, rows_trace_incomplete=157)
            if item.component == "kernrec_cuda"
            else item
            for item in latest.components
        ),
    )

    for history in ([], week_before_100914()):
        plan = plan_selector_health(
            now=NOV_NOW, runs=[*history, latest], decisions=[], open_episodes=[]
        )
        assert subjects(plan.opened) == [("rows_degraded", "kernrec_cuda")]

    (episode,) = plan.opened
    assert episode.details["usable_rows"] == 95
    assert episode.details["rows"] == 253
    assert episode.details["median_usable_rows"] == 243
    assert episode.details["reason"].startswith("95 of 253 rows usable (38%, under 70%)")
    text = render_open(episode)
    assert "CUDA kernel table" in text and "#100914" in text
    assert "157 with an incomplete trace" in text
    assert "7 from jobs that did not pass" in text


def test_usable_rows_under_60_percent_of_the_7_run_median_degrade_a_table() -> None:
    history = week_before_100914()
    # 87% of its rows are usable, but 140 is under 60% of the median 243.
    latest = kernel_run(100914, nov(8, 19), cuda=(140, 160), rocm=(215, 245))

    plan = plan_selector_health(
        now=NOV_NOW, runs=[*history, latest], decisions=[], open_episodes=[]
    )
    assert subjects(plan.opened) == [("rows_degraded", "kernrec_cuda")]
    assert "under 60% of the median 243 of the previous 7 runs" in (
        plan.opened[0].details["reason"]
    )

    # The median rule waits for three prior runs.
    plan = plan_selector_health(
        now=NOV_NOW, runs=[*history[-2:], latest], decisions=[], open_episodes=[]
    )
    assert plan.opened == ()

    # Only the previous seven count: an older, bigger run does not.
    old = kernel_run(99000, nov(1, 7), cuda=(10_000, 10_000), rocm=(215, 245))
    plan = plan_selector_health(
        now=NOV_NOW,
        runs=[old, *history, replace(latest, build_number=100915)],
        decisions=[],
        open_episodes=[],
    )
    assert plan.opened[0].details["median_usable_rows"] == 243

    # Runs that did not publish the table are left out of the median.
    outage = [
        replace(r, components=tuple(
            replace(item, published=False, usable_rows=0)
            if item.component == "kernrec_cuda" else item
            for item in r.components
        ))
        for r in history[:5]
    ]
    plan = plan_selector_health(
        now=NOV_NOW, runs=[*outage, *history[5:], latest], decisions=[], open_episodes=[]
    )
    assert plan.opened == ()


def test_a_recovered_table_resolves_rows_degraded_and_unknown_usable_never_alerts() -> None:
    history = week_before_100914()
    degraded = kernel_run(100914, nov(8, 19), cuda=(95, 253), rocm=(215, 245))
    opened = plan_selector_health(
        now=NOV_NOW, runs=[*history, degraded], decisions=[], open_episodes=[]
    ).opened
    recovered = kernel_run(101100, nov(9, 7), cuda=(244, 253), rocm=(215, 245))

    plan = plan_selector_health(
        now=NOV_NOW + timedelta(hours=12),
        runs=[*history, degraded, recovered],
        decisions=[],
        open_episodes=opened,
    )

    assert plan.opened == ()
    assert subjects(plan.resolved) == [("rows_degraded", "kernrec_cuda")]
    # fnrec reports rows but not usable rows: never degraded.
    assert all(e.subject_key != "fnrec" for e in opened)


def test_grade_rows_stores_each_runs_reason_against_the_runs_before_it() -> None:
    history = week_before_100914()
    latest = kernel_run(100914, nov(8, 19), cuda=(95, 253), rocm=(215, 245))

    graded = {r.build_number: r for r in grade_rows([latest, *history])}

    cuda = graded[100914].component(Component.KERNREC_CUDA)
    assert cuda is not None and cuda.rows_degraded is not None
    assert "95 of 253 rows usable" in cuda.rows_degraded
    rocm = graded[100914].component(Component.KERNREC_ROCM)
    assert rocm is not None and rocm.rows_degraded is None
    assert all(
        item.rows_degraded is None for item in graded[history[0].build_number].components
    )


def test_a_broken_source_map_opens_run_incomplete_for_the_map() -> None:
    latest = kernel_run(100914, nov(8, 19), cuda=(244, 253), rocm=(215, 245))
    latest = replace(
        latest,
        components=(
            *latest.components,
            RunComponent("map_cuda", "broken", job_state="passed",
                         verdict="map has no objects", collected=True, map_objects=0),
            RunComponent("map_rocm", "ok", job_state="passed", verdict="ok",
                         collected=True, map_objects=96),
        ),
    )

    plan = plan_selector_health(
        now=NOV_NOW, runs=[*week_before_100914(), latest], decisions=[], open_episodes=[]
    )

    assert subjects(plan.opened) == [("run_incomplete", "map_cuda")]
    text = render_open(plan.opened[0])
    assert "CUDA kernel source map" in text and "map has no objects" in text


def test_pr_decisions_on_an_old_rocm_kernel_table_open_pr_stale() -> None:
    runs = [
        kernel_run(100000 + index, nov(5 + index // 2, 7 if index % 2 == 0 else 19),
                   cuda=(243, 252), rocm=(215, 245))
        for index in range(7)
    ]
    decisions = [
        replace(
            decision(101000 + index, NOV_NOW - timedelta(hours=1)),
            fnrec_build=100006,
            kernrec_build=100006,
            kernrec_rocm_build=100000,
            kernel_backends=("cuda", "rocm"),
        )
        for index in range(3)
    ]

    plan = plan_selector_health(
        now=NOV_NOW, runs=runs, decisions=decisions, open_episodes=[]
    )

    assert subjects(plan.opened) == [("pr_stale", "kernrec_rocm")]


def test_adapter_reads_both_kernel_tables_and_both_maps_of_run_100914() -> None:
    bk = FakeBuildkite()
    bk.builds = [{**full_run_build(100914), "commit": SHA_100914,
                  "message": "Full CI run - daily"}]
    bk.jobs[100914] = [
        job("fn", "fnrec-collect"),
        job("kern", "kernrec-collect"),
        job("img", "image-build"),
        job("amd", "image-build-amd"),
    ]
    bk.artifacts = {
        "fn": [artifact("fn", "table.json.gz"), artifact("fn", "fnrec_collect_summary.json")],
        "kern": [
            artifact("kern", name)
            for name in (
                "kernel_table.json.gz",
                "kernel_table.rocm.json.gz",
                "kernel_symbol_map.json.gz",
                "kernel_symbol_map.rocm.json.gz",
                "kernrec_collect_summary.json",
            )
        ],
        "img": [artifact("img", "kernel_symbol_map.json.gz")],
        "amd": [artifact("amd", "kernel_symbol_map.rocm.json.gz")],
    }
    url = "https://api.buildkite.com/{}/{}".format
    bk.files = {
        url("fn", "fnrec_collect_summary.json"): json.dumps(
            {"recorder": "fnrec", "build": 100914, "commit": SHA_100914,
             "expected_jobs": 819, "delivered_jobs": 820, "rows": 492,
             "verdict": "ok", "exit_status": 0}
        ).encode(),
        url("kern", "kernrec_collect_summary.json"): json.dumps(
            {"recorder": "kernrec", "build": 100914, "commit": SHA_100914, "backends": {
                "cuda": {"expected_jobs": 445, "delivered_jobs": 429,
                         "usable_rows": 95, "verdict": "ok"},
                "rocm": {"expected_jobs": 371, "delivered_jobs": 369,
                         "usable_rows": 215, "verdict": "ok"}}}
        ).encode(),
        url("kern", "kernel_table.json.gz"): gz(CUDA_TABLE_100914),
        url("kern", "kernel_table.rocm.json.gz"): gz(ROCM_TABLE_100914),
        url("img", "kernel_symbol_map.json.gz"): gz(source_map(commit=SHA_100914)),
        url("amd", "kernel_symbol_map.rocm.json.gz"): gz(
            source_map(commit=SHA_100914, backend="rocm")
        ),
    }

    (record,) = BuildkiteSelectorSource(bk).full_runs(
        since=NOV_NOW - timedelta(days=14), up_to=NOV_NOW, settled=frozenset()
    )

    status = {item.component: item.status for item in record.components}
    assert set(status.values()) == {"ok"}
    fnrec = record.component(Component.FNREC)
    assert fnrec is not None and fnrec.collected and fnrec.published
    assert (fnrec.rows, fnrec.usable_rows) == (492, None)
    cuda = record.component(Component.KERNREC_CUDA)
    assert cuda is not None
    assert (cuda.rows, cuda.usable_rows, cuda.source) == (253, 95, "table")
    assert (cuda.rows_trace_incomplete, cuda.rows_not_passed) == (157, 7)
    assert (cuda.expected_jobs, cuda.delivered_jobs) == (445, 429)
    rocm = record.component(Component.KERNREC_ROCM)
    assert rocm is not None and (rocm.rows, rocm.usable_rows) == (245, 215)
    cuda_map = record.component(Component.MAP_CUDA)
    assert cuda_map is not None and cuda_map.collected and cuda_map.published
    assert (cuda_map.map_objects, cuda_map.map_device_objects, cuda_map.map_symbols,
            cuda_map.map_sources) == (4, 3, 4, 2)
    # fnrec's 125 MB table is never downloaded.
    assert "table.json.gz" not in [path.rsplit("/", 1)[-1] for path in bk.downloads]


def test_adapter_falls_back_to_summary_usable_rows_when_a_table_fails() -> None:
    bk = FakeBuildkite()
    bk.builds = [full_run_build(100914)]
    bk.jobs[100914] = [job("kern", "kernrec-collect")]
    bk.artifacts = {
        "kern": [artifact("kern", "kernel_table.json.gz"),
                 artifact("kern", "kernrec_collect_summary.json")],
    }
    bk.files = {
        "https://api.buildkite.com/kern/kernrec_collect_summary.json": json.dumps(
            {"backends": {"cuda": {"expected_jobs": 445, "delivered_jobs": 429,
                                   "usable_rows": 95, "verdict": "ok"}}}
        ).encode(),
    }  # the table's download raises KeyError

    (record,) = BuildkiteSelectorSource(bk).full_runs(
        since=NOV_NOW - timedelta(days=14), up_to=NOV_NOW, settled=frozenset()
    )

    cuda = record.component(Component.KERNREC_CUDA)
    assert cuda is not None
    assert (cuda.rows, cuda.usable_rows, cuda.source) == (None, 95, "summary")
    assert cuda.rows_trace_incomplete is None


def test_handler_stores_fresh_runs_with_their_rows_degraded_reason() -> None:
    source = FixtureSource()
    source.runs = [
        *week_before_100914(),
        kernel_run(100914, nov(8, 19), cuda=(95, 253), rocm=(215, 245)),
    ]
    runtime, store, _, _ = make_runtime(source)
    runtime.process_command(ScheduledCommand("selector_health_scan", NOV_NOW))

    stored = {r.build_number: r for r in store.runs()}
    cuda = stored[100914].component(Component.KERNREC_CUDA)
    assert cuda is not None and cuda.rows_degraded is not None
    assert [(e.condition, e.subject_key) for e in store.open_episodes()] == [
        ("rows_degraded", "kernrec_cuda")
    ]
