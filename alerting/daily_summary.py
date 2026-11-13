"""Daily CI infra summary: one Slack post a day about the pilot hosts.

Changes since yesterday come first, then what stands (quarantined, held,
cordoned, degraded, not reporting), then a link to the /gpu page. Empty sections are
hidden, and a quiet day is one line so that a missing post means the job
broke. It is operational only; nothing here feeds measurement.

Degraded counts a host against its own expected GPU count: the exception
list's value when it has one, otherwise the larger of 8 and the most GPUs the
GPU-count alert has ever seen on it. The alert's own learned baseline is not
used on its own, because a host that came up short would learn the short count.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol
from zoneinfo import ZoneInfo

from alerting.commands import ScheduledCommand
from alerting.infra import (
    GpuCountObservation,
    InfraAlertEpisode,
    InfraAlertType,
    InfraSnapshotPort,
    InfraStore,
    K8S_NODE_QUEUES,
    PILOT_QUEUES,
    _code,
    _escape,
    pilot_pools,
)
from alerting.ports import (
    AlertPath,
    Clock,
    DeliveryMode,
    DestinationMode,
    NotificationIntent,
    OutboxStore,
)
from alerting.slack import headed_payload

PACIFIC = ZoneInfo("America/Los_Angeles")
GPU_PAGE = "https://ci.vllm.ai/gpu"
WINDOW = timedelta(hours=24)
MIN_EXPECTED_GPUS = 8
# Reporters post to five-minute rollup buckets; a day has 288 of them.
BUCKETS_PER_DAY = int(WINDOW / timedelta(minutes=5))
# A host that is reporting but missed at least this share of the day's
# buckets has a flapping scrape.
SCRAPE_FAILING_PERCENT = 10
# A bucket counts against a host only when its reporting was provably up
# then. Kubernetes nodes are reported by one control-plane scraper per
# cluster, so a bucket counts when at least half of the cluster's expected
# nodes have it — a majority missing is the scraper down. Bare-metal h200
# hosts report independently, so a bucket counts when any expected host in
# the fleet has it — none reporting anywhere is the ingestion pipeline down.
CLUSTER_COVERAGE_MAJORITY = 2
# A shared-scraper cluster with fewer expected nodes than this has no
# majority to prove a scraper outage, so its misses are charged directly.
MIN_NODES_FOR_MAJORITY = 2
# Clusters whose nodes are reported by one shared control-plane scraper
# (Kubernetes); bare-metal hosts report independently.
SHARED_SCRAPER_CLUSTERS = frozenset(
    PILOT_QUEUES[queue] for queue in K8S_NODE_QUEUES.values()
)
# Pools in the order the Mode line lists them.
CLUSTERS = ("h200", "h100", "b200")
# Quarantine stages in which the host is out of service.
OUT_STAGES = frozenset({"quarantining", "quarantined", "resolve_requested", "resolving"})


@dataclass(frozen=True)
class ScrapeBuckets:
    """The day's five-minute GPU-row buckets.

    by_host maps each host that reported in the window to its buckets.
    eligible hosts had a bucket in the day before the window: with buckets
    today they are expected from the day's first slot through their last
    bucket; with none they are not measured at all (a removed or long-dead
    host is the unreporting alert's and the roster's business, not a flap).
    Anyone else reporting is new and measured from its first bucket on.
    """

    by_host: Mapping[str, frozenset[datetime]]
    eligible: frozenset[str]


class DailySummarySource(Protocol):
    """Read seam for what the infra scan's own ports do not already give."""

    def episodes_since(self, since: datetime) -> list[InfraAlertEpisode]:
        """Quarantine, GPU-count and unreporting episodes that are open or
        were opened or resolved at or after `since`."""
        ...

    def expected_gpu_exceptions(self) -> dict[str, int]:
        """Lowercased host -> expected GPU count, from the exception list."""
        ...

    def scrape_buckets(self, since: datetime) -> ScrapeBuckets:
        """Five-minute buckets with a GPU row since `since`, and the hosts
        that had one in the day before the window."""
        ...

    def last_agent_queues(
        self, hostnames: Iterable[str], *, since: datetime | None = None
    ) -> list[tuple[str, str]]:
        """(agent hostname, queue) from the newest agent snapshot of each of
        `hostnames`, however old (or since `since`), so a host whose agents
        are gone keeps its pool. An agent matches a host by its short
        lower-case name, so it may be an FQDN under any domain or differ in
        case. Only these hosts are looked up: the table holds one hostname per
        CI pod agent."""
        ...

    def allocatable_gpus(self) -> dict[str, tuple[int, int]]:
        """Kubernetes node -> (allocatable, capacity) GPUs from its latest
        fresh reading."""
        ...

    def cordoned_hosts(self) -> dict[str, datetime]:
        """Kubernetes node -> when its current cordon started, for nodes whose
        latest fresh reading is unschedulable."""
        ...


@dataclass(frozen=True)
class SummaryInputs:
    now: datetime
    live_clusters: frozenset[str]
    pools: Mapping[str, tuple[str, str]]
    gpu_counts: list[GpuCountObservation]
    baselines: Mapping[str, int]
    exceptions: Mapping[str, int]
    episodes: list[InfraAlertEpisode]
    scrape_buckets: ScrapeBuckets
    allocatable: Mapping[str, tuple[int, int]]
    cordoned: Mapping[str, datetime]


def _hm(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%H:%M UTC")


def _age(since: datetime, now: datetime) -> str:
    hours = int((now - since).total_seconds() // 3600)
    return f"{hours // 24} d" if hours >= 48 else f"{hours} h"


def _out_at(episode: InfraAlertEpisode) -> datetime:
    """When the host went out: a held episode is opened long before its
    command, so prefer the stage timestamps over `opened_at`."""
    for key in ("quarantined_at", "commanded_at"):
        value = episode.details.get(key)
        if isinstance(value, str):
            return datetime.fromisoformat(value)
    return episode.opened_at


def _reason(episode: InfraAlertEpisode) -> str:
    return _escape(episode.details.get("reason"))


def _day_slots(now: datetime) -> list[datetime]:
    """The day's 288 wall-clock five-minute buckets (UTC-aligned, as the
    rollups are), ending at the last one complete before `now`."""
    end = now.astimezone(timezone.utc).replace(second=0, microsecond=0)
    end = end.replace(minute=end.minute - end.minute % 5)
    return [end - timedelta(minutes=5) * n for n in range(BUCKETS_PER_DAY, 0, -1)]


def render_summary(inputs: SummaryInputs) -> str:
    now = inputs.now
    since = now - WINDOW
    day = now.astimezone(PACIFIC).strftime("%Y-%m-%d")
    title = f"📊 Daily CI infra summary — {day}"
    episodes = inputs.episodes

    def of(alert_type: InfraAlertType) -> list[InfraAlertEpisode]:
        return [e for e in episodes if e.alert_type == alert_type.value]

    changes: list[str] = []
    quarantines = of(InfraAlertType.QUARANTINE)
    for episode in quarantines:
        host, stage = _code(episode.subject_key), episode.details.get("stage")
        cleared = episode.details.get("resolution") == "decision_cleared"
        # A held episode that closed was never out of service.
        if episode.details.get("resolved_while_held") or (
            cleared and episode.details.get("held_reason")
        ):
            continue
        if stage == "would" or cleared:
            if episode.opened_at >= since:
                changes.append(f"• 🧪 would have quarantined {host}: {_reason(episode)}")
        elif stage == "held":
            # A dry-run episode moving to held has an old opened_at.
            if _out_at(episode) >= since:
                cap = str(episode.details.get("held_reason") or "").replace("_", " ")
                changes.append(
                    f"• ⏸ held {host}{f' ({_escape(cap)})' if cap else ''}: {_reason(episode)}"
                )
        elif _out_at(episode) >= since:
            changes.append(
                f"• 🔒 quarantined {host}: {_reason(episode)} ({_hm(_out_at(episode))})"
            )
        if (
            episode.resolved_at is not None
            and episode.resolved_at >= since
            and stage == "resolved"
            and not cleared
        ):
            by = _escape(episode.details.get("resolved_by") or "unknown")
            changes.append(f"• ✅ returned {host} (resolved by {by})")
    for episode in of(InfraAlertType.GPU_COUNT):
        host = episode.subject_key.removeprefix("gpu-count:")
        if host not in inputs.pools:
            continue
        if episode.opened_at >= since:
            # Resolving overwrites the counts with the recovered ones.
            counts = (
                f": {_escape(episode.details.get('observed_gpus'))} "
                f"of {_escape(episode.details.get('baseline_gpus'))}"
                if episode.resolved_at is None
                else ""
            )
            changes.append(f"• 📉 {_code(host)} GPUs dropped{counts}")
        if episode.resolved_at is not None and episode.resolved_at >= since:
            changes.append(f"• 📈 {_code(host)} GPUs recovered")

    silent = {e.subject_key for e in of(InfraAlertType.UNREPORTING) if e.resolved_at is None}
    slots = _day_slots(now)
    reported = inputs.scrape_buckets.by_host
    eligible = inputs.scrape_buckets.eligible
    # A host's expected span runs to its last bucket of the day: trailing
    # silence is the unreporting alert's job, not a flap. The span starts at
    # the day's first slot for a host eligible from the day before, so a gap
    # before it returned counts; a genuinely new host starts at its first
    # bucket. Eligible but silent all day means removed or long dead: no
    # expected slots. Hosts with an open unreporting episode are skipped
    # entirely — neither warned nor counted toward their cluster's coverage.
    expected_slots: dict[str, set[datetime]] = {}
    for host in inputs.pools:
        if host in silent:
            continue
        buckets = reported.get(host)
        if not buckets:
            continue
        first = slots[0] if host in eligible else min(buckets)
        last = max(buckets)
        expected_slots[host] = {slot for slot in slots if first <= slot <= last}
    fleet_reported = set().union(*(reported[host] for host in expected_slots))
    # Only shared-scraper clusters need per-cluster coverage tallies.
    wanted_by_cluster: dict[str, Counter[datetime]] = {}
    actual_by_cluster: dict[str, Counter[datetime]] = {}
    for host, host_slots in expected_slots.items():
        cluster = inputs.pools[host][0]
        if cluster not in SHARED_SCRAPER_CLUSTERS:
            continue
        wanted_by_cluster.setdefault(cluster, Counter()).update(host_slots)
        actual_by_cluster.setdefault(cluster, Counter()).update(reported[host])
    # A bucket counts against a host only when reporting was provably up then
    # (see CLUSTER_COVERAGE_MAJORITY). Independent reporters use fleet_reported.
    covered: dict[str, set[datetime]] = {}
    for cluster, wanted in wanted_by_cluster.items():
        actual = actual_by_cluster[cluster]
        covered[cluster] = {
            slot
            for slot in slots
            if wanted[slot] < MIN_NODES_FOR_MAJORITY
            or actual[slot] * CLUSTER_COVERAGE_MAJORITY >= wanted[slot]
        }
    for host in sorted(expected_slots):
        cluster = inputs.pools[host][0]
        host_covered = covered[cluster] if cluster in SHARED_SCRAPER_CLUSTERS else fleet_reported
        missed = (expected_slots[host] & host_covered) - reported[host]
        failing = 100 * len(missed) / BUCKETS_PER_DAY
        if failing >= SCRAPE_FAILING_PERCENT:
            changes.append(f"• ⚠️ {_code(host)} scrape failing {round(failing)}% (24 h)")

    out = [e for e in quarantines if e.resolved_at is None and e.details.get("stage") in OUT_STAGES]
    held = [e for e in quarantines if e.resolved_at is None and e.details.get("stage") == "held"]
    # A quarantine lists its own cordon; the rest were cordoned by hand.
    cordoned = sorted(
        (inputs.cordoned.keys() & inputs.pools.keys()) - {e.subject_key for e in out}
    )
    degraded: list[str] = []
    for obs in sorted(inputs.gpu_counts, key=lambda o: o.hostname):
        if obs.hostname not in inputs.pools:
            continue
        exception = inputs.exceptions.get(obs.hostname)
        expected = exception or max(
            MIN_EXPECTED_GPUS, inputs.baselines.get(obs.hostname, 0), obs.observed_gpus
        )
        # An exception-list host stays listed even at its accepted count.
        if obs.observed_gpus < expected or exception is not None:
            tag = " (exception)" if exception is not None else ""
            degraded.append(f"• {_code(obs.hostname)} {obs.observed_gpus}/{expected}{tag}")

    for host, (allocatable, capacity) in sorted(inputs.allocatable.items()):
        if host in inputs.pools and allocatable < capacity:
            degraded.append(f"• {_code(host)} allocatable {allocatable}/{capacity}")

    standing: list[str] = []
    if out:
        standing.append("Quarantined:")
        standing += [
            f"• {_code(e.subject_key)} ({e.details.get('stage')}, {_reason(e)}, "
            f"{_age(_out_at(e), now)})"
            for e in out
        ]
    if held:
        standing.append("Held (waiting for a person or a free slot):")
        standing += [f"• {_code(e.subject_key)} ({_reason(e)})" for e in held]
    if cordoned:
        standing.append("Cordoned:")
        standing += [
            f"• {_code(host)} ({_age(inputs.cordoned[host], now)})" for host in cordoned
        ]
    if degraded:
        standing += ["Degraded:", *degraded]
    if silent:
        standing += ["Not reporting:", *(f"• {_code(host)}" for host in sorted(silent))]

    if not changes and not standing:
        return (
            f"{title}: {len(inputs.pools)} hosts, nothing changed, "
            "nothing quarantined or degraded."
        )

    clusters = {cluster for cluster, _ in inputs.pools.values()}
    modes = []
    for cluster in CLUSTERS:
        if cluster not in clusters:
            modes.append(f"{cluster} not started")
        elif cluster in inputs.live_clusters:
            modes.append(f"{cluster} live")
        else:
            modes.append(f"{cluster} dry run")
    lines = [title, "Mode: " + ", ".join(modes)]
    if changes:
        lines += ["", "Changes since yesterday:", *changes]
    if standing:
        lines += ["", "Standing:", *standing]
    lines += ["", f"<{GPU_PAGE}|GPU dashboard>"]
    return "\n".join(lines)


def summary_intent(
    text: str, *, now: datetime, delivery_mode: DeliveryMode, destination: str
) -> NotificationIntent:
    day = now.astimezone(PACIFIC).strftime("%Y-%m-%d")
    return NotificationIntent(
        # One post per Pacific day, whatever minute a retry runs at.
        delivery_id=f"infra:daily_summary:{day}",
        alert_ref="infra:daily_summary",
        alert_path=AlertPath.INFRA,
        delivery_mode=delivery_mode,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination=destination,
        payload=headed_payload(text, source="INFRA", icon="📊"),
    )


class DailySummaryHandler:
    """Read the day's infra state and enqueue the summary post."""

    def __init__(
        self,
        *,
        source: DailySummarySource,
        snapshots: InfraSnapshotPort,
        store: InfraStore,
        outbox: OutboxStore,
        clock: Clock,
        destination: str,
        delivery_mode: DeliveryMode = DeliveryMode.LIVE,
        quarantine_live_clusters: frozenset[str] = frozenset(),
    ) -> None:
        self._source = source
        self._snapshots = snapshots
        self._store = store
        self._outbox = outbox
        self._clock = clock
        self._destination = destination
        self._delivery_mode = delivery_mode
        self._quarantine_live_clusters = quarantine_live_clusters

    def __call__(self, command: ScheduledCommand) -> None:
        now = command.target_time
        since = now - WINDOW
        counts = self._snapshots.gpu_counts()
        episodes = self._source.episodes_since(since)
        # The grid's aligned first slot, so the window the store fetches is
        # exactly the day render_summary expects, with a full day before it
        # for eligibility.
        buckets = self._source.scrape_buckets(_day_slots(now)[0])
        allocatable = self._source.allocatable_gpus()
        # A pool that went dark has no fresh rows; its hosts are still in the
        # day's rollups and episodes, so a dead pool is not "not started".
        roster = (
            {obs.hostname for obs in counts}
            | buckets.by_host.keys()
            | buckets.eligible
            | allocatable.keys()
            | {e.subject_key.removeprefix("gpu-count:") for e in episodes}
        )
        # Past the agent table's retention a bare-metal host is still named by
        # its quarantine episode.
        fresh = self._snapshots.agent_queues()
        queues = [
            *fresh,
            *self._source.last_agent_queues(sorted(roster)),
            *(
                (e.subject_key, str(e.details["pool"]))
                for e in episodes
                if e.alert_type == InfraAlertType.QUARANTINE.value
                and e.details.get("cluster") == "h200"
                and e.details.get("pool")
            ),
        ]
        text = render_summary(
            SummaryInputs(
                now=now,
                live_clusters=self._quarantine_live_clusters,
                pools=pilot_pools(roster, queues),
                gpu_counts=counts,
                baselines={
                    state.subject_key.removeprefix("gpu-count:"): int(
                        state.details.get("baseline_gpus") or 0
                    )
                    for state in self._store.infra_state().states
                    if state.alert_type == InfraAlertType.GPU_COUNT.value
                },
                exceptions=self._source.expected_gpu_exceptions(),
                episodes=episodes,
                scrape_buckets=buckets,
                allocatable=allocatable,
                cordoned=self._source.cordoned_hosts(),
            )
        )
        self._outbox.enqueue(
            summary_intent(
                text,
                now=now,
                delivery_mode=self._delivery_mode,
                destination=self._destination,
            ),
            now=self._clock.now(),
        )
