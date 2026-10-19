"""Daily infra summary: rendering, handler wiring and its Postgres reads."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from alerting.commands import ScheduledCommand
from alerting.daily_summary import (
    DailySummaryHandler,
    SummaryInputs,
    render_summary,
)
from alerting.infra import (
    GpuCountObservation,
    InfraAlertEpisode,
    InfraSubjectState,
)
from alerting.memory import (
    FixedClock,
    InMemoryAutomationExecutionStore,
    InMemoryInfraStore,
    InMemoryOutboxStore,
)
from alerting.ports import DeliveryMode
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


def test_expected_count_is_the_most_ever_seen_floored_at_eight() -> None:
    low = render_summary(
        inputs(gpu_counts=counts(h200_ci_1=6), baselines={"h200-ci-1": 4})
    )
    assert "`h200-ci-1` 6/8" in low
    high = render_summary(
        inputs(gpu_counts=counts(h200_ci_1=8), baselines={"h200-ci-1": 10})
    )
    assert "`h200-ci-1` 8/10" in high
    # A count at its exception value is not degraded.
    ok = render_summary(
        inputs(gpu_counts=counts(h200_ci_1=7), exceptions={"h200-ci-1": 7})
    )
    assert "nothing changed" in ok


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


class FakeSource:
    def __init__(self, episodes: list[InfraAlertEpisode]) -> None:
        self.episodes = episodes
        self.since: list[datetime] = []

    def episodes_since(self, since: datetime) -> list[InfraAlertEpisode]:
        self.since.append(since)
        return self.episodes

    def expected_gpu_exceptions(self) -> dict[str, int]:
        return {}

    def scrape_buckets(self, since: datetime) -> dict[str, int]:
        return {}


class FakeSnapshots:
    def gpu_counts(self) -> list[GpuCountObservation]:
        return counts(h200_ci_1=7)

    def agent_queues(self) -> list[tuple[str, str]]:
        return [("h200-ci-1", "h200_35gb")]


def handler_parts(
    destination: str = "U123",
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
    )
    return handler, outbox, source


def test_handler_enqueues_one_post_per_pacific_day_to_the_destination() -> None:
    handler, outbox, source = handler_parts()
    handler(ScheduledCommand("daily_summary", NOW))
    handler(ScheduledCommand("daily_summary", NOW + timedelta(minutes=7)))

    [record] = outbox.records()
    assert record.delivery_id == "infra:daily_summary:2026-10-20"
    assert record.destination == "U123"
    assert record.delivery_mode is DeliveryMode.LIVE
    assert "`h200-ci-1` 7/9" in record.payload["text"]
    assert source.since == [YESTERDAY, NOW + timedelta(minutes=7) - timedelta(hours=24)]


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
    recorder = Recorder([(1, "quarantine", "h200-ci-1", NOW, None, {"stage": "held"})])
    store = PostgresAlertStore(lambda: recorder)
    [found] = store.episodes_since(YESTERDAY)
    assert (found.alert_id, found.subject_key, found.details) == (
        1, "h200-ci-1", {"stage": "held"},
    )
    assert recorder.calls[0][1] == (YESTERDAY, YESTERDAY)

    recorder = Recorder([("H200-CI-1", 7)])
    assert PostgresAlertStore(lambda: recorder).expected_gpu_exceptions() == {
        "h200-ci-1": 7
    }

    recorder = Recorder([("H200-CI-1", 280)])
    store = PostgresAlertStore(lambda: recorder)
    assert store.scrape_buckets(YESTERDAY) == {"h200-ci-1": 280}
    assert recorder.calls[0][1] == (YESTERDAY, YESTERDAY + timedelta(minutes=10))
