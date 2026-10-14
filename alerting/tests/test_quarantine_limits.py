"""Quarantine safety limits (design §4.3), planned one scan at a time."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

from alerting.infra import (
    InfraAlertEpisode,
    InfraScanPlan,
    QuarantineDecision,
    infra_notifications,
    plan_quarantine,
)
from alerting.ports import DeliveryMode

NOW = datetime(2026, 9, 2, 10, 0, tzinfo=timezone.utc)


def decision(
    host: str, pool: str = "pool-a", *, hardware: bool = False
) -> QuarantineDecision:
    return QuarantineDecision(
        host=host,
        cluster="h200",
        pool=pool,
        reason="the GPU query hung on 2 consecutive checks",
        hardware=hardware,
    )


def episode(
    host: str,
    stage: str,
    *,
    pool: str = "pool-a",
    commanded: timedelta = timedelta(hours=3),
) -> InfraAlertEpisode:
    return InfraAlertEpisode(
        alert_type="quarantine",
        subject_key=host,
        opened_at=NOW - commanded,
        details={
            "stage": stage,
            "pool": pool,
            "reason": "the GPU query hung on 2 consecutive checks",
            "commanded_at": (NOW - commanded).isoformat(),
        },
    )


def plan(
    decisions: list[QuarantineDecision],
    sizes: dict[str, int],
    episodes: list[InfraAlertEpisode] = [],
    *,
    live: bool = True,
) -> InfraScanPlan:
    return plan_quarantine(
        now=NOW,
        live=live,
        decisions=decisions,
        states={},
        open_episodes={(e.alert_type, e.subject_key): e for e in episodes},
        pool_sizes=sizes,
    )


def opened(result: InfraScanPlan) -> dict[str, tuple[str, object]]:
    return {
        e.subject_key: (e.details["stage"], e.details.get("held_reason"))
        for e in result.opened
    }


def texts(result: InfraScanPlan) -> list[str]:
    return [
        intent.payload["text"]
        for intent in infra_notifications(result, delivery_mode=DeliveryMode.LIVE)
    ]


def test_a_pool_keeps_at_most_a_quarter_out() -> None:
    result = plan(
        [decision("host-1"), decision("host-2"), decision("host-3")], {"pool-a": 8}
    )
    assert opened(result) == {
        "host-1": ("quarantining", None),
        "host-2": ("quarantining", None),
        "host-3": ("held", "pool_cap"),
    }
    assert texts(result)[-1] == (
        ":double_vertical_bar: *Quarantine held* (pool cap) — `host-3` keeps "
        "serving and is quarantined once a slot frees if this still holds: "
        "the GPU query hung on 2 consecutive checks"
    )


def test_hosts_already_out_take_cap_slots() -> None:
    for stage in ("quarantining", "quarantined", "resolving"):
        result = plan([decision("host-2")], {"pool-a": 4}, [episode("host-1", stage)])
        assert opened(result) == {"host-2": ("held", "pool_cap")}, stage
    result = plan(
        [decision("host-2"), decision("host-3")],
        {"pool-a": 8},
        [episode("host-1", "quarantined")],
    )
    assert opened(result) == {
        "host-2": ("quarantining", None),
        "host-3": ("held", "pool_cap"),
    }
    # Held, would and other pools' quarantines take no slot.
    result = plan(
        [decision("host-2")],
        {"pool-a": 4},
        [episode("host-1", "held"), episode("host-9", "quarantined", pool="pool-b")],
    )
    assert opened(result) == {"host-2": ("quarantining", None)}


def test_a_small_pool_still_allows_one() -> None:
    result = plan([decision("host-1"), decision("host-2")], {"pool-a": 3})
    assert opened(result) == {
        "host-1": ("quarantining", None),
        "host-2": ("held", "pool_cap"),
    }
    # 2 of 7 would be over a quarter.
    result = plan([decision("host-1"), decision("host-2")], {"pool-a": 7})
    assert opened(result) == {
        "host-1": ("quarantining", None),
        "host-2": ("held", "pool_cap"),
    }


def test_held_hosts_then_hardware_faults_take_a_slot_first() -> None:
    result = plan(
        [decision("host-1"), decision("host-9")],
        {"pool-a": 4},
        [episode("host-9", "held")],
    )
    assert opened(result) == {"host-1": ("held", "pool_cap")}
    [change] = result.stage_changes
    assert change.episode.subject_key == "host-9"
    assert change.patch["stage"] == "quarantining"

    result = plan(
        [decision("host-1"), decision("host-2", hardware=True)], {"pool-a": 4}
    )
    assert opened(result) == {
        "host-1": ("held", "pool_cap"),
        "host-2": ("quarantining", None),
    }


def test_hosts_already_out_are_not_counted_again() -> None:
    out = [episode(f"host-{n}", "quarantined") for n in (1, 2, 3)]
    result = plan([decision(f"host-{n}") for n in (1, 2, 3, 4)], {"pool-a": 40}, out)
    assert opened(result) == {"host-4": ("quarantining", None)}
    assert result.stage_changes == ()


def test_the_last_serving_host_is_held_unless_its_gpu_is_broken() -> None:
    result = plan([decision("host-1")], {"pool-a": 1})
    assert opened(result) == {"host-1": ("held", "last_host")}
    assert "(last serving host in its pool)" in texts(result)[0]

    result = plan([decision("host-1", hardware=True)], {"pool-a": 1})
    assert opened(result) == {"host-1": ("quarantining", None)}
    assert result.opened[0].details["paged"] is True
    assert texts(result)[0].endswith(
        "\nIt is the last serving host in its pool; this pages a person."
    )

    # With another host serving, it is not the last one.
    result = plan([decision("host-1")], {"pool-a": 2})
    assert opened(result) == {"host-1": ("quarantining", None)}

    # A pool nothing maps is treated as one whose last host this is.
    result = plan([decision("host-1", pool="pool-x")], {})
    assert opened(result) == {"host-1": ("held", "last_host")}


def test_the_breaker_holds_every_new_quarantine_and_posts_once() -> None:
    sizes = {"pool-a": 40, "pool-b": 40}
    result = plan(
        [decision(f"host-{n}", "pool-a" if n % 2 else "pool-b") for n in range(1, 5)],
        sizes,
    )
    assert set(opened(result).values()) == {("held", "detector_suspect")}
    [post] = texts(result)
    assert post.startswith(
        ":warning: *Quarantine detector suspect* — 4 new quarantines within an hour"
    )
    assert post.endswith(
        "(limit 3), so none from this scan were applied. "
        "Held: `host-1`, `host-2`, `host-3`, `host-4`"
    )


def test_the_breaker_allows_three_and_counts_paged_ones() -> None:
    sizes = {"pool-a": 40, "pool-b": 1}
    three = [decision(f"host-{n}") for n in (1, 2, 3)]
    result = plan(three, sizes)
    assert set(opened(result).values()) == {("quarantining", None)}

    paged = decision("host-4", "pool-b", hardware=True)
    result = plan([*three, paged], sizes)
    assert set(opened(result).values()) == {("held", "detector_suspect")}


def test_the_breaker_counts_quarantines_of_the_past_hour() -> None:
    recent = [
        episode("host-8", "quarantined", commanded=timedelta(minutes=30)),
        episode("host-9", "resolving", commanded=timedelta(minutes=50)),
    ]
    result = plan([decision("host-1"), decision("host-2")], {"pool-a": 40}, recent)
    assert set(opened(result).values()) == {("held", "detector_suspect")}

    one = [episode("host-8", "quarantined", commanded=timedelta(minutes=30))]
    result = plan([decision("host-1"), decision("host-2")], {"pool-a": 40}, one)
    assert set(opened(result).values()) == {("quarantining", None)}

    older = [
        episode("host-8", "quarantined", commanded=timedelta(minutes=90)),
        episode("host-9", "quarantined", commanded=timedelta(minutes=90)),
    ]
    result = plan([decision("host-1"), decision("host-2")], {"pool-a": 40}, older)
    assert set(opened(result).values()) == {("quarantining", None)}


def test_the_breaker_window_runs_from_the_command_and_includes_the_hour() -> None:
    recent = [
        episode("host-7", "quarantined", commanded=timedelta(hours=1)),
        episode("host-8", "resolving", commanded=timedelta(minutes=50)),
        # Opened long ago as held, commanded once a slot freed.
        replace(
            episode("host-9", "quarantining", commanded=timedelta(minutes=10)),
            opened_at=NOW - timedelta(hours=5),
        ),
    ]
    result = plan([decision("host-1")], {"pool-a": 40}, recent)
    assert opened(result) == {"host-1": ("held", "detector_suspect")}
    # The rest are the out hosts' own actuator notices.
    assert texts(result)[0] == (
        ":warning: *Quarantine detector suspect* — 4 new quarantines within an "
        "hour (limit 3), so none from this scan were applied. Held: `host-1`"
    )


def test_a_held_quarantine_goes_ahead_once_a_slot_frees() -> None:
    held = episode("host-2", "held")
    still_out = [episode("host-1", "quarantined"), held]
    blocked = plan([decision("host-2")], {"pool-a": 4}, still_out)
    assert blocked.opened == () and blocked.stage_changes == ()

    freed = plan([decision("host-2")], {"pool-a": 4}, [held])
    [change] = freed.stage_changes
    assert change.from_stage == "held"
    assert change.patch["stage"] == "quarantining"
    assert texts(freed) == [
        ":construction: *Quarantine* — `host-2` will be quarantined once its "
        "running jobs finish: the GPU query hung on 2 consecutive checks"
    ]


def test_a_dry_run_switched_off_is_held_by_the_limits() -> None:
    result = plan(
        [decision("host-2")],
        {"pool-a": 4},
        [episode("host-1", "quarantined"), episode("host-2", "would")],
    )
    [change] = result.stage_changes
    assert change.from_stage == "would"
    assert change.patch["stage"] == "held"
    assert change.patch["held_reason"] == "pool_cap"
    assert texts(result)[0].startswith(
        ":double_vertical_bar: *Quarantine held* (pool cap) — `host-2`"
    )


def test_a_held_quarantine_whose_decision_is_gone_closes_silently() -> None:
    held = episode("host-2", "held")
    first = plan([], {"pool-a": 4}, [held])
    assert first.stage_changes == ()
    [state] = first.states
    second = plan_quarantine(
        now=NOW,
        live=True,
        decisions=[],
        states={(state.alert_type, state.subject_key): state},
        open_episodes={("quarantine", "host-2"): held},
        pool_sizes={"pool-a": 4},
    )
    [change] = second.stage_changes
    assert change.silent and change.patch["resolution"] == "decision_cleared"


def test_dry_run_posts_what_the_limits_would_do() -> None:
    # An open 'would' stands in for a quarantine, so it takes the slot.
    result = plan(
        [decision("host-2")], {"pool-a": 4}, [episode("host-1", "would")], live=False
    )
    [would] = result.opened
    assert would.details["stage"] == "would"
    assert texts(result) == [
        ":eyes: *Quarantine (dry run)* — would quarantine `host-2`: the GPU query "
        "hung on 2 consecutive checks (would be held: pool cap)"
    ]

    result = plan([decision("host-1", hardware=True)], {"pool-a": 1}, live=False)
    assert texts(result)[0].endswith("(last serving host: would page a person)")

    # A would-be-held 'would' does not take a slot itself.
    held = episode("host-1", "would")
    held.details["would_hold"] = "pool_cap"
    result = plan([decision("host-2")], {"pool-a": 4}, [held], live=False)
    assert texts(result)[0].endswith("consecutive checks")

    # The breaker in dry run: each would-be quarantine says so.
    result = plan(
        [decision(f"host-{n}") for n in range(1, 5)], {"pool-a": 40}, live=False
    )
    assert len(texts(result)) == 4
    assert all(
        text.endswith("(would be held: detector suspect)") for text in texts(result)
    )
