"""Daily infra summary: rendering, handler wiring and its Postgres reads."""

from __future__ import annotations

import time
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from alerting.commands import ScheduledCommand
from alerting.daily_summary import (
    DailySummaryHandler,
    SummaryInputs,
    render_summary,
)
from alerting.infra import (
    normalize_hostname,
    pilot_pools,
    GpuCountObservation,
    InfraAlertEpisode,
    InfraSubjectState,
)
from alerting.memory import (
    FixedClock,
    InMemoryAutomationExecutionStore,
    InMemoryInfraStore,
    InMemoryOutboxStore,
    RecordingSlackPort,
)
from alerting.ports import AlertPath, DeliveryMode
from alerting.postgres import PostgresAlertStore

# 09:00 Pacific on 2026-10-20.
NOW = datetime(2026, 10, 20, 16, 0, tzinfo=timezone.utc)
YESTERDAY = NOW - timedelta(hours=24)
POOLS = {
    "h200-ci-1": ("h200", "h200_35gb"),
    "h200-ci-2": ("h200", "h200_35gb"),
    "inf-4x8h100-1": ("h100", "mithril-h100-pool"),
}


def counts(**by_host: int) -> list[GpuCountObservation]:
    return [GpuCountObservation(h.replace("_", "-"), n, NOW) for h, n in by_host.items()]


def episode(
    alert_type: str,
    host: str,
    *,
    opened: timedelta = timedelta(hours=3),
    resolved: timedelta | None = None,
    **details: Any,
) -> InfraAlertEpisode:
    return InfraAlertEpisode(
        alert_type=alert_type,
        subject_key=host,
        opened_at=NOW - opened,
        resolved_at=None if resolved is None else NOW - resolved,
        details=details,
    )


def inputs(**overrides: Any) -> SummaryInputs:
    fields: dict[str, Any] = dict(
        now=NOW,
        live=False,
        pools=POOLS,
        gpu_counts=counts(h200_ci_1=8, h200_ci_2=8, inf_4x8h100_1=8),
        baselines={},
        exceptions={},
        episodes=[],
        scrape_buckets={},
        allocatable={},
    )
    return SummaryInputs(**{**fields, **overrides})


def test_quiet_day_is_one_line() -> None:
    assert render_summary(inputs()) == (
        "📊 Daily CI infra summary — 2026-10-20: 3 hosts, nothing changed, "
        "nothing quarantined or degraded."
    )


def test_busy_day_lists_changes_then_standing_and_hides_empty_sections() -> None:
    text = render_summary(
        inputs(
            live=True,
            gpu_counts=counts(h200_ci_1=7, h200_ci_2=8, inf_4x8h100_1=8),
            baselines={"h200-ci-1": 8},
            exceptions={"h200-ci-2": 9},
            episodes=[
                episode("quarantine", "h200-ci-1", stage="quarantined", reason="Xid 79"),
                episode("quarantine", "h200-ci-2", stage="would", reason="docker down"),
                episode(
                    "quarantine", "inf-4x8h100-1", stage="held", reason="gpu hang",
                    held_reason="pool_cap",
                ),
                episode(
                    "quarantine", "old-1", opened=timedelta(days=3), resolved=timedelta(hours=1),
                    stage="resolved", reason="x", resolved_by="oncall",
                ),
                episode(
                    "quarantine", "old-2", opened=timedelta(days=3), resolved=timedelta(hours=1),
                    stage="resolved", reason="x", resolution="decision_cleared",
                ),
                episode("gpu_count", "gpu-count:h200-ci-1", observed_gpus=7, baseline_gpus=8),
                episode(
                    "gpu_count", "gpu-count:h200-ci-2", opened=timedelta(days=2),
                    resolved=timedelta(hours=2),
                ),
                episode("unreporting", "h200-ci-9"),
            ],
            scrape_buckets={"h200-ci-2": 200, "h200-ci-1": 280, "h200-ci-9": 100},
        )
    )
    assert text == "\n".join(
        [
            "📊 Daily CI infra summary — 2026-10-20",
            "Mode: h200 live, h100 live, b200 not started",
            "",
            "Changes since yesterday:",
            "• 🔒 quarantined `h200-ci-1`: Xid 79 (13:00 UTC)",
            "• 🧪 would have quarantined `h200-ci-2`: docker down",
            "• ⏸ held `inf-4x8h100-1` (pool cap): gpu hang",
            "• ✅ returned `old-1` (resolved by oncall)",
            "• 📉 `h200-ci-1` GPUs dropped: 7 of 8",
            "• 📈 `h200-ci-2` GPUs recovered",
            "• ⚠️ `h200-ci-2` scrape failing 31% (24 h)",
            "",
            "Standing:",
            "Quarantined:",
            "• `h200-ci-1` (quarantined, Xid 79, 3 h)",
            "Held (waiting for a person or a free slot):",
            "• `inf-4x8h100-1` (gpu hang)",
            "Degraded:",
            "• `h200-ci-1` 7/8",
            "• `h200-ci-2` 8/9 (exception)",
            "Not reporting:",
            "• `h200-ci-9`",
            "",
            "<https://ci.vllm.ai/gpu|GPU dashboard>",
        ]
    )


def test_an_exception_host_stays_listed_even_at_its_exception_count() -> None:
    # The exception list accepts a host's lower count; it doesn't hide the host
    # (decided 2026-10-09), so a quiet day with one is not an all-clear.
    text = render_summary(inputs(exceptions={"h200-ci-2": 8}))
    assert "Degraded:\n• `h200-ci-2` 8/8 (exception)" in text
    assert "nothing quarantined or degraded" not in text


def test_expected_count_is_the_most_ever_seen_floored_at_eight() -> None:
    low = render_summary(
        inputs(gpu_counts=counts(h200_ci_1=6), baselines={"h200-ci-1": 4})
    )
    assert "`h200-ci-1` 6/8" in low
    high = render_summary(
        inputs(gpu_counts=counts(h200_ci_1=8), baselines={"h200-ci-1": 10})
    )
    assert "`h200-ci-1` 8/10" in high
    # The exception value replaces the expected count, floor included.
    accepted = render_summary(
        inputs(gpu_counts=counts(h200_ci_1=7), exceptions={"h200-ci-1": 7})
    )
    assert "`h200-ci-1` 7/7 (exception)" in accepted


def test_non_pilot_hosts_never_count_as_degraded() -> None:
    assert "nothing changed" in render_summary(
        inputs(gpu_counts=counts(other_host=4))
    )


def test_a_silent_host_is_not_also_reported_as_a_failing_scrape() -> None:
    text = render_summary(
        inputs(
            episodes=[episode("unreporting", "h200-ci-1")],
            scrape_buckets={"h200-ci-1": 10},
        )
    )
    assert "scrape failing" not in text
    assert "Not reporting:" in text


def test_a_scrape_at_the_failing_threshold_is_flagged_and_just_under_is_not() -> None:
    assert "failing 10%" in render_summary(inputs(scrape_buckets={"h200-ci-1": 259}))
    assert "failing" not in render_summary(inputs(scrape_buckets={"h200-ci-1": 260}))


def test_old_standing_quarantine_shows_days_and_is_not_a_change() -> None:
    text = render_summary(
        inputs(
            episodes=[
                episode(
                    "quarantine", "h200-ci-1", opened=timedelta(days=5),
                    stage="quarantined", reason="Xid 79",
                )
            ]
        )
    )
    assert "Changes since yesterday" not in text
    assert "(quarantined, Xid 79, 5 d)" in text


@pytest.mark.parametrize(
    "stage", ["quarantining", "quarantined", "resolve_requested", "resolving"]
)
def test_every_out_of_service_stage_is_standing_quarantine(stage: str) -> None:
    text = render_summary(
        inputs(
            episodes=[
                episode(
                    "quarantine", "h200-ci-1", opened=timedelta(hours=48),
                    stage=stage, reason="r",
                )
            ]
        )
    )
    assert f"• `h200-ci-1` ({stage}, r, 2 d)" in text


def test_ages_switch_to_days_at_forty_eight_hours() -> None:
    def age(hours: float) -> str:
        return render_summary(
            inputs(
                episodes=[
                    episode(
                        "quarantine", "h200-ci-1", opened=timedelta(hours=hours),
                        stage="quarantined", reason="r",
                    )
                ]
            )
        )

    assert "r, 47 h)" in age(47.9)
    assert "r, 2 d)" in age(48)
    assert "r, 3 d)" in age(72)


def test_events_exactly_a_day_old_still_count_as_changes() -> None:
    text = render_summary(
        inputs(
            episodes=[
                episode(
                    "quarantine", "a", opened=timedelta(hours=24),
                    resolved=timedelta(hours=24), stage="resolved", reason="r",
                ),
                episode(
                    "gpu_count", "gpu-count:h200-ci-1", opened=timedelta(hours=24),
                    resolved=timedelta(hours=24), observed_gpus=7, baseline_gpus=8,
                ),
                episode("quarantine", "w", opened=timedelta(hours=24), stage="would", reason="r"),
                episode("quarantine", "h", opened=timedelta(hours=24), stage="held", reason="r"),
            ]
        )
    )
    assert "🔒 quarantined `a`" in text
    assert "✅ returned `a` (resolved by unknown)" in text
    assert "📉 `h200-ci-1`" in text
    assert "📈 `h200-ci-1`" in text
    assert "🧪 would have quarantined `w`" in text
    assert "⏸ held `h`" in text


def test_a_long_held_host_quarantined_today_is_a_change_aged_from_its_command() -> None:
    commanded = (NOW - timedelta(hours=2)).isoformat()
    text = render_summary(
        inputs(
            episodes=[
                episode(
                    "quarantine", "a", opened=timedelta(days=4), stage="quarantining",
                    reason="r", commanded_at=commanded,
                ),
                episode(
                    "quarantine", "b", opened=timedelta(days=4), stage="quarantined",
                    reason="r", commanded_at=(NOW - timedelta(days=3)).isoformat(),
                    quarantined_at=(NOW - timedelta(hours=1)).isoformat(),
                ),
            ]
        )
    )
    assert "🔒 quarantined `a`: r (14:00 UTC)" in text
    assert "🔒 quarantined `b`: r (15:00 UTC)" in text
    assert "`a` (quarantining, r, 2 h)" in text
    assert "`b` (quarantined, r, 1 h)" in text


def test_a_quarantine_commanded_before_the_window_is_not_a_change() -> None:
    text = render_summary(
        inputs(
            episodes=[
                episode(
                    "quarantine", "a", opened=timedelta(hours=1), stage="quarantined",
                    reason="r", commanded_at=(NOW - timedelta(days=2)).isoformat(),
                )
            ]
        )
    )
    assert "Changes since yesterday" not in text


def test_a_drop_that_recovered_has_no_counts_to_report() -> None:
    text = render_summary(
        inputs(
            episodes=[
                episode(
                    "gpu_count", "gpu-count:h200-ci-1", opened=timedelta(hours=5),
                    resolved=timedelta(hours=1), observed_gpus=8, baseline_gpus=8,
                )
            ]
        )
    )
    assert "• 📉 `h200-ci-1` GPUs dropped\n" in text
    assert "📈 `h200-ci-1` GPUs recovered" in text


def test_allocatable_below_capacity_is_degraded_on_pilot_nodes_only() -> None:
    text = render_summary(
        inputs(
            allocatable={
                "inf-4x8h100-1": (6, 8),
                "h200-ci-1": (8, 8),
                "stranger": (1, 8),
            }
        )
    )
    assert "Degraded:\n• `inf-4x8h100-1` allocatable 6/8" in text
    assert "h200-ci-1" not in text
    assert "stranger" not in text


def test_a_held_episode_that_closed_was_never_out_of_service() -> None:
    text = render_summary(
        inputs(
            episodes=[
                episode(
                    "quarantine", "a", opened=timedelta(hours=5), resolved=timedelta(hours=1),
                    stage="resolved", reason="r", resolved_while_held=True, resolved_by="me",
                ),
                episode(
                    "quarantine", "b", opened=timedelta(hours=5), resolved=timedelta(hours=1),
                    stage="resolved", reason="r", resolution="decision_cleared",
                    held_reason="pool_cap",
                ),
            ]
        )
    )
    assert "nothing changed" in text


def test_a_closed_held_episode_does_not_hide_the_ones_after_it() -> None:
    text = render_summary(
        inputs(
            episodes=[
                episode(
                    "quarantine", "a", opened=timedelta(hours=5), resolved=timedelta(hours=1),
                    stage="resolved", reason="r", resolved_while_held=True,
                ),
                episode("quarantine", "b", stage="quarantined", reason="r"),
            ]
        )
    )
    assert "🔒 quarantined `b`" in text
    assert "`a`" not in text


def test_an_offline_bare_metal_host_keeps_its_pool_from_its_last_agents() -> None:
    handler, outbox, source = handler_parts()
    source.buckets = {"h200-ci-1": 200}
    source.episodes = [
        episode("gpu_count", "gpu-count:h200-ci-1", observed_gpus=7, baseline_gpus=8)
    ]
    handler(ScheduledCommand("daily_summary", NOW))
    text = outbox.records()[0].payload["text"]
    assert "nothing changed" not in text
    assert "h200 dry run" in text
    assert "📉 `h200-ci-1` GPUs dropped: 7 of 8" in text
    assert "scrape failing 31%" in text
    assert "`h200-ci-1` 7/9" in text


def test_a_host_with_no_agent_snapshot_for_days_keeps_its_pool_from_its_quarantine() -> None:
    handler, outbox, source = handler_parts()
    source.queues = []  # past the agent table's retention
    source.episodes = [
        episode(
            "quarantine", "h200-ci-1", opened=timedelta(days=5), stage="quarantined",
            reason="Xid 79", cluster="h200", pool="h200_35gb",
        )
    ]
    handler(ScheduledCommand("daily_summary", NOW))
    text = outbox.records()[0].payload["text"]
    assert "Mode: h200 dry run, h100 not started, b200 not started" in text
    assert "`h200-ci-1` (quarantined, Xid 79, 5 d)" in text
    assert "Degraded:\n• `h200-ci-1` 7/9" in text


def test_only_quarantine_episodes_name_a_hosts_pool() -> None:
    handler, outbox, source = handler_parts()
    source.queues = []
    source.episodes = [
        episode("unreporting", "zzz", cluster="h200", pool="h200_35gb"),
        episode("quarantine", "h200-ci-1", stage="quarantined", reason="r", cluster="b200",
                pool="h200_35gb"),
    ]
    handler(ScheduledCommand("daily_summary", NOW))
    text = outbox.records()[0].payload["text"]
    assert "h200 not started" in text


def test_a_dry_run_episode_moved_to_held_today_is_a_change_with_its_hold_reason() -> None:
    text = render_summary(
        inputs(
            episodes=[
                episode(
                    "quarantine", "a", opened=timedelta(days=4), stage="held", reason="r",
                    held_reason="pool_cap",
                    commanded_at=(NOW - timedelta(hours=2)).isoformat(),
                )
            ]
        )
    )
    assert "• ⏸ held `a` (pool cap): r" in text


def test_a_node_known_only_by_its_allocatable_reading_is_still_degraded() -> None:
    handler, outbox, source = handler_parts()
    source.queues = []
    source.allocatable = {"inf-4x8h100-9": (0, 8)}
    handler(ScheduledCommand("daily_summary", NOW))
    text = outbox.records()[0].payload["text"]
    assert "• `inf-4x8h100-9` allocatable 0/8" in text
    assert "h100 dry run" in text


def test_only_the_summarys_own_hosts_are_looked_up_in_agent_snapshots() -> None:
    handler, outbox, source = handler_parts()
    source.buckets = {"h200-ci-2": 288}
    source.episodes = [episode("gpu_count", "gpu-count:h200-ci-3")]
    source.allocatable = {"inf-4x8h100-9": (8, 8)}
    handler(ScheduledCommand("daily_summary", NOW))
    assert source.asked == [
        "h200-ci-1", "h200-ci-2", "h200-ci-3", "inf-4x8h100-9"
    ]


def test_an_online_host_reported_by_fqdn_is_mapped_from_fresh_agents() -> None:
    handler, outbox, source = handler_parts()
    source.queues = []
    handler._snapshots.agent_queues = lambda: [  # type: ignore[method-assign]
        ("H200-CI-1.corp.example", "h200_35gb"),
        ("pod-7f9c", "other"),
        ("10.1.2.3", "other"),
    ]
    handler(ScheduledCommand("daily_summary", NOW))
    assert "h200 dry run" in outbox.records()[0].payload["text"]
    # The domain is passed on so an offline FQDN host is found later.
    assert source.suffixes == ["corp.example"]


def test_hostnames_normalize_like_the_dashboard() -> None:
    assert normalize_hostname(" H200-CI-3.Example.Net ") == "h200-ci-3"
    assert normalize_hostname("10.1.2.3") == "10.1.2.3"
    assert normalize_hostname("dgxb200-01") == "dgxb200-01"


def test_a_pool_that_went_dark_is_still_on_the_roster() -> None:
    handler, outbox, source = handler_parts()
    source.buckets = {"inf-4x8h100-1": 100}
    handler(ScheduledCommand("daily_summary", NOW))
    assert "h100 dry run" in outbox.records()[0].payload["text"]


def test_a_host_named_only_by_a_gpu_count_episode_is_on_the_roster() -> None:
    handler, outbox, source = handler_parts()
    source.episodes = [
        episode("gpu_count", "gpu-count:inf-4x8h100-1", observed_gpus=4, baseline_gpus=8)
    ]
    handler(ScheduledCommand("daily_summary", NOW))
    text = outbox.records()[0].payload["text"]
    assert "h100 dry run" in text
    assert "📉 `inf-4x8h100-1` GPUs dropped: 4 of 8" in text


def test_a_held_quarantine_without_a_reason_has_no_empty_parentheses() -> None:
    text = render_summary(
        inputs(episodes=[episode("quarantine", "a", stage="held", reason="r")])
    )
    assert "• ⏸ held `a`: r" in text


def test_hosts_outside_the_pools_do_not_hide_the_ones_after_them() -> None:
    text = render_summary(
        inputs(
            gpu_counts=counts(aaa=1, h200_ci_1=7),
            episodes=[
                episode("gpu_count", "gpu-count:aaa", observed_gpus=1, baseline_gpus=8),
                episode(
                    "gpu_count", "gpu-count:h200-ci-1", observed_gpus=7, baseline_gpus=8
                ),
            ],
        )
    )
    assert "📉 `h200-ci-1`" in text
    assert "`aaa`" not in text
    assert "`h200-ci-1` 7/8" in text


def test_scrape_percent_is_the_share_of_missing_buckets() -> None:
    assert "failing 100% (24 h)" in render_summary(inputs(scrape_buckets={"h200-ci-1": 0}))
    assert "failing 50% (24 h)" in render_summary(inputs(scrape_buckets={"h200-ci-1": 144}))


def test_dry_run_is_named_in_the_mode_line_and_pools_without_hosts_not_started() -> None:
    text = render_summary(
        inputs(gpu_counts=counts(h200_ci_1=7), pools={"h200-ci-1": ("h200", "q")})
    )
    assert "Mode: h200 dry run, h100 not started, b200 not started" in text


def test_the_day_is_the_pacific_day_wherever_the_worker_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TZ", "Asia/Tokyo")
    time.tzset()
    try:
        evening = datetime(2026, 10, 21, 2, 0, tzinfo=timezone.utc)  # 19:00 Pacific
        assert "— 2026-10-20" in render_summary(inputs(now=evening))
        handler, outbox, _ = handler_parts()
        handler(ScheduledCommand("daily_summary", evening))
        assert outbox.records()[0].delivery_id == "infra:daily_summary:2026-10-20"
    finally:
        monkeypatch.undo()
        time.tzset()


class FakeSource:
    def __init__(self, episodes: list[InfraAlertEpisode]) -> None:
        self.episodes = episodes
        self.since: list[datetime] = []

    def episodes_since(self, since: datetime) -> list[InfraAlertEpisode]:
        self.since.append(since)
        return self.episodes

    def expected_gpu_exceptions(self) -> dict[str, int]:
        return {}

    buckets: dict[str, int] = {}
    allocatable: dict[str, tuple[int, int]] = {}
    queues: list[tuple[str, str]] = [("h200-ci-1", "h200_35gb")]

    def last_agent_queues(
        self, hostnames: Iterable[str], suffixes: Iterable[str]
    ) -> list[tuple[str, str]]:
        self.asked = sorted(hostnames)
        self.suffixes = sorted(suffixes)
        return [q for q in self.queues if q[0] in self.asked]

    def scrape_buckets(self, since: datetime) -> dict[str, int]:
        return self.buckets

    def allocatable_gpus(self) -> dict[str, tuple[int, int]]:
        return self.allocatable


class FakeSnapshots:
    def gpu_counts(self) -> list[GpuCountObservation]:
        return counts(h200_ci_1=7)

    def agent_queues(self) -> list[tuple[str, str]]:
        return []  # no fresh agent snapshot: the host's agents are offline


def handler_parts(
    destination: str = "U123", *, live: bool | None = None
) -> tuple[DailySummaryHandler, InMemoryOutboxStore, FakeSource]:
    executions = InMemoryAutomationExecutionStore()
    outbox = InMemoryOutboxStore()
    store = InMemoryInfraStore(executions=executions, outbox=outbox)
    store._states[("gpu_count", "gpu-count:h200-ci-1")] = InfraSubjectState(
        "gpu_count", "gpu-count:h200-ci-1", details={"baseline_gpus": 9}
    )
    source = FakeSource([])
    handler = DailySummaryHandler(
        source=source,
        snapshots=FakeSnapshots(),  # type: ignore[arg-type]
        store=store,
        outbox=outbox,
        clock=FixedClock(NOW),
        destination=destination,
        delivery_mode=DeliveryMode.LIVE,
        **({} if live is None else {"quarantine_live": live}),
    )
    return handler, outbox, source


def test_handler_enqueues_one_post_per_pacific_day_to_the_destination() -> None:
    handler, outbox, source = handler_parts()
    handler(ScheduledCommand("daily_summary", NOW))
    handler(ScheduledCommand("daily_summary", NOW + timedelta(minutes=7)))

    [record] = outbox.records()
    assert record.delivery_id == "infra:daily_summary:2026-10-20"
    assert record.alert_ref == "infra:daily_summary"
    assert record.payload["blocks"][0]["text"]["text"].startswith("📊 INFRA · ")
    assert "h200 dry run" in record.payload["text"]  # quarantine is dry run by default
    assert record.destination == "U123"
    assert record.delivery_mode is DeliveryMode.LIVE
    assert "`h200-ci-1` 7/9" in record.payload["text"]
    assert source.since == [YESTERDAY, NOW + timedelta(minutes=7) - timedelta(hours=24)]


def test_handler_reports_live_only_when_quarantine_is_live() -> None:
    for live, word in ((False, "dry run"), (True, "live")):
        handler, outbox, _ = handler_parts(live=live)
        handler(ScheduledCommand("daily_summary", NOW))
        assert f"h200 {word}" in outbox.records()[0].payload["text"]


def test_each_day_gets_its_own_post() -> None:
    handler, outbox, _ = handler_parts()
    handler(ScheduledCommand("daily_summary", NOW))
    handler(ScheduledCommand("daily_summary", NOW + timedelta(days=1)))
    assert [r.delivery_id for r in outbox.records()] == [
        "infra:daily_summary:2026-10-20",
        "infra:daily_summary:2026-10-21",
    ]


class Recorder:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def __enter__(self) -> Recorder:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Recorder:
        self.calls.append((sql, params))
        return self

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows


def test_postgres_reads_map_rows_and_bound_the_window() -> None:
    recorder = Recorder(
        [(1, "quarantine", "h200-ci-1", YESTERDAY, NOW, {"stage": "held"})]
    )
    store = PostgresAlertStore(lambda: recorder)
    [found] = store.episodes_since(YESTERDAY)
    assert (
        found.alert_id, found.alert_type, found.subject_key,
        found.opened_at, found.resolved_at, found.details,
    ) == (1, "quarantine", "h200-ci-1", YESTERDAY, NOW, {"stage": "held"})
    assert recorder.calls[0][1] == (YESTERDAY, YESTERDAY)

    recorder = Recorder([("H200-CI-1", 7)])
    assert PostgresAlertStore(lambda: recorder).expected_gpu_exceptions() == {
        "h200-ci-1": 7
    }
    assert recorder.calls[0][0] == (
        "SELECT host, expected_gpus FROM alerting_expected_gpu_exceptions"
    )

    recorder = Recorder([("H200-CI-1", 280)])
    store = PostgresAlertStore(lambda: recorder)
    assert store.scrape_buckets(YESTERDAY) == {"h200-ci-1": 280}
    assert recorder.calls[0][1] == (
        YESTERDAY, YESTERDAY - timedelta(days=1), YESTERDAY,
    )

    older, newer = YESTERDAY, NOW
    recorder = Recorder(
        [
            ("h200-ci-3", older, "old_queue"),
            ("H200-CI-3.example.net", newer, "h200_35gb"),
            ("h200-ci-4", older, "h200_18gb"),
        ]
    )
    queues = PostgresAlertStore(lambda: recorder).last_agent_queues(
        ["h200-ci-3", "h200-ci-4"], ["Example.NET"]
    )
    # The FQDN in other case is the newest of h200-ci-3's candidates.
    assert queues == [
        ("H200-CI-3.example.net", "h200_35gb"),
        ("h200-ci-4", "h200_18gb"),
    ]
    assert [(h, q) for h, q in queues if normalize_hostname(h) == "h200-ci-3"] == [
        ("H200-CI-3.example.net", "h200_35gb")
    ]
    sql, (candidates,) = recorder.calls[0]
    # Matched case-blind through the lower(hostname) index, so any spelling
    # Buildkite stored is found; only the given hosts are probed, never a table
    # walk, so a pod hostname can't come back.
    assert "unnest(%s::text[])" in sql and "lower(hostname) = c.name" in sql
    assert candidates == [
        "h200-ci-3", "h200-ci-3.example.net", "h200-ci-4", "h200-ci-4.example.net",
    ]
    assert pilot_pools(["h200-ci-3"], queues)["h200-ci-3"] == ("h200", "h200_35gb")

    recorder = Recorder([("INF-4X8H100-1", 6, 8)])
    assert PostgresAlertStore(lambda: recorder).allocatable_gpus() == {
        "inf-4x8h100-1": (6, 8)
    }


def test_the_runtime_wires_one_handler_over_one_store(monkeypatch: Any) -> None:
    import alerting.daily_summary as daily_summary
    import alerting.postgres as postgres

    store = PostgresAlertStore(lambda: Recorder([]))
    built: dict[str, Any] = {}
    monkeypatch.setattr(
        postgres.PostgresAlertStore, "from_database_url",
        classmethod(lambda cls, url: built.setdefault("url", url) and store),
    )
    monkeypatch.setattr(
        daily_summary, "DailySummaryHandler",
        lambda **kwargs: built.setdefault("handler", kwargs) and "handler",
    )
    monkeypatch.setattr(
        postgres, "AlertingRuntime",
        lambda **kwargs: built.setdefault("runtime", kwargs) and "runtime",
    )
    slack, clock = RecordingSlackPort(), FixedClock(NOW)
    runtime: Any = postgres.build_daily_summary_runtime(
        database_url="postgres://db", destination="C1", slack=slack, clock=clock,
    )
    assert runtime == "runtime"
    assert built["url"] == "postgres://db"
    assert built["handler"] == {
        "source": store, "snapshots": store, "store": store, "outbox": store,
        "clock": clock, "destination": "C1",
        "delivery_mode": DeliveryMode.LIVE, "quarantine_live": False,
    }
    assert built["runtime"] == {
        "executions": store, "outbox": store, "slack": slack, "clock": clock,
        "handlers": {"daily_summary": "handler"}, "alert_path": AlertPath.INFRA,
    }
