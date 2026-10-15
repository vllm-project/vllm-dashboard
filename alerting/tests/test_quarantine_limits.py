"""Quarantine safety limits (design §4.3), planned one scan at a time."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any

from alerting.infra import (
    GpuFaultObservation,
    HostFaultObservation,
    InfraAlertEpisode,
    InfraScanPlan,
    DiskMountObservation,
    GpuCountObservation,
    GpuDeadMemoryObservation,
    InfraSubjectState,
    QuarantineDecision,
    XidEvent,
    infra_notifications,
    plan_infra_scan,
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
            # A real held episode always says which limit holds it.
            **({"held_reason": "pool_cap"} if stage == "held" else {}),
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


def test_a_host_out_of_ci_still_counts_toward_its_pool() -> None:
    # Eight hosts; host-8 is quarantined and its agents have gone, so it no
    # longer maps to the pool. The cap stays at two, so host-1 still goes.
    pools = {f"host-{n}": ("h200", "pool-a") for n in range(1, 8)}
    out = episode("host-8", "quarantined")
    result = plan_infra_scan(
        now=NOW,
        thresholds={},
        expected_hosts=frozenset(),
        latest_reports={},
        disk_mounts=[],
        gpu_temperatures=[],
        gpu_dead_memory=[],
        gpu_counts=[],
        states={},
        open_episodes={("quarantine", "host-8"): out},
        quarantine_decisions=[decision("host-1")],
        quarantine_live=True,
        pools=pools,
    )
    assert opened(result) == {"host-1": ("quarantining", None)}


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
        "\nThey stay held while their decisions stand: a person needs to check "
        "the detector, or what these hosts share."
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
        "\nThey stay held while their decisions stand: a person needs to check "
        "the detector, or what these hosts share."
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


REPEAT_NOTE = (
    "\nQuarantined again within 7 days of oncall's resolve, so the fix may not "
    "have held; this pages a person."
)


def returned(host: str, resolved_at: datetime) -> InfraScanPlan:
    """The scan that closes a resolve the actuator confirmed."""
    resolving = episode(host, "resolving")
    resolving.details.update(
        actuator_state="returned",
        resolved_by="oncall",
        resolve_reason="reseated GPU 3",
        resolve_requested_at=resolved_at.isoformat(),
    )
    return plan_quarantine(
        now=resolved_at,
        live=True,
        decisions=[],
        states={},
        open_episodes={("quarantine", host): resolving},
    )


def again(
    resolve_plan: InfraScanPlan, at: datetime, *, live: bool = True
) -> InfraScanPlan:
    return plan_quarantine(
        now=at,
        live=live,
        decisions=[decision("host-1")],
        states={(s.alert_type, s.subject_key): s for s in resolve_plan.states},
        open_episodes={},
        pool_sizes={"pool-a": 4},
    )


def test_a_resolve_is_remembered_for_the_next_quarantine() -> None:
    [state] = returned("host-1", NOW).states
    assert (state.alert_type, state.subject_key) == ("quarantine", "host-1")
    assert state.details["last_resolve"] == {
        "at": NOW.isoformat(),
        "by": "oncall",
        "fix": "reseated GPU 3",
        "reason": "the GPU query hung on 2 consecutive checks",
    }


def test_a_quarantine_within_a_week_of_a_resolve_pages_a_person() -> None:
    resolve_plan = returned("host-1", NOW - timedelta(days=7))
    result = again(resolve_plan, NOW)
    [episode_] = result.opened
    assert episode_.details["stage"] == "quarantining"  # it still goes out
    assert episode_.details["repeat_of"]["by"] == "oncall"
    assert texts(result)[0].endswith(REPEAT_NOTE)

    later = again(resolve_plan, NOW + timedelta(seconds=1))
    assert "repeat_of" not in later.opened[0].details
    assert "pages a person" not in texts(later)[0]


def test_a_repeat_says_so_while_held_and_in_dry_run() -> None:
    resolve_plan = returned("host-1", NOW - timedelta(hours=5))
    held = plan_quarantine(
        now=NOW,
        live=True,
        decisions=[decision("host-1")],
        states={(s.alert_type, s.subject_key): s for s in resolve_plan.states},
        open_episodes={},
        pool_sizes={"pool-a": 1},
    )
    assert opened(held) == {"host-1": ("held", "last_host")}
    assert texts(held)[0].endswith(REPEAT_NOTE)
    dry = again(resolve_plan, NOW, live=False)
    assert texts(dry) == [
        ":eyes: *Quarantine (dry run)* — would quarantine `host-1`: the GPU query "
        "hung on 2 consecutive checks (again within 7 days of a resolve: would "
        "page a person)"
    ]


def test_a_hardware_fault_skips_the_pool_cap() -> None:
    out = [episode("host-1", "quarantined")]
    result = plan(
        [decision("host-2", hardware=True), decision("host-3")], {"pool-a": 4}, out
    )
    assert opened(result) == {
        "host-2": ("quarantining", None),
        "host-3": ("held", "pool_cap"),
    }
    # Even past a quarter of the pool, while the breaker allows it.
    result = plan(
        [decision(f"host-{n}", hardware=True) for n in (2, 3, 4)], {"pool-a": 8}, out
    )
    assert set(opened(result).values()) == {("quarantining", None)}


def test_the_breaker_still_holds_hardware_faults() -> None:
    result = plan(
        [decision(f"host-{n}", hardware=True) for n in range(1, 5)], {"pool-a": 40}
    )
    assert set(opened(result).values()) == {("held", "detector_suspect")}


def test_a_dry_run_decision_takes_no_slot_when_live() -> None:
    job = replace(decision("host-1"), dry_run=True)
    result = plan([job, decision("host-2")], {"pool-a": 4})
    assert opened(result) == {
        "host-1": ("would", None),
        "host-2": ("quarantining", None),
    }
    # A held host that only a dry-run trigger still names closes like one
    # whose decision is gone.
    held = episode("host-1", "held")
    first = plan([job], {"pool-a": 4}, [held])
    assert first.stage_changes == ()
    absent = {("quarantine", "host-1"): first.states[0]}
    second = plan_quarantine(
        now=NOW,
        live=True,
        decisions=[job],
        states=absent,
        open_episodes={("quarantine", "host-1"): held},
        pool_sizes={"pool-a": 4},
    )
    [change] = second.stage_changes
    assert change.patch == {"stage": "resolved", "resolution": "decision_cleared"}


def operator_posts(result: InfraScanPlan) -> list[str]:
    return [
        intent.delivery_id
        for intent in infra_notifications(
            result, delivery_mode=DeliveryMode.LIVE, operator_destination="UOPS"
        )
        if intent.destination == "UOPS"
    ]


def test_events_that_need_a_person_also_go_to_the_operator() -> None:
    # A hardware fault on the last serving host.
    paged = plan([decision("host-1", hardware=True)], {"pool-a": 1})
    [delivery] = operator_posts(paged)
    assert delivery.endswith(":open:operator")
    [intent] = [
        i
        for i in infra_notifications(
            paged, delivery_mode=DeliveryMode.LIVE, operator_destination="UOPS"
        )
        if i.destination == "UOPS"
    ]
    assert "this pages a person" in intent.payload["text"]
    # A tripped breaker: its one post.
    breaker = plan([decision(f"host-{n}") for n in range(1, 5)], {"pool-a": 40})
    [delivery] = operator_posts(breaker)
    assert delivery.endswith(":held:detector_suspect:operator")
    # A repeat offender.
    repeat = again(returned("host-1", NOW - timedelta(days=1)), NOW)
    assert len(operator_posts(repeat)) == 1
    # A held hardware fault that a later scan applies to the last host.
    held = plan(
        [decision("host-1", hardware=True)], {"pool-a": 1}, [episode("host-1", "held")]
    )
    [delivery] = operator_posts(held)
    assert delivery.endswith(":quarantining:operator")


def test_the_operator_hears_only_about_live_commands_that_need_a_person() -> None:
    assert operator_posts(plan([decision("host-1")], {"pool-a": 8})) == []
    assert (
        operator_posts(
            plan([decision("host-1", hardware=True)], {"pool-a": 1}, live=False)
        )
        == []
    )
    # Later stages of a paged episode don't go to the operator again.
    out = episode("host-1", "quarantining")
    out.details.update(paged=True, actuator_state="drained")
    result = plan([decision("host-1", hardware=True)], {"pool-a": 1}, [out])
    assert [c.patch["stage"] for c in result.stage_changes] == ["quarantined"]
    assert operator_posts(result) == []
    # No operator destination: the channel post only.
    paged = plan([decision("host-1", hardware=True)], {"pool-a": 1})
    assert len(infra_notifications(paged, delivery_mode=DeliveryMode.LIVE)) == 1


def test_a_hardware_fault_on_the_last_host_left_is_paged_past_the_cap() -> None:
    # One of two out: the other is the last one serving.
    result = plan(
        [decision("host-2", hardware=True)],
        {"pool-a": 2},
        [episode("host-1", "quarantined")],
    )
    assert opened(result) == {"host-2": ("quarantining", None)}
    assert result.opened[0].details["paged"] is True


def test_dry_run_hosts_the_breaker_holds_when_live_reach_the_operator() -> None:
    hosts = [f"host-{n}" for n in range(1, 5)]
    result = plan(
        [decision(host) for host in hosts],
        {"pool-a": 40},
        [episode(host, "would") for host in hosts],
    )
    assert {c.patch["held_reason"] for c in result.stage_changes} == {
        "detector_suspect"
    }
    # One combined post, not four, and one message to the operator.
    [post] = texts(result)
    assert "detector suspect" in post and "`host-4`" in post
    assert len(operator_posts(result)) == 1


def record(**ages: timedelta) -> dict[tuple[str, str], InfraSubjectState]:
    """The breaker's command record: host -> how long ago it was commanded."""
    commands = {host: (NOW - age).isoformat() for host, age in ages.items()}
    key = ("quarantine", "limits:commands")
    return {key: InfraSubjectState(*key, details={"commands": commands})}


def test_the_breaker_counts_commands_whose_quarantine_already_resolved() -> None:
    def verdict(states: dict[tuple[str, str], InfraSubjectState]) -> object:
        result = plan_quarantine(
            now=NOW,
            live=True,
            decisions=[decision("host-9")],
            states=states,
            open_episodes={},
            pool_sizes={"pool-a": 40},
        )
        return opened(result)["host-9"]

    minutes = {f"host-{n}": timedelta(minutes=30) for n in (1, 2, 3)}
    assert verdict(record(**minutes)) == ("held", "detector_suspect")
    # Commands older than the hour no longer count.
    old = dict(minutes, **{"host-3": timedelta(minutes=61)})
    assert verdict(record(**old)) == ("quarantining", None)


def test_each_command_is_recorded_for_the_breaker() -> None:
    result = plan_quarantine(
        now=NOW,
        live=True,
        decisions=[decision("host-9")],
        states=record(
            **{"host-1": timedelta(minutes=30), "host-2": timedelta(hours=2)}
        ),
        open_episodes={},
        pool_sizes={"pool-a": 40},
    )
    [state] = [s for s in result.states if s.subject_key == "limits:commands"]
    assert state.details == {
        "commands": {
            "host-1": (NOW - timedelta(minutes=30)).isoformat(),
            "host-9": NOW.isoformat(),
        }
    }
    # Nothing new and nothing aged out: no write.
    again_ = plan_quarantine(
        now=NOW,
        live=True,
        decisions=[],
        states=record(**{"host-1": timedelta(minutes=30)}),
        open_episodes={},
        pool_sizes={"pool-a": 40},
    )
    assert again_.states == ()


def test_a_breaker_hold_sticks_while_its_decision_stands() -> None:
    held = [episode(f"host-{n}", "held") for n in (1, 2, 3, 4)]
    for e in held:
        e.details["held_reason"] = "detector_suspect"
    # One decision goes; the other three stay held, without posts.
    result = plan([decision(f"host-{n}") for n in (1, 2, 3)], {"pool-a": 40}, held)
    assert result.stage_changes == ()


def test_a_held_host_the_breaker_now_blocks_is_posted_once() -> None:
    held = episode("host-1", "held")
    new = [decision(f"host-{n}") for n in (1, 2, 3, 4)]
    result = plan(new, {"pool-a": 40}, [held])
    [change] = result.stage_changes
    assert change.patch["held_reason"] == "detector_suspect"
    [post] = texts(result)
    assert post.startswith(":warning: *Quarantine detector suspect*")
    assert len(operator_posts(result)) == 1


def test_a_held_host_that_goes_ahead_drops_its_old_hold_and_page() -> None:
    held = episode("host-2", "held")
    held.details.update(
        repeat_of={"at": "2026-08-01T00:00:00+00:00", "by": "oncall"},
        paged=True,
        would_hold="pool_cap",
        breaker_count=4,
    )
    result = plan([decision("host-2")], {"pool-a": 4}, [held])
    [change] = result.stage_changes
    assert change.patch["stage"] == "quarantining"
    assert change.episode.details["held_reason"] is None
    assert change.episode.details["repeat_of"] is None
    assert change.episode.details["paged"] is None
    assert change.episode.details["would_hold"] is None
    assert change.episode.details["breaker_count"] is None
    assert operator_posts(result) == []


def test_the_breaker_record_includes_the_full_hour() -> None:
    # Commanded exactly an hour ago: still counted, and still kept.
    hour = {f"host-{n}": timedelta(hours=1) for n in (1, 2, 3)}
    result = plan_quarantine(
        now=NOW,
        live=True,
        decisions=[decision("host-9")],
        states=record(**hour),
        open_episodes={},
        pool_sizes={"pool-a": 40},
    )
    assert opened(result)["host-9"] == ("held", "detector_suspect")


def test_a_held_host_that_goes_ahead_is_recorded() -> None:
    hour = {"host-1": timedelta(hours=1)}
    result = plan_quarantine(
        now=NOW,
        live=True,
        decisions=[decision("host-2")],
        states=record(**hour),
        open_episodes={("quarantine", "host-2"): episode("host-2", "held")},
        pool_sizes={"pool-a": 40},
    )
    [state] = [s for s in result.states if s.subject_key == "limits:commands"]
    assert state.details["commands"] == {
        "host-1": (NOW - timedelta(hours=1)).isoformat(),
        "host-2": NOW.isoformat(),
    }


def waiting(
    read_age: timedelta,
    *,
    requested_age: timedelta,
    gpu_age: timedelta | None = None,
    hung: bool | None = False,
    rule: str | None = None,
    probes: list[dict[str, Any]] | None = None,
    slots: list[str] | None = None,
    **scan: Any,
) -> str:
    """The stage after one scan of a resolve waiting on a host reading.

    The GPU row is as old as the host reading unless `gpu_age` says otherwise.
    `rule` is the trigger the host was quarantined for; `scan` overrides
    plan_infra_scan arguments.
    """
    resolve = episode("host-1", "resolve_requested")
    resolve.details["resolve_requested_at"] = (NOW - requested_age).isoformat()
    # Quarantined for GPU 0 or the root mount, where the rule names one.
    resolve.details["evidence"] = {"rule": rule, "gpu_index": 0, "mount_point": "/"}
    reading = HostFaultObservation(
        hostname="host-1",
        gpu_query_hung=hung,
        network_probes=probes,
        root_owned_slots=slots,
        reported_at=NOW - read_age,
    )
    gpu = GpuFaultObservation(
        "host-1", 0, "None", False, NOW - (read_age if gpu_age is None else gpu_age)
    )
    result = plan_infra_scan(
        now=NOW,
        thresholds={},
        expected_hosts=frozenset(),
        latest_reports={},
        gpu_temperatures=[],
        open_episodes={("quarantine", "host-1"): resolve},
        quarantine_live=True,
        pools={"host-1": ("h200", "pool-a")},
        **{
            "disk_mounts": [],
            "gpu_dead_memory": [],
            "gpu_counts": [],
            "states": {},
            "host_faults": [reading],
            "gpu_faults": [gpu],
            **scan,
        },
    )
    changes = result.stage_changes
    return str(changes[0].episode.details["stage"]) if changes else "unchanged"


def test_a_host_reading_newer_than_the_resolve_releases_it() -> None:
    minute = timedelta(minutes=1)
    assert waiting(timedelta(seconds=60), requested_age=minute * 2) == "resolving"
    # Older than READING_MAX_AGE, or not newer than the request: still waits.
    assert waiting(timedelta(seconds=61), requested_age=minute * 2) == "unchanged"
    assert waiting(minute, requested_age=minute) == "unchanged"
    # Both halves count, by the older of the two.
    assert waiting(minute, requested_age=minute * 2, gpu_age=minute * 2) == "unchanged"
    assert waiting(minute, requested_age=minute * 2, gpu_age=minute * 3) == "unchanged"
    assert waiting(minute * 2, requested_age=minute * 2, gpu_age=minute) == "unchanged"
    # A GPU query that didn't answer, or hung, doesn't release it.
    assert waiting(minute, requested_age=minute * 2, hung=None) == "unchanged"


def test_a_clean_reading_measures_the_fault_again_and_every_gpu() -> None:
    m = timedelta(minutes=1)

    def wait(rule: str | None, requested_age: timedelta = m * 2, **scan: Any) -> str:
        return waiting(m, requested_age=requested_age, rule=rule, **scan)

    # A GPU fault or Xid needs nothing beyond the full reading.
    assert wait("xid") == "resolving"
    assert wait("gpu_hang") == "resolving"
    # Host faults wait for their own measurement, taken after the request.
    assert wait("network") == "unchanged"
    assert wait("network", probes=[]) == "unchanged"
    assert wait("network", probes=[{"ok": True}]) == "resolving"
    assert wait("root_owned") == "unchanged"
    assert wait("root_owned", slots=[]) == "resolving"
    mount = DiskMountObservation(
        "host-1", "/", "/dev/sda1", "ext4", "system", 10, 100, None, NOW - m
    )
    assert wait("disk") == "unchanged"
    assert wait("disk", disk_mounts=[replace(mount, error="EIO")]) == "unchanged"
    assert wait("disk", disk_mounts=[mount]) == "resolving"
    # Another mount reading fine says nothing about the full one.
    assert (
        wait("disk", disk_mounts=[replace(mount, mount_point="/data")]) == "unchanged"
    )
    assert (
        wait(
            "disk",
            requested_age=m // 2,
            disk_mounts=[mount],
            gpu_faults=[GpuFaultObservation("host-1", 0, "None", False, NOW)],
        )
        == "unchanged"
    )
    assert (
        wait("disk", disk_mounts=[replace(mount, reported_at=NOW - 2 * m)])
        == "unchanged"
    )
    dead = GpuDeadMemoryObservation("host-1", 0, 0.0, NOW - m)
    assert wait("dead_memory") == "unchanged"
    assert wait("dead_memory", gpu_dead_memory=[dead]) == "resolving"
    assert (
        wait("dead_memory", gpu_dead_memory=[replace(dead, gpu_index=1)]) == "unchanged"
    )
    # A GPU fault needs that GPU's field read, not [N/A].
    gpu0 = GpuFaultObservation("host-1", 0, "None", False, NOW - m)
    assert wait("recovery_action", gpu_faults=[gpu0]) == "resolving"
    assert (
        wait("recovery_action", gpu_faults=[replace(gpu0, recovery_action=None)])
        == "unchanged"
    )
    assert wait("remapped_rows", gpu_faults=[gpu0]) == "resolving"
    assert (
        wait("remapped_rows", gpu_faults=[replace(gpu0, remapped_rows_failure=None)])
        == "unchanged"
    )
    assert (
        wait("recovery_action", gpu_faults=[replace(gpu0, gpu_index=1)]) == "unchanged"
    )
    count = GpuCountObservation("host-1", 1, NOW - m)
    assert wait("gpu_count") == "unchanged"
    assert wait("gpu_count", gpu_counts=[count]) == "resolving"
    # Every GPU the host has had must report; a dropped one keeps it waiting.
    baseline = {
        ("gpu_count", "gpu-count:host-1"): InfraSubjectState(
            "gpu_count", "gpu-count:host-1", details={"baseline_gpus": 2}
        )
    }
    assert wait("xid", states=baseline) == "unchanged"
    two = [GpuFaultObservation("host-1", i, "None", False, NOW - m) for i in (0, 1)]
    assert wait("xid", states=baseline, gpu_faults=two) == "resolving"
    stale = [two[0], replace(two[1], reported_at=NOW - 2 * m)]

    # Each GPU's own reading must postdate the request, not just the newest.
    def two_gpus(*ages: timedelta) -> str:
        rows = [replace(two[i], reported_at=NOW - age) for i, age in enumerate(ages)]
        return waiting(timedelta(0), requested_age=m // 2, rule="xid", gpu_faults=rows)

    assert two_gpus(timedelta(0), timedelta(0)) == "resolving"
    assert two_gpus(timedelta(0), m) == "unchanged"
    # Another host's GPU doesn't make up this host's count.
    elsewhere = replace(two[1], hostname="host-0")
    assert wait("xid", states=baseline, gpu_faults=[two[0], elsewhere]) == "unchanged"
    assert wait("xid", states=baseline, gpu_faults=stale) == "unchanged"
    # Another host short of GPUs doesn't hold this one up.
    other = {
        ("gpu_count", "gpu-count:host-0"): baseline[("gpu_count", "gpu-count:host-1")]
    }
    assert (
        wait(
            "xid",
            states=other,
            gpu_faults=[replace(two[0], hostname="host-0"), two[0]],
        )
        == "resolving"
    )


def test_a_new_xid_after_the_request_sends_a_resolve_back() -> None:
    # The GPU fault was read before the request, so the resolve covers it;
    # the Xid came after, so it doesn't.
    resolve = episode("host-1", "resolve_requested")
    requested = NOW - timedelta(seconds=30)
    resolve.details["resolve_requested_at"] = requested.isoformat()
    result = plan_infra_scan(
        now=NOW,
        thresholds={},
        expected_hosts=frozenset(),
        latest_reports={},
        disk_mounts=[],
        gpu_temperatures=[],
        gpu_dead_memory=[],
        gpu_counts=[],
        states={},
        open_episodes={("quarantine", "host-1"): resolve},
        quarantine_live=True,
        pools={"host-1": ("h200", "pool-a")},
        gpu_faults=[GpuFaultObservation("host-1", 0, "Reset", False, requested)],
        xid_events=[
            XidEvent("host-1", "0000:01:00.0", 79, NOW - timedelta(seconds=10))
        ],
    )
    [change] = result.stage_changes
    assert change.episode.details["stage"] == "quarantined"
    assert change.episode.details["verify_note"] == "Xid 79 on GPU 0000:01:00.0"


def test_a_resolve_waiting_on_a_reading_still_holds_a_cap_slot() -> None:
    result = plan(
        [decision("host-2")], {"pool-a": 4}, [episode("host-1", "resolve_requested")]
    )
    assert opened(result) == {"host-2": ("held", "pool_cap")}
