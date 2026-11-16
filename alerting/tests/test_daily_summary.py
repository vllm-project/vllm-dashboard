"""Daily infra summary: rendering, handler wiring and its Postgres reads."""

from __future__ import annotations

import time
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from alerting.commands import ScheduledCommand
from alerting.daily_summary import (
    BUCKETS_PER_DAY,
    DailySummaryHandler,
    ScrapeBuckets,
    SummaryInputs,
    render_summary,
)
from alerting.infra import (
    AGENT_FRESHNESS,
    normalize_hostname,
    pilot_pools,
    GpuCountObservation,
    HostReport,
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


# The day's wall-clock five-minute buckets, most recent complete one first.
SLOTS = [NOW - timedelta(minutes=5) * n for n in range(1, BUCKETS_PER_DAY + 1)]


def reporting(missing: dict[str, int] | None = None) -> dict[str, frozenset[datetime]]:
    """Every pool host reports the whole day; each host in `missing` skips an
    interior run of `n` buckets (a mid-day flap, not joining or leaving)."""
    by_host: dict[str, frozenset[datetime]] = {
        host: frozenset(SLOTS) for host in POOLS
    }
    for host, n in (missing or {}).items():
        by_host[host] = frozenset(SLOTS[:100] + SLOTS[100 + n:])
    return by_host


def scrape(
    missing: dict[str, int] | None = None, *, eligible: Iterable[str] | None = None
) -> ScrapeBuckets:
    """reporting() plus eligibility from the day before: every pool host,
    unless `eligible` says otherwise."""
    return ScrapeBuckets(
        by_host=reporting(missing),
        eligible=frozenset(POOLS if eligible is None else eligible),
    )


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
        live_clusters=frozenset(),
        pools=POOLS,
        gpu_counts=counts(h200_ci_1=8, h200_ci_2=8, inf_4x8h100_1=8),
        baselines={},
        exceptions={},
        episodes=[],
        scrape_buckets=ScrapeBuckets(by_host={}, eligible=frozenset()),
        allocatable={},
        cordoned={},
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
            live_clusters=frozenset({"h200", "h100"}),
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
            scrape_buckets=ScrapeBuckets(
                by_host=reporting()
                | {
                    # 88 missed mid-day, vouched for by `h200-ci-1` reporting them.
                    "h200-ci-2": frozenset(SLOTS[:100] + SLOTS[188:]),
                    # 8 missed at a different time, under the 10% threshold.
                    "h200-ci-1": frozenset(SLOTS[:200] + SLOTS[208:]),
                    "h200-ci-9": frozenset(SLOTS[:100]),
                },
                eligible=frozenset(POOLS),
            ),
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
            scrape_buckets=ScrapeBuckets(
                by_host={k: v for k, v in reporting().items() if k != "h200-ci-1"},
                eligible=frozenset(POOLS),
            ),
        )
    )
    assert "scrape failing" not in text
    assert "Not reporting:" in text


def test_a_scrape_at_the_failing_threshold_is_flagged_and_just_under_is_not() -> None:
    assert "failing 10%" in render_summary(inputs(scrape_buckets=scrape({"h200-ci-1": 29})))
    assert "failing" not in render_summary(inputs(scrape_buckets=scrape({"h200-ci-1": 28})))


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
    source.queues = [("h200-ci-1", "h200_35gb"), ("h200-ci-2", "h200_35gb")]
    source.buckets = ScrapeBuckets(
        by_host={
            "h200-ci-1": frozenset(SLOTS[:100] + SLOTS[188:]),
            "h200-ci-2": frozenset(SLOTS),
        },
        eligible=frozenset({"h200-ci-1", "h200-ci-2"}),
    )
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


def test_a_cordoned_node_is_standing_even_on_an_otherwise_quiet_day() -> None:
    handler, outbox, source = handler_parts()
    source.queues = [("inf-4x8h100-1", "mithril-h100-pool")]
    source.allocatable = {"inf-4x8h100-1": (8, 8)}
    source.cordoned = {"inf-4x8h100-1": NOW - timedelta(days=5)}
    handler(ScheduledCommand("daily_summary", NOW))
    text = outbox.records()[0].payload["text"]
    assert "Cordoned:\n• `inf-4x8h100-1` (5 d)" in text


def test_only_the_summarys_own_hosts_are_looked_up_in_agent_snapshots() -> None:
    handler, outbox, source = handler_parts()
    source.buckets = ScrapeBuckets(
        by_host={"h200-ci-2": frozenset(SLOTS)}, eligible=frozenset()
    )
    source.episodes = [episode("gpu_count", "gpu-count:h200-ci-3")]
    source.allocatable = {"inf-4x8h100-9": (8, 8)}
    handler(ScheduledCommand("daily_summary", NOW))
    assert source.asked == [
        "h200-ci-1", "h200-ci-2", "h200-ci-3", "inf-4x8h100-9"
    ]
    # however old: a host keeps its pool past the infra scan's window.
    assert source.agents_since is None


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


def test_hostnames_normalize_like_the_dashboard() -> None:
    assert normalize_hostname(" H200-CI-3.Example.Net ") == "h200-ci-3"
    assert normalize_hostname("10.1.2.3") == "10.1.2.3"
    assert normalize_hostname("dgxb200-01") == "dgxb200-01"


def test_a_pool_that_went_dark_is_still_on_the_roster() -> None:
    handler, outbox, source = handler_parts()
    # Eligible from the day before but reported nothing since: the roster
    # still names its pool.
    source.buckets = ScrapeBuckets(by_host={}, eligible=frozenset({"inf-4x8h100-1"}))
    handler(ScheduledCommand("daily_summary", NOW))
    assert "h100 dry run" in outbox.records()[0].payload["text"]


def test_the_scrape_window_starts_at_the_first_aligned_slot() -> None:
    # The bucket grid starts at the five-minute floor of now minus a day; the
    # store must be asked from exactly there, or an unaligned run loses the
    # first expected slot (and the eligibility day before it stays whole).
    handler, _, source = handler_parts()
    handler(ScheduledCommand("daily_summary", NOW + timedelta(minutes=7)))
    assert source.scrape_since == [YESTERDAY + timedelta(minutes=5)]


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
    # A host that reported only the day's first and last bucket: every
    # interior bucket is its own covered miss. (100% is unreachable: a
    # host's own first and last buckets bound its span.)
    nearly_all = ScrapeBuckets(
        by_host=reporting() | {"h200-ci-1": frozenset({SLOTS[0], SLOTS[-1]})},
        eligible=frozenset(POOLS),
    )
    assert "failing 99% (24 h)" in render_summary(inputs(scrape_buckets=nearly_all))
    assert "failing 50% (24 h)" in render_summary(
        inputs(scrape_buckets=scrape({"h200-ci-1": 144}))
    )


def test_a_stretch_no_h200_host_reported_is_charged_when_the_fleet_reported() -> None:
    # Each h200 host reports for itself; the shared-scraper nodes reporting
    # the same stretch prove the ingestion pipeline was up, so every h200
    # host's miss is its own.
    by_host = reporting()
    for host in ("h200-ci-1", "h200-ci-2"):
        by_host[host] = frozenset(SLOTS[:100] + SLOTS[140:])
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(POOLS))
    text = render_summary(inputs(scrape_buckets=buckets))
    assert "`h200-ci-1` scrape failing 14%" in text
    assert "`h200-ci-2` scrape failing 14%" in text


def test_a_single_h200_host_warns_when_the_fleet_keeps_reporting() -> None:
    # The only h200 host missing a stretch while the k8s scraper reports:
    # ingestion was up, so the misses are the host's own.
    pools = {
        "h200-ci-1": ("h200", "h200_35gb"),
        "inf-4x8h100-1": ("h100", "mithril-h100-pool"),
    }
    buckets = ScrapeBuckets(
        by_host={
            "h200-ci-1": frozenset(SLOTS[:100] + SLOTS[140:]),
            "inf-4x8h100-1": frozenset(SLOTS),
        },
        eligible=frozenset(pools),
    )
    assert "`h200-ci-1` scrape failing 14%" in render_summary(
        inputs(pools=pools, scrape_buckets=buckets)
    )


def test_a_gap_is_the_hosts_own_when_a_peer_reported_it() -> None:
    # Each h200 host reports independently: one peer reporting a bucket
    # proves the pipeline was up, so the other host's miss is charged to it.
    text = render_summary(inputs(scrape_buckets=scrape({"h200-ci-1": 40})))
    assert "`h200-ci-1` scrape failing 14%" in text
    assert "`h200-ci-2` scrape" not in text


def test_two_independent_reporters_flapping_together_are_both_charged() -> None:
    # Two of three h200 hosts missing the same stretch while the third
    # reports is two host failures, not a central outage.
    by_host = {host: frozenset(SLOTS) for host in THREE_H200}
    for host in ("h200-ci-1", "h200-ci-3"):
        by_host[host] = frozenset(SLOTS[:100] + SLOTS[140:])
    text = render_summary(
        inputs(
            pools=THREE_H200,
            scrape_buckets=ScrapeBuckets(
                by_host=by_host, eligible=frozenset(THREE_H200)
            ),
        )
    )
    assert "`h200-ci-1` scrape failing 14%" in text
    assert "`h200-ci-3` scrape failing 14%" in text
    assert "`h200-ci-2` scrape" not in text


def test_ingestion_gaps_plus_a_small_host_gap_stay_under_the_threshold() -> None:
    # Most of the host's missing buckets are ones no host anywhere reported
    # (the ingestion pipeline down), the rest its own; only the host-only
    # share counts toward the 10% threshold.
    by_host = reporting()
    for host in POOLS:
        by_host[host] = frozenset(SLOTS[:100] + SLOTS[119:])
    by_host["h200-ci-1"] = frozenset(SLOTS[:100] + SLOTS[119:130] + SLOTS[143:])
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(POOLS))
    assert "scrape failing" not in render_summary(inputs(scrape_buckets=buckets))


def test_a_new_host_is_not_expected_before_its_first_bucket() -> None:
    # Not eligible from the day before: a genuinely new host is measured
    # from its first bucket on.
    by_host = reporting()
    by_host["h200-ci-1"] = frozenset(SLOTS[:144])
    buckets = ScrapeBuckets(
        by_host=by_host, eligible=frozenset({"h200-ci-2", "inf-4x8h100-1"})
    )
    assert "scrape failing" not in render_summary(inputs(scrape_buckets=buckets))
    # Gaps inside its span still count.
    by_host["h200-ci-1"] = frozenset(SLOTS[:100] + SLOTS[129:144])
    assert "scrape failing 10%" in render_summary(inputs(scrape_buckets=buckets))


def test_an_eligible_host_that_returns_is_charged_for_its_start_gap() -> None:
    # Eligible from the day before: expected for the whole window, so the
    # half-day it was dead before returning counts — the same buckets as a
    # new host, with the opposite outcome.
    by_host = reporting()
    by_host["h200-ci-1"] = frozenset(SLOTS[:144])
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(POOLS))
    assert "`h200-ci-1` scrape failing 50%" in render_summary(
        inputs(scrape_buckets=buckets)
    )


def test_trailing_silence_after_the_last_bucket_is_unreportings_job() -> None:
    # Spans end at the host's last bucket of the day: trailing silence is
    # not a flap, for an eligible host and for a genuinely new one alike.
    # Sustained silence is the unreporting alert's job, and an open
    # unreporting episode still suppresses this line.
    by_host = reporting()
    by_host["h200-ci-1"] = frozenset(SLOTS[144:])  # oldest half only
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(POOLS))
    assert "scrape failing" not in render_summary(inputs(scrape_buckets=buckets))
    new_host = ScrapeBuckets(
        by_host=by_host, eligible=frozenset({"h200-ci-2", "inf-4x8h100-1"})
    )
    assert "scrape failing" not in render_summary(inputs(scrape_buckets=new_host))


def test_an_eligible_host_silent_all_window_is_never_charged() -> None:
    # Eligible but nothing today: a removed or long-dead host has no
    # expected slots — its silence belongs to the unreporting alert and the
    # roster, not the flap percentage, even with its cluster healthy.
    by_host = reporting()
    del by_host["h200-ci-1"]
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(POOLS))
    assert "scrape failing" not in render_summary(inputs(scrape_buckets=buckets))


THREE_H200 = {
    "h200-ci-1": ("h200", "h200_35gb"),
    "h200-ci-2": ("h200", "h200_35gb"),
    "h200-ci-3": ("h200", "h200_35gb"),
    "inf-4x8h100-1": ("h100", "mithril-h100-pool"),
}

TWO_H100 = {
    "inf-4x8h100-1": ("h100", "mithril-h100-pool"),
    "inf-4x8h100-2": ("h100", "mithril-h100-pool"),
}

THREE_H100 = {
    "inf-4x8h100-1": ("h100", "mithril-h100-pool"),
    "inf-4x8h100-2": ("h100", "mithril-h100-pool"),
    "inf-4x8h100-3": ("h100", "mithril-h100-pool"),
    "h200-ci-1": ("h200", "h200_35gb"),
}


def test_no_buckets_in_the_window_means_no_host_is_charged() -> None:
    # Nothing reported anywhere: for hosts that each report for themselves,
    # no bucket can be told apart from the pipeline being down. (A
    # single-host shared-scraper pool has no way to tell and is charged
    # directly — see the shared-scraper tests.)
    pools = {"h200-ci-1": ("h200", "h200_35gb"), "h200-ci-2": ("h200", "h200_35gb")}
    buckets = ScrapeBuckets(by_host={}, eligible=frozenset(pools))
    assert "scrape failing" not in render_summary(
        inputs(pools=pools, scrape_buckets=buckets)
    )


def test_a_shared_scraper_outage_is_not_charged_to_its_nodes() -> None:
    # One control-plane scraper reports every h100 node: all nodes missing
    # the same stretch is the scraper down, not the hosts. Once a majority
    # reports, the remaining miss is the host's own.
    by_host = {host: frozenset(SLOTS) for host in TWO_H100}
    for host in TWO_H100:
        by_host[host] = frozenset(SLOTS[:100] + SLOTS[140:])
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(TWO_H100))
    assert "scrape failing" not in render_summary(
        inputs(pools=TWO_H100, scrape_buckets=buckets)
    )
    by_host["inf-4x8h100-2"] = frozenset(SLOTS)
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(TWO_H100))
    assert "`inf-4x8h100-1` scrape failing 14%" in render_summary(
        inputs(pools=TWO_H100, scrape_buckets=buckets)
    )


def test_a_third_of_the_shared_scrapers_nodes_reporting_is_not_a_majority() -> None:
    # One of three nodes reported by the shared scraper: not a majority, so
    # the missing two are not charged — the scraper may be limping.
    by_host = {host: frozenset(SLOTS) for host in THREE_H100}
    by_host["inf-4x8h100-1"] = frozenset(SLOTS[:100] + SLOTS[140:])
    by_host["inf-4x8h100-2"] = frozenset(SLOTS[:100] + SLOTS[140:])
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(THREE_H100))
    assert "scrape failing" not in render_summary(
        inputs(pools=THREE_H100, scrape_buckets=buckets)
    )


def test_a_single_host_shared_scraper_pool_still_warns() -> None:
    # With fewer than two expected hosts there is no majority to prove a
    # scraper outage, so the host's misses are charged directly.
    pools = {"inf-4x8h100-1": ("h100", "mithril-h100-pool")}
    buckets = ScrapeBuckets(
        by_host={"inf-4x8h100-1": frozenset(SLOTS[:100] + SLOTS[140:])},
        eligible=frozenset(pools),
    )
    assert "scrape failing 14%" in render_summary(
        inputs(pools=pools, scrape_buckets=buckets)
    )


def test_silent_nodes_do_not_dilute_coverage_for_the_live_one() -> None:
    # Nodes with an open unreporting episode belong to the unreporting alert:
    # they neither get this warning nor count toward their cluster's expected
    # hosts — or two silent nodes would suppress the live node's flap.
    pools = {
        "inf-4x8h100-2": ("h100", "mithril-h100-pool"),
        "inf-4x8h100-3": ("h100", "mithril-h100-pool"),
        "inf-4x8h100-1": ("h100", "mithril-h100-pool"),
    }
    by_host = {host: frozenset(SLOTS) for host in pools}
    by_host["inf-4x8h100-1"] = frozenset(SLOTS[:100] + SLOTS[140:])
    by_host["inf-4x8h100-2"] = frozenset()
    by_host["inf-4x8h100-3"] = frozenset()
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(pools))
    text = render_summary(
        inputs(
            pools=pools,
            scrape_buckets=buckets,
            episodes=[
                episode("unreporting", "inf-4x8h100-2"),
                episode("unreporting", "inf-4x8h100-3"),
            ],
        )
    )
    assert "`inf-4x8h100-1` scrape failing 14%" in text
    assert "`inf-4x8h100-2` scrape" not in text


def test_a_pool_host_that_never_reported_does_not_hide_the_rest() -> None:
    # Never reported and not eligible from the day before: not measured, and
    # the hosts after it still are.
    pools = {
        "h200-ci-0": ("h200", "h200_35gb"),
        "h200-ci-1": ("h200", "h200_35gb"),
        "h200-ci-2": ("h200", "h200_35gb"),
    }
    buckets = ScrapeBuckets(
        by_host={
            "h200-ci-1": frozenset(SLOTS[:100] + SLOTS[140:]),
            "h200-ci-2": frozenset(SLOTS),
        },
        eligible=frozenset({"h200-ci-1", "h200-ci-2"}),
    )
    assert "`h200-ci-1` scrape failing 14%" in render_summary(
        inputs(pools=pools, scrape_buckets=buckets)
    )


def test_a_joining_hosts_first_bucket_counts_toward_shared_coverage() -> None:
    # A new h100 node joined mid-day. At its first bucket it is expected and
    # the scraper reported it while both other nodes miss it: one of three
    # expected is not a majority, so the miss is not charged to them.
    by_host = {host: frozenset(SLOTS) for host in THREE_H100}
    by_host["inf-4x8h100-3"] = frozenset(SLOTS[:100])
    by_host["inf-4x8h100-1"] = frozenset(SLOTS[:99] + SLOTS[100:150] + SLOTS[178:])
    by_host["inf-4x8h100-2"] = frozenset(SLOTS[:99] + SLOTS[100:])
    buckets = ScrapeBuckets(
        by_host=by_host,
        eligible=frozenset({"inf-4x8h100-1", "inf-4x8h100-2", "h200-ci-1"}),
    )
    assert "scrape failing" not in render_summary(
        inputs(pools=THREE_H100, scrape_buckets=buckets)
    )


def test_the_days_first_slot_counts_for_an_eligible_host() -> None:
    # An eligible host missing the day's first bucket plus 28 interior ones
    # crosses the 10% threshold only if the first slot is expected.
    by_host = reporting({"h200-ci-1": 28})
    by_host["h200-ci-1"] = by_host["h200-ci-1"] - {SLOTS[-1]}
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(POOLS))
    assert "scrape failing 10%" in render_summary(inputs(scrape_buckets=buckets))


def test_a_hosts_last_bucket_counts_toward_shared_coverage() -> None:
    # inf-4x8h100-3 last reported at SLOTS[100]. That bucket it is still
    # expected and reporting while both other nodes miss it: one of three
    # expected is not a majority, so the miss is not charged to them.
    by_host = {host: frozenset(SLOTS) for host in THREE_H100}
    by_host["inf-4x8h100-3"] = frozenset(SLOTS[100:])
    by_host["inf-4x8h100-1"] = frozenset(SLOTS[:100] + SLOTS[101:150] + SLOTS[178:])
    by_host["inf-4x8h100-2"] = frozenset(SLOTS[:100] + SLOTS[101:])
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(THREE_H100))
    assert "scrape failing" not in render_summary(
        inputs(pools=THREE_H100, scrape_buckets=buckets)
    )


def test_a_cluster_of_only_new_hosts_still_measures_their_spans() -> None:
    # No host eligible from the day before: slots before anyone's first
    # bucket have no expected host and must not stop the rest of the day
    # from being measured.
    pools = {"h200-ci-1": ("h200", "h200_35gb"), "h200-ci-2": ("h200", "h200_35gb")}
    by_host = {
        "h200-ci-1": frozenset(SLOTS[:100] + SLOTS[129:144]),
        "h200-ci-2": frozenset(SLOTS[:144]),
    }
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset())
    assert "`h200-ci-1` scrape failing 10%" in render_summary(
        inputs(pools=pools, scrape_buckets=buckets)
    )


def test_the_days_slots_stay_wall_clock_aligned_for_an_unaligned_run() -> None:
    # Rollup buckets are UTC wall-clock aligned; a run at :07 must expect the
    # aligned slots or no reported bucket ever matches one.
    now = NOW + timedelta(minutes=7)
    end = NOW + timedelta(minutes=5)  # 16:05, the five-minute floor of 16:07
    aligned = [end - timedelta(minutes=5) * n for n in range(1, BUCKETS_PER_DAY + 1)]
    by_host = {host: frozenset(aligned) for host in POOLS}
    by_host["h200-ci-1"] = frozenset(aligned[:100] + aligned[129:])
    buckets = ScrapeBuckets(by_host=by_host, eligible=frozenset(POOLS))
    assert "scrape failing 10%" in render_summary(
        inputs(now=now, scrape_buckets=buckets)
    )


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
        self.scrape_since: list[datetime] = []

    def episodes_since(self, since: datetime) -> list[InfraAlertEpisode]:
        self.since.append(since)
        return self.episodes

    def expected_gpu_exceptions(self) -> dict[str, int]:
        return {}

    buckets = ScrapeBuckets(by_host={}, eligible=frozenset())
    allocatable: dict[str, tuple[int, int]] = {}
    queues: list[tuple[str, str]] = [("h200-ci-1", "h200_35gb")]

    def last_agent_queues(
        self, hostnames: Iterable[str], *, since: datetime | None = None
    ) -> list[tuple[str, str]]:
        self.asked = sorted(hostnames)
        self.agents_since = since
        return [q for q in self.queues if q[0] in self.asked]

    def scrape_buckets(self, since: datetime) -> ScrapeBuckets:
        self.scrape_since.append(since)
        return self.buckets

    def allocatable_gpus(self) -> dict[str, tuple[int, int]]:
        return self.allocatable

    cordoned: dict[str, datetime] = {}

    def cordoned_hosts(self) -> dict[str, datetime]:
        return self.cordoned


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
        **({} if live is None else {"quarantine_live_clusters": frozenset({"h200"}) if live else frozenset()}),
    )
    return handler, outbox, source


def test_mode_line_names_each_pools_own_mode() -> None:
    text = render_summary(
        inputs(
            live_clusters=frozenset({"h100"}),
            episodes=[episode("quarantine", "h200-ci-1", stage="would", reason="x")],
        )
    )
    assert "Mode: h200 dry run, h100 live, b200 not started" in text


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

    def fetchone(self) -> tuple[Any, ...] | None:
        return self.rows[0] if self.rows else None


def test_postgres_scrape_buckets_give_each_hosts_buckets() -> None:
    on_edge = YESTERDAY
    inside = YESTERDAY + timedelta(hours=12)
    recorder = Recorder(
        [
            # Mixed case, a bucket exactly on the window edge and one inside,
            # and eligible from the day before.
            ("H200-CI-1", [on_edge, inside], True),
            # The same host under another casing: buckets merge, and it stays
            # eligible though this casing's group saw nothing before.
            ("h200-ci-1", [inside + timedelta(hours=1)], False),
            # Eligible but silent all window: not padded into by_host.
            ("h200-ci-2", None, True),
            # Reported today but nothing the day before: new, not eligible.
            ("h200-ci-3", [inside], False),
        ]
    )
    buckets = PostgresAlertStore(lambda: recorder).scrape_buckets(YESTERDAY)
    assert buckets == ScrapeBuckets(
        by_host={
            "h200-ci-1": frozenset({on_edge, inside, inside + timedelta(hours=1)}),
            "h200-ci-3": frozenset({inside}),
        },
        eligible=frozenset({"h200-ci-1", "h200-ci-2"}),
    )
    # One two-day scan: window buckets by FILTER, eligibility by bool_or, so
    # there is no second query a fake connection could confuse it with.
    assert len(recorder.calls) == 1
    sql, params = recorder.calls[0]
    assert "array_agg(DISTINCT time_bucket) FILTER (WHERE time_bucket >= %s)" in sql
    assert "bool_or(time_bucket < %s)" in sql
    assert params == (YESTERDAY, YESTERDAY, YESTERDAY - timedelta(days=1))


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

    # The database returns the newest snapshot per host, whatever its spelling.
    recorder = Recorder(
        [("H200-CI-3.example.net", "h200_35gb"), ("h200-ci-4", "h200_18gb")]
    )
    queues = PostgresAlertStore(lambda: recorder).last_agent_queues(
        ["H200-CI-3", "h200-ci-4.example.net", "h200-ci-3"]
    )
    assert queues == [
        ("H200-CI-3.example.net", "h200_35gb"),
        ("h200-ci-4", "h200_18gb"),
    ]
    sql, (names, since) = recorder.calls[0]
    # The daily summary looks back however far the table goes.
    assert since is None
    # Each host is one probe by its short lower-case name, through the
    # short-name index, so an FQDN under any domain is found without knowing
    # the domain; only the given hosts are probed, never a table walk, so a
    # pod hostname can't come back.
    assert "unnest(%s::text[])" in sql
    assert "split_part(lower(hostname), '.', 1) = c.name" in sql
    assert names == ["h200-ci-3", "h200-ci-4"]
    assert pilot_pools(["h200-ci-3"], queues)["h200-ci-3"] == ("h200", "h200_35gb")

    # The scan's "inventory is fresh" window is agent_queues' connected one.
    recorder = Recorder([])
    PostgresAlertStore(lambda: recorder).agent_queues()
    assert "polled_at >= now() - interval '15 minutes'" in recorder.calls[0][0]
    assert AGENT_FRESHNESS == timedelta(minutes=15)

    # When agents were last polled: one max() over the polled_at index.
    recorder = Recorder([(NOW,)])
    assert PostgresAlertStore(lambda: recorder).agents_polled_at() == NOW
    assert recorder.calls[0][0] == "SELECT max(polled_at) FROM buildkite_agent_snapshots"
    assert PostgresAlertStore(lambda: Recorder([])).agents_polled_at() is None

    # The infra scan bounds the lookup to agents seen since a time.
    recorder = Recorder([])
    PostgresAlertStore(lambda: recorder).last_agent_queues(
        ["h200-ci-3"], since=YESTERDAY
    )
    sql, (_, since) = recorder.calls[0]
    assert "AND polled_at >= coalesce(%s::timestamptz, '-infinity')" in sql
    assert since == YESTERDAY

    recorder = Recorder([("INF-4X8H100-1", 6, 8)])
    assert PostgresAlertStore(lambda: recorder).allocatable_gpus() == {
        "inf-4x8h100-1": (6, 8)
    }

    recorder = Recorder([("DGXB200-11", YESTERDAY)])
    assert PostgresAlertStore(lambda: recorder).cordoned_hosts() == {
        "dgxb200-11": YESTERDAY
    }
    sql, _ = recorder.calls[0]
    # The latest fresh reading decides, as on the /gpu page's Cordoned chip.
    assert "DISTINCT ON (hostname)" in sql and "interval '10 minutes'" in sql
    assert "WHERE (latest.node_conditions->>'unschedulable')::boolean" in sql
    # Cordoned since the first history bucket after the last schedulable one.
    assert "FROM host_history_5m" in sql
    assert "(u.node_conditions->>'unschedulable')::boolean IS FALSE" in sql


def test_postgres_latest_reports_never_aggregates_the_per_sample_column() -> None:
    recorder = Recorder([("H200-CI-1", NOW), ("h200-ci-2", YESTERDAY)])
    reports = PostgresAlertStore(lambda: recorder).latest_reports()
    assert reports == [
        HostReport(hostname="H200-CI-1", reported_at=NOW),
        HostReport(hostname="h200-ci-2", reported_at=YESTERDAY),
    ]
    # Aggregating the per-sample receipt column heap-fetches every rollup
    # row in the window; the per-host newest row may still be read by key.
    sql, _ = recorder.calls[0]
    assert "max(latest_reported_at)" not in sql
    # The shape that avoids it: aggregate only the index-covered bucket,
    # join the newest bucket back by primary key, bound on both sides.
    assert "max(time_bucket)" in sql
    assert "USING (time_bucket, hostname)" in sql
    assert "h.time_bucket >= now() - interval '14 days'" in sql


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
        "delivery_mode": DeliveryMode.LIVE, "quarantine_live_clusters": frozenset(),
    }
    assert built["runtime"] == {
        "executions": store, "outbox": store, "slack": slack, "clock": clock,
        "handlers": {"daily_summary": "handler"}, "alert_path": AlertPath.INFRA,
    }


def test_cordoned_pilot_nodes_are_standing_unless_already_quarantined() -> None:
    text = render_summary(
        inputs(
            cordoned={
                "inf-4x8h100-1": NOW - timedelta(hours=7),
                "h200-ci-2": NOW,
                "stranger": NOW,
            },
            episodes=[
                episode("quarantine", "h200-ci-2", stage="quarantined", reason="r")
            ],
        )
    )
    # The quarantine already lists its own cordon; non-pilot nodes stay out.
    assert (
        "Quarantined:\n• `h200-ci-2` (quarantined, r, 3 h)\n"
        "Cordoned:\n• `inf-4x8h100-1` (7 h)\n\n<"
    ) in text
    assert "stranger" not in text
