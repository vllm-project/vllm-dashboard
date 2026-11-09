"""CI selector health: are the recordings the test selector decides from
whole and fresh, and are PR builds picking them up?

vLLM's PR builds run only the test steps ci-selector picks, and it picks from
recordings the scheduled Full CI runs make on main: a Python function table
(fnrec) and kernel tables for CUDA and ROCm (kernrec), each paired with a
kernel symbol map the image builds upload. Both collect steps are soft_fail,
so a broken collect never turns a build red: from 2026-10-24 to 10-30 no CUDA
kernel table was published and nothing said so. This slice says so.

It ingests every scheduled Full CI Run of the last 14 days into one record
per run and component (Python function table, CUDA and ROCm kernel tables,
CUDA and ROCm kernel source maps), from the collect jobs' summary artifacts
when they exist (ci-infra#881) and from their logs otherwise, plus the two
small kernel tables and the two source maps themselves, and the selector
decision each PR build's bootstrap uploads. Five conditions open an episode;
each episode sends one Slack message, edited in place when the first healthy
observation resolves it:

- run_incomplete: a recording or source map of the latest completed full run
  is not whole.
- rows_degraded: a published table of the latest completed run has under 70%
  of its rows usable, or under 60% of the median usable rows of the previous
  7 completed runs (vllm/ci #100914: every collect passed and published, and
  the CUDA kernel table had 95 usable rows of 253).
- stale: the newest run that published a recording is over 30 hours older
  than the newest completed run.
- pr_stale: in the last 6 hours, the median recording build PR decisions used
  is over 30 hours older than the newest one published.
- pr_errors: over 5% of the last 24 hours' PR builds (at least 5) fell back
  because the selector failed.
"""

from __future__ import annotations

import gzip
import hashlib
import html
import io
import json
import re
import statistics
from collections import Counter
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any, Protocol

from alerting.commands import ScheduledCommand
from alerting.fast_ci import infra_slack_channel
from alerting.ports import (
    AlertPath,
    Clock,
    DeliveryMode,
    DestinationMode,
    NotificationIntent,
)
from alerting.runtime import HandlerCompletion
from alerting.slack import headed_payload

BUILD_URL = "https://buildkite.com/vllm/ci/builds/{}"
PAGE_URL = "https://ci.vllm.ai/selector"
# Exactly these first message lines; "Full CI run torch nightly" is not one.
FULL_RUN_MESSAGES = {
    "Full CI run - nightly": "nightly",
    "Full CI run - daily": "daily",
}
FNREC_COLLECT = "fnrec-collect"
KERNREC_COLLECT = "kernrec-collect"
IMAGE_BUILD = "image-build"
IMAGE_BUILD_AMD = "image-build-amd"
BOOTSTRAP = "bootstrap"
FNREC_SUMMARY = "fnrec_collect_summary.json"
# The Python table runs to ~125 MB: only its presence is checked.
FNREC_TABLE = "table.json.gz"
CUDA_TABLE = "kernel_table.json.gz"
ROCM_TABLE = "kernel_table.rocm.json.gz"
KERNREC_SUMMARY = "kernrec_collect_summary.json"
DECISION_ARTIFACT = "ci_selector_decision.json"
CUDA_MAP = "kernel_symbol_map.json.gz"
ROCM_MAP = "kernel_symbol_map.rocm.json.gz"
# Decision files run to tens of KB and summaries to a few hundred bytes.
MAX_ARTIFACT_BYTES = 4 << 20
# Kernel tables are ~0.5 MB gzipped (~6 MB of JSON); source maps ~3.5 MB
# gzipped (~45 MB of JSON). Both caps leave several times that headroom.
MAX_TABLE_BYTES = 16 << 20
MAX_MAP_BYTES = 32 << 20
MAX_JSON_BYTES = 256 << 20
# The collect logs end with what was folded and published; kernel logs run to
# a few MB of download lines before that.
LOG_TAIL_BYTES = 1 << 20
# Buildkite job states after which a job will not change by itself.
TERMINAL_JOB_STATES = frozenset(
    {
        "passed",
        "failed",
        "canceled",
        "timed_out",
        "broken",
        "skipped",
        "expired",
        "not_run",
        "finished",
    }
)
TERMINAL_BUILD_STATES = frozenset(
    {"passed", "failed", "canceled", "skipped", "not_run", "finished"}
)


class Component(StrEnum):
    FNREC = "fnrec"
    KERNREC_CUDA = "kernrec_cuda"
    KERNREC_ROCM = "kernrec_rocm"
    MAP_CUDA = "map_cuda"
    MAP_ROCM = "map_rocm"


# The recordings go stale and lose rows; maps are only whole or not.
RECORDINGS = (Component.FNREC, Component.KERNREC_CUDA, Component.KERNREC_ROCM)
KERNEL_TABLES = (Component.KERNREC_CUDA, Component.KERNREC_ROCM)
MAPS = (Component.MAP_CUDA, Component.MAP_ROCM)
# Every component whose latest run can be not whole.
WHOLE_COMPONENTS = (*RECORDINGS, *MAPS)
COMPONENT_LABELS = {
    Component.FNREC: "Python function table (fnrec)",
    Component.KERNREC_CUDA: "CUDA kernel table",
    Component.KERNREC_ROCM: "ROCm kernel table",
    Component.MAP_CUDA: "CUDA kernel source map",
    Component.MAP_ROCM: "ROCm kernel source map",
}
# records.<recorder>.build in a PR decision, by the table it names. The
# decision's records.kernrec is the CUDA table (latest.json) unless it says
# otherwise; a ROCm kernel entry arrives with the ci-infra change that makes
# the gate fetch the ROCm pair too.
RECORD_COMPONENTS = {
    "fnrec": Component.FNREC,
    "kernrec": Component.KERNREC_CUDA,
    "kernrec_rocm": Component.KERNREC_ROCM,
}
KERNEL_BACKENDS = ("cuda", "rocm")


class ComponentStatus(StrEnum):
    OK = "ok"
    BROKEN = "broken"
    # The recorder was not on for this run (ROCm before it was armed).
    OFF = "off"
    # Its job has not finished.
    PENDING = "pending"
    # A source map that is absent where nothing needed it: the image build
    # did not run, or its backend's kernel recorder was not armed.
    MISSING = "missing"


class SelectorCondition(StrEnum):
    RUN_INCOMPLETE = "run_incomplete"
    ROWS_DEGRADED = "rows_degraded"
    STALE = "stale"
    PR_STALE = "pr_stale"
    PR_ERRORS = "pr_errors"


class DecisionOutcome(StrEnum):
    APPLIED = "applied"
    SKIPPED = "skipped"
    FALLBACK = "fallback"
    # No decision artifact: a docs-only build, or a bootstrap that failed.
    MISSING = "missing"


@dataclass(frozen=True)
class SelectorHealthThresholds:
    """Every selector-health threshold, in one place."""

    # A collect that folded fewer of the expected jobs is not whole.
    min_delivered_ratio: float = 0.8
    # How far the newest publish may trail the newest completed run.
    stale_after: timedelta = timedelta(hours=30)
    # The PR decisions whose median recording build is checked.
    pr_stale_window: timedelta = timedelta(hours=6)
    pr_error_window: timedelta = timedelta(hours=24)
    pr_error_rate: float = 0.05
    pr_error_min_builds: int = 5
    # Full runs ingested and kept in view.
    history: timedelta = timedelta(days=14)
    # A published table with a smaller usable share is degraded.
    min_usable_share: float = 0.7
    # ... and so is one with fewer usable rows than this share of the median
    # of the previous `usable_median_runs` completed runs that published it,
    # once at least `usable_median_min_runs` of them did.
    min_usable_of_median: float = 0.6
    usable_median_runs: int = 7
    usable_median_min_runs: int = 3


DEFAULT_THRESHOLDS = SelectorHealthThresholds()
# Fallback reasons that mean the selector itself broke, not that it declined.
SELECTOR_ERROR_PREFIXES = ("selector failed", "gate error")
# PR builds whose decisions one scan reads: the error window plus overlap.
DECISION_LOOKBACK = timedelta(hours=26)
# A first scan (or one after an outage) reads at most this many new builds;
# the next hourly scan picks up the rest.
MAX_DECISION_BUILDS_PER_SCAN = 300


@dataclass(frozen=True)
class RecordingReading:
    """What one collect said about one backend, from a summary or a log."""

    armed: bool
    expected_jobs: int | None = None
    delivered_jobs: int | None = None
    # Every row of the table, and the rows the selector can use.
    rows: int | None = None
    usable_rows: int | None = None
    verdict: str | None = None
    published: bool = False
    published_commit: str | None = None


@dataclass(frozen=True)
class KernelTableStats:
    """Why a kernel table's rows are or are not usable, counted from the
    table itself. A row is usable iff passed, complete (default true), not
    dropped, backend cuda or rocm, and trace_complete is True. A row can fail
    several conditions, so the failure counts can sum past rows - usable."""

    rows: int
    usable_rows: int
    not_passed: int
    # None for a table from before trace health (version < 3).
    trace_incomplete: int | None
    dropped: int
    incomplete: int


@dataclass(frozen=True)
class SourceMapStats:
    """What one kernel source map (kernel_symbol_map[.rocm].json.gz) holds,
    and why it is broken when it is."""

    objects: int
    device_objects: int
    symbols: int
    # Distinct csrc/... sources among the objects.
    sources: int
    commit: str | None
    problems: tuple[str, ...] = ()


@dataclass(frozen=True)
class RunComponent:
    """One component of one scheduled Full CI Run, as the page shows it."""

    component: str
    status: str
    job_state: str | None = None
    soft_failed: bool = False
    exit_status: int | None = None
    expected_jobs: int | None = None
    delivered_jobs: int | None = None
    # Tables: every row, and the usable ones (None when not known: the
    # Python summary does not report it and its table is too big to read).
    rows: int | None = None
    usable_rows: int | None = None
    # Kernel tables read whole: rows failing each usability condition.
    rows_not_passed: int | None = None
    rows_trace_incomplete: int | None = None
    rows_dropped: int | None = None
    rows_incomplete: int | None = None
    # Source maps: objects, device objects, symbols, distinct csrc sources.
    map_objects: int | None = None
    map_device_objects: int | None = None
    map_symbols: int | None = None
    map_sources: int | None = None
    verdict: str | None = None
    # The table or map was uploaded by its producing job.
    collected: bool = False
    # Recordings: published as latest[.rocm].json. Maps: re-uploaded by the
    # kernel collect next to the table it pairs with.
    published: bool = False
    published_commit: str | None = None
    # Why a published table's rows are degraded (rows_degraded), else None.
    rows_degraded: str | None = None
    # summary | log | artifacts | table | none; "table" when usable rows
    # were counted from the kernel table itself.
    source: str = "none"

    @property
    def usable_share(self) -> float | None:
        if self.usable_rows is None or not self.rows:
            return None
        return self.usable_rows / self.rows


@dataclass(frozen=True)
class FullRunRecord:
    """One scheduled Full CI Run. `settled` once both collect jobs finished
    (or the build did without them); a settled run is never fetched again."""

    build_number: int
    kind: str
    created_at: datetime
    commit_sha: str
    build_state: str
    settled: bool
    components: tuple[RunComponent, ...] = ()

    def component(self, component: Component) -> RunComponent | None:
        for item in self.components:
            if item.component == component.value:
                return item
        return None


@dataclass(frozen=True)
class SelectorDecision:
    """The selector decision one non-main build's bootstrap uploaded."""

    build_number: int
    created_at: datetime
    branch: str
    outcome: str
    pull_request: int | None = None
    reason: str | None = None
    seconds: float | None = None
    fnrec_build: int | None = None
    # The CUDA and ROCm kernel tables the decision used.
    kernrec_build: int | None = None
    kernrec_rocm_build: int | None = None
    # Kernel backends with an entry in records, sorted.
    kernel_backends: tuple[str, ...] = ()
    ci_infra_commit: str | None = None


@dataclass(frozen=True)
class SelectorAlertEpisode:
    condition: str
    subject_key: str
    opened_at: datetime
    resolved_at: datetime | None = None
    details: dict[str, Any] = field(default_factory=dict)
    alert_id: int | None = None


@dataclass(frozen=True)
class SelectorHealthState:
    """What a scan reads back before planning."""

    runs: tuple[FullRunRecord, ...]
    decisions: tuple[SelectorDecision, ...]
    open_episodes: tuple[SelectorAlertEpisode, ...]


@dataclass(frozen=True)
class SelectorHealthPlan:
    runs: tuple[FullRunRecord, ...] = ()
    decisions: tuple[SelectorDecision, ...] = ()
    opened: tuple[SelectorAlertEpisode, ...] = ()
    resolved: tuple[SelectorAlertEpisode, ...] = ()


SelectorNotificationFactory = Callable[[SelectorHealthPlan], list[NotificationIntent]]


class SelectorSource(Protocol):
    def full_runs(
        self, *, since: datetime, up_to: datetime, settled: frozenset[int]
    ) -> list[FullRunRecord]:
        """Scheduled Full CI Runs created in the window, except settled ones."""
        ...

    def decisions(
        self, *, since: datetime, up_to: datetime, known: frozenset[int]
    ) -> list[SelectorDecision]:
        """Decisions of non-main builds created in the window and not in
        `known`, once their bootstrap has finished."""
        ...


class SelectorHealthStore(Protocol):
    def selector_health_state(
        self, *, runs_since: datetime, decisions_since: datetime
    ) -> SelectorHealthState: ...

    def commit_selector_health(
        self,
        *,
        command: ScheduledCommand,
        plan: SelectorHealthPlan,
        now: datetime,
        notification_factory: SelectorNotificationFactory,
    ) -> None:
        """Atomically upsert runs and decisions, apply episode transitions,
        enqueue notifications for the applied ones, and complete the command.
        """
        ...


# --- Reading collect output ------------------------------------------------

_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
_BK_TIMESTAMP = re.compile(r"_bk;t=\d+\x07?")
_LINE_TIMESTAMP = re.compile(r"^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] ")
_PUBLISHED = re.compile(r"published; latest(\.rocm)?\.json -> ([0-9a-f]{7,40})")
_KERNEL_TABLE = re.compile(
    r"wrote out/kernel_table(\.rocm)?\.json\.gz \([^)]*\): (\{.*\})"
)
_ROWS_USABLE = re.compile(r"'rows_usable': (\d+)")
_ROWS_TOTAL = re.compile(r"'steps': (\d+)")
_NO_PAIR = re.compile(r"\b(cuda|rocm) has no valid table/map pair")
_RECORDING_FILES = re.compile(r"(\d+) recording files from (\d+) jobs")
_FN_EXPECTING = re.compile(r"expecting (\d+) jobs")
_FN_RECORDED = re.compile(r"(\d+)/(\d+) started jobs recorded")
_FN_ROWS = re.compile(r"^(\d+) rows \(")


def clean_log(text: str) -> list[str]:
    """Log lines without ANSI codes, Buildkite timestamps, or line stamps."""
    text = _BK_TIMESTAMP.sub("", _ANSI_ESCAPE.sub("", text))
    return [_LINE_TIMESTAMP.sub("", line.rstrip("\r")) for line in text.split("\n")]


def parse_kernrec_log(text: str) -> dict[Component, RecordingReading]:
    """CUDA and ROCm readings from a kernel collect log (before ci-infra#881).

    Old logs carry no expected-job count, so a backend is armed when the log
    folds or rejects a table for it; CUDA is armed whenever the collect ran.
    """
    tables: dict[str, int] = {}
    totals: dict[str, int] = {}
    no_pair: set[str] = set()
    published: dict[str, str] = {}
    files_jobs: tuple[int, int] | None = None
    nothing_to_fold = False
    for line in clean_log(text):
        if match := _RECORDING_FILES.search(line):
            files_jobs = (int(match.group(1)), int(match.group(2)))
        if match := _KERNEL_TABLE.search(line):
            backend = "rocm" if match.group(1) else "cuda"
            usable = _ROWS_USABLE.search(match.group(2))
            tables[backend] = int(usable.group(1)) if usable else 0
            if steps := _ROWS_TOTAL.search(match.group(2)):
                totals[backend] = int(steps.group(1))
        if match := _NO_PAIR.search(line):
            no_pair.add(match.group(1))
        if match := _PUBLISHED.search(line):
            published["rocm" if match.group(1) else "cuda"] = match.group(2)
        if "nothing to fold" in line:
            nothing_to_fold = True
    readings: dict[Component, RecordingReading] = {}
    for backend, component in (
        ("cuda", Component.KERNREC_CUDA),
        ("rocm", Component.KERNREC_ROCM),
    ):
        armed = backend == "cuda" or backend in tables or backend in no_pair
        rows = tables.get(backend)
        # A table with no usable rows says so even when it has no total.
        total = totals.get(backend, 0 if rows == 0 else None)
        if backend in published:
            verdict = "ok"
        elif nothing_to_fold:
            jobs = files_jobs[1] if files_jobs else 0
            verdict = f"nothing to fold ({jobs} jobs delivered recordings)"
        elif backend in no_pair:
            verdict = "no valid table/map pair"
        elif rows == 0:
            verdict = "table has no usable rows"
        else:
            verdict = "not published"
        readings[component] = RecordingReading(
            armed=armed,
            # Only a collect that found nothing says how many jobs a backend
            # delivered; otherwise the count spans both backends.
            delivered_jobs=0 if files_jobs is not None and files_jobs[1] == 0 else None,
            rows=total,
            usable_rows=rows,
            verdict=verdict,
            published=backend in published,
            published_commit=published.get(backend),
        )
    return readings


def parse_fnrec_log(text: str) -> RecordingReading:
    """The Python collect's reading from its log (before ci-infra#881)."""
    expected: int | None = None
    delivered: int | None = None
    rows: int | None = None
    commit: str | None = None
    verdict: str | None = None
    for line in clean_log(text):
        if match := _FN_EXPECTING.search(line):
            expected = int(match.group(1))
        if match := _FN_RECORDED.search(line):
            delivered, expected = int(match.group(1)), int(match.group(2))
        if match := _FN_ROWS.search(line.strip()):
            rows = int(match.group(1))
        if match := _PUBLISHED.search(line):
            if not match.group(1):
                commit = match.group(2)
        if "REFUSING" in line:
            verdict = line.strip()[:200]
        elif "table has no usable rows" in line and verdict is None:
            verdict = "table has no usable rows"
        elif "nothing to fold" in line and verdict is None:
            verdict = "nothing to fold"
    if commit is not None:
        verdict = "ok"
    return RecordingReading(
        armed=True,
        expected_jobs=expected,
        delivered_jobs=delivered,
        rows=rows,
        verdict=verdict or "not published",
        published=commit is not None,
        published_commit=commit,
    )


def _int_or_none(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _summary_reading(
    payload: Mapping[str, Any],
    *,
    rows_key: str | None,
    usable_key: str,
    commit: str | None,
) -> RecordingReading:
    expected = _int_or_none(payload.get("expected_jobs"))
    delivered = _int_or_none(payload.get("delivered_jobs"))
    verdict = str(payload.get("verdict") or "missing verdict")
    ok = verdict == "ok"
    return RecordingReading(
        # An unknown expected count arms a backend that delivered anything.
        armed=(expected or 0) > 0 or (delivered or 0) > 0,
        expected_jobs=expected,
        delivered_jobs=delivered,
        rows=_int_or_none(payload.get(rows_key)) if rows_key else None,
        usable_rows=_int_or_none(payload.get(usable_key)),
        verdict=verdict,
        published=ok,
        published_commit=commit if ok else None,
    )


def kernrec_summary_readings(
    payload: Mapping[str, Any],
) -> dict[Component, RecordingReading]:
    """Readings from kernrec_collect_summary.json (ci-infra#881)."""
    backends = payload.get("backends")
    backends = backends if isinstance(backends, dict) else {}
    commit = payload.get("commit") if isinstance(payload.get("commit"), str) else None
    readings: dict[Component, RecordingReading] = {}
    for backend, component in (
        ("cuda", Component.KERNREC_CUDA),
        ("rocm", Component.KERNREC_ROCM),
    ):
        entry = backends.get(backend)
        readings[component] = (
            # The summary counts usable rows only; the table says the rest.
            _summary_reading(
                entry, rows_key="rows", usable_key="usable_rows", commit=commit
            )
            if isinstance(entry, dict)
            else RecordingReading(armed=False, verdict="not in summary")
        )
    return readings


def fnrec_summary_reading(payload: Mapping[str, Any]) -> RecordingReading:
    """The reading from fnrec_collect_summary.json (ci-infra#881).

    `rows` is every row of the table. The summary has no usable-row count
    yet, so usable rows stay unknown unless it grows a `usable_rows` field.
    """
    commit = payload.get("commit") if isinstance(payload.get("commit"), str) else None
    return replace(
        _summary_reading(
            payload, rows_key="rows", usable_key="usable_rows", commit=commit
        ),
        armed=True,
    )


# Kernel tables from version 3 carry per-row backend and trace health.
KERNEL_TABLE_TRACE_VERSION = 3


def kernel_row_usable(row: Mapping[str, Any], *, trace_health: bool = True) -> bool:
    """The selector's rule for a usable kernel-table row. Tables from before
    trace health (version < 3, CUDA only) were usable without it, as their
    collect counted them."""
    return (
        bool(row.get("passed"))
        and bool(row.get("complete", True))
        and not row.get("dropped")
        and (
            not trace_health
            or (
                row.get("backend") in KERNEL_BACKENDS
                and row.get("trace_complete") is True
            )
        )
    )


def kernel_table_stats(payload: Mapping[str, Any]) -> KernelTableStats:
    """Count a kernel table's usable rows and the rows failing each condition."""
    rows = payload.get("rows")
    entries = [row for row in rows.values() if isinstance(row, dict)] if isinstance(
        rows, dict
    ) else []
    version = _int_or_none(payload.get("version"))
    trace_health = version is None or version >= KERNEL_TABLE_TRACE_VERSION
    return KernelTableStats(
        rows=len(entries),
        usable_rows=sum(
            1 for row in entries if kernel_row_usable(row, trace_health=trace_health)
        ),
        not_passed=sum(1 for row in entries if not row.get("passed")),
        trace_incomplete=(
            sum(1 for row in entries if row.get("trace_complete") is not True)
            if trace_health
            else None
        ),
        dropped=sum(1 for row in entries if row.get("dropped")),
        incomplete=sum(1 for row in entries if row.get("complete", True) is False),
    )


def _same_commit(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return False
    short = min(len(left), len(right))
    return short >= 7 and left[:short] == right[:short]


def source_map_stats(
    payload: Mapping[str, Any], *, build_commit: str, backend: str
) -> SourceMapStats:
    """Read one kernel source map. It is broken when it carries a `reason`
    (the image build could not produce it), has no objects, was built from
    another commit than the run's, or is for the other backend."""
    objects = payload.get("objects")
    entries = (
        [item for item in objects if isinstance(item, dict)]
        if isinstance(objects, list)
        else []
    )
    commit = payload.get("commit") if isinstance(payload.get("commit"), str) else None
    problems: list[str] = []
    reason = payload.get("reason")
    if reason:
        problems.append(f"map not built: {str(reason)[:200]}")
    elif not entries:
        problems.append("map has no objects")
    if not _same_commit(commit, build_commit):
        problems.append(
            f"map built from {(commit or 'no commit')[:12]}, run is at "
            f"{build_commit[:12]}"
        )
    map_backend = payload.get("backend") or "cuda"
    if map_backend != backend:
        problems.append(f"map is for {map_backend}, expected {backend}")
    return SourceMapStats(
        objects=len(entries),
        device_objects=sum(1 for item in entries if item.get("device")),
        symbols=sum(
            len(item["symbols"])
            for item in entries
            if isinstance(item.get("symbols"), list)
        ),
        sources=len(
            {
                item["source"]
                for item in entries
                if isinstance(item.get("source"), str)
                and item["source"].startswith("csrc/")
            }
        ),
        commit=commit,
        problems=tuple(problems),
    )


def _job_failed(job: Mapping[str, Any]) -> bool:
    return str(job.get("state")) != "passed" or bool(job.get("soft_failed"))


def recording_component(
    component: Component,
    job: Mapping[str, Any] | None,
    reading: RecordingReading | None,
    *,
    source: str,
    blame_job: bool,
    collected: bool = False,
    table: KernelTableStats | None = None,
    thresholds: SelectorHealthThresholds = DEFAULT_THRESHOLDS,
) -> RunComponent:
    """Grade one recording. `blame_job` adds a failed or soft-failed collect
    job to its problems: the caller clears it when another backend's own
    verdict already explains the failure (ci-infra#881 soft-fails the job
    when any armed backend is not whole). `table` is the kernel table read
    whole; its counts replace the summary's or log's."""
    if job is None:
        return RunComponent(component.value, ComponentStatus.OFF.value)
    base = RunComponent(
        component.value,
        ComponentStatus.PENDING.value,
        job_state=str(job.get("state") or ""),
        soft_failed=bool(job.get("soft_failed")),
        exit_status=_int_or_none(job.get("exit_status")),
        source=source,
        collected=collected,
    )
    if base.job_state not in TERMINAL_JOB_STATES:
        return base
    if reading is None:
        reading = RecordingReading(armed=True, verdict="no summary or log")
    base = replace(
        base,
        expected_jobs=reading.expected_jobs,
        delivered_jobs=reading.delivered_jobs,
        rows=reading.rows,
        usable_rows=reading.usable_rows,
        verdict=reading.verdict,
        published=reading.published,
        published_commit=reading.published_commit,
    )
    if table is not None:
        base = replace(
            base,
            rows=table.rows,
            usable_rows=table.usable_rows,
            rows_not_passed=table.not_passed,
            rows_trace_incomplete=table.trace_incomplete,
            rows_dropped=table.dropped,
            rows_incomplete=table.incomplete,
            source="table",
        )
    if not reading.armed:
        return replace(
            base,
            status=ComponentStatus.OFF.value,
            verdict="not armed for this run",
        )
    problems = recording_problems(base, thresholds=thresholds)
    if blame_job and _job_failed(job):
        problems.append(
            f"collect job {base.job_state}"
            + (" (soft-failed)" if base.soft_failed else "")
            + (f", exit {base.exit_status}" if base.exit_status is not None else "")
        )
    if not problems:
        return replace(base, status=ComponentStatus.OK.value)
    return replace(
        base, status=ComponentStatus.BROKEN.value, verdict="; ".join(problems)
    )


def recording_problems(
    item: RunComponent, *, thresholds: SelectorHealthThresholds = DEFAULT_THRESHOLDS
) -> list[str]:
    problems: list[str] = []
    if item.verdict and item.verdict != "ok":
        problems.append(item.verdict)
    elif not item.published:
        problems.append("published nothing")
    if (
        item.expected_jobs
        and item.delivered_jobs is not None
        and item.delivered_jobs < thresholds.min_delivered_ratio * item.expected_jobs
    ):
        problems.append(
            f"delivered {item.delivered_jobs} of {item.expected_jobs} expected jobs"
        )
    return problems


def map_component(
    component: Component,
    job: Mapping[str, Any] | None,
    artifacts: Iterable[str] | None,
    *,
    wanted: str,
    armed: bool,
    stats: SourceMapStats | None = None,
    unreadable: str | None = None,
    republished: bool = False,
) -> RunComponent:
    """Grade one kernel source map from its image build.

    Broken when the image build ran and the map is unreadable, carries a
    `reason`, has no objects, or was built from another commit; or when it
    was not uploaded although its backend's kernel recorder was armed.
    Missing (no alert) when the image build did not run or nothing needed
    the map.
    """
    if job is None:
        return RunComponent(
            component.value,
            ComponentStatus.MISSING.value,
            verdict="image build not in this run",
        )
    state = str(job.get("state") or "")
    if state not in TERMINAL_JOB_STATES or artifacts is None:
        return RunComponent(
            component.value, ComponentStatus.PENDING.value, job_state=state
        )
    present = any(path == wanted or path.endswith(f"/{wanted}") for path in artifacts)
    base = RunComponent(
        component.value,
        ComponentStatus.OK.value,
        job_state=state,
        collected=present,
        published=present and republished,
        source="artifacts",
    )
    if not present:
        ran = bool(job.get("started_at"))
        if ran and armed:
            return replace(
                base, status=ComponentStatus.BROKEN.value, verdict=f"{wanted} not uploaded"
            )
        return replace(
            base,
            status=ComponentStatus.MISSING.value,
            verdict=f"{wanted} not uploaded"
            + ("" if ran else " (image build did not run)"),
        )
    if unreadable is not None or stats is None:
        return replace(
            base,
            status=ComponentStatus.BROKEN.value,
            verdict=f"{wanted} unreadable: {unreadable or 'not read'}"[:500],
        )
    base = replace(
        base,
        map_objects=stats.objects,
        map_device_objects=stats.device_objects,
        map_symbols=stats.symbols,
        map_sources=stats.sources,
        published_commit=stats.commit,
    )
    if stats.problems:
        return replace(
            base,
            status=ComponentStatus.BROKEN.value,
            verdict="; ".join(stats.problems),
        )
    return replace(base, verdict="ok")


def decision_kernel_builds(records: Mapping[str, Any]) -> dict[str, int | None]:
    """The kernel table build a decision used, per backend.

    Parsed liberally, because the ROCm entry's shape is not final:
    `records.kernrec` as one dict (its `backend`, default cuda), as a dict of
    per-backend dicts, or as a list of per-backend dicts; and extra keys like
    `records.kernrec_rocm` (backend from the entry, else the key suffix).
    """

    def build_of(entry: Mapping[str, Any]) -> int | None:
        value = entry.get("build")
        if isinstance(value, bool):
            return None
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    found: dict[str, int | None] = {}

    def add(entry: Any, default_backend: str) -> None:
        if not isinstance(entry, dict):
            return
        backend = str(entry.get("backend") or default_backend).lower()
        if backend not in KERNEL_BACKENDS:
            return
        build = build_of(entry)
        if found.get(backend) is None:
            found[backend] = build

    for key, entry in records.items():
        if key == "kernrec":
            if isinstance(entry, list):
                for item in entry:
                    add(item, "cuda")
            elif isinstance(entry, dict) and "build" not in entry and any(
                name in KERNEL_BACKENDS for name in entry
            ):
                for name, item in entry.items():
                    add(item, str(name))
            else:
                add(entry, "cuda")
        elif key.startswith("kernrec_") or key.startswith("kernrec-"):
            add(entry, key[len("kernrec_") :])
    return found


def parse_decision(
    payload: Mapping[str, Any] | None,
    *,
    build_number: int,
    created_at: datetime,
    branch: str,
    pull_request: int | None,
) -> SelectorDecision:
    """One build's decision; a missing artifact is the `missing` outcome."""
    if payload is None:
        return SelectorDecision(
            build_number=build_number,
            created_at=created_at,
            branch=branch,
            pull_request=pull_request,
            outcome=DecisionOutcome.MISSING.value,
        )
    records = payload.get("records")
    records = records if isinstance(records, dict) else {}

    def record_build(name: str) -> int | None:
        entry = records.get(name)
        value = entry.get("build") if isinstance(entry, dict) else None
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    kernels = decision_kernel_builds(records)

    fallback = payload.get("fallback")
    skipped = payload.get("skipped")
    if fallback:
        outcome, reason = DecisionOutcome.FALLBACK, str(fallback)
    elif skipped:
        outcome, reason = DecisionOutcome.SKIPPED, str(skipped)
    elif payload.get("applied"):
        outcome, reason = DecisionOutcome.APPLIED, None
    else:
        outcome, reason = DecisionOutcome.SKIPPED, "not applied"
    seconds = payload.get("seconds")
    commit = payload.get("ci_infra_commit")
    return SelectorDecision(
        build_number=build_number,
        created_at=created_at,
        branch=branch,
        pull_request=pull_request,
        outcome=outcome.value,
        reason=reason[:500] if reason else None,
        seconds=float(seconds) if isinstance(seconds, (int, float)) else None,
        fnrec_build=record_build("fnrec"),
        kernrec_build=kernels.get("cuda"),
        kernrec_rocm_build=kernels.get("rocm"),
        kernel_backends=tuple(sorted(kernels)),
        ci_infra_commit=commit if isinstance(commit, str) and commit else None,
    )


# --- Planning ---------------------------------------------------------------


def _hours(delta: timedelta) -> float:
    return round(delta.total_seconds() / 3600, 1)


def _completed(runs: Iterable[FullRunRecord]) -> list[FullRunRecord]:
    return sorted(
        (run for run in runs if run.settled),
        key=lambda run: (run.created_at, run.build_number),
    )


def _last_published(
    runs: Iterable[FullRunRecord], component: Component
) -> FullRunRecord | None:
    published = [
        run
        for run in runs
        if (item := run.component(component)) is not None and item.published
    ]
    return max(
        published, key=lambda run: (run.created_at, run.build_number), default=None
    )


def _run_ref(run: FullRunRecord | None) -> dict[str, Any] | None:
    if run is None:
        return None
    return {
        "build_number": run.build_number,
        "kind": run.kind,
        "created_at": run.created_at.isoformat(),
    }


def _run_order(run: FullRunRecord) -> tuple[datetime, int]:
    return (run.created_at, run.build_number)


def rows_degradation(
    run: FullRunRecord,
    component: Component,
    history: Iterable[FullRunRecord],
    thresholds: SelectorHealthThresholds = DEFAULT_THRESHOLDS,
) -> dict[str, Any] | None:
    """Why `component`'s table in `run` is degraded, or None when it is not
    (or its usable rows are unknown, or it is not ok: run_incomplete covers
    a table that is not whole).

    Degraded when under `min_usable_share` of its rows are usable, or when
    its usable rows are under `min_usable_of_median` of the median usable
    rows of the previous `usable_median_runs` completed runs, counting those
    that published the table with a known usable count; the median rule waits
    for `usable_median_min_runs` of them.
    """
    item = run.component(component)
    if (
        item is None
        or item.status != ComponentStatus.OK
        or not item.published
        or item.usable_rows is None
    ):
        return None
    previous = sorted(
        (
            other
            for other in history
            if other.settled and _run_order(other) < _run_order(run)
        ),
        key=_run_order,
    )[-thresholds.usable_median_runs :]
    prior = [
        usable
        for other in previous
        if (entry := other.component(component)) is not None
        and entry.published
        and (usable := entry.usable_rows) is not None
    ]
    reasons: list[str] = []
    share = item.usable_share
    if share is not None and share < thresholds.min_usable_share:
        reasons.append(
            f"{item.usable_rows} of {item.rows} rows usable ({share:.0%}, "
            f"under {thresholds.min_usable_share:.0%})"
        )
    median: float | None = None
    if len(prior) >= thresholds.usable_median_min_runs:
        median = float(statistics.median(prior))
        if item.usable_rows < thresholds.min_usable_of_median * median:
            reasons.append(
                f"{item.usable_rows} usable rows, under "
                f"{thresholds.min_usable_of_median:.0%} of the median "
                f"{median:g} of the previous {len(prior)} runs"
            )
    if not reasons:
        return None
    return {
        "component": component.value,
        "build_number": run.build_number,
        "kind": run.kind,
        "created_at": run.created_at.isoformat(),
        "rows": item.rows,
        "usable_rows": item.usable_rows,
        "usable_share": round(share, 4) if share is not None else None,
        "median_usable_rows": median,
        "median_runs": len(prior),
        "rows_not_passed": item.rows_not_passed,
        "rows_trace_incomplete": item.rows_trace_incomplete,
        "rows_dropped": item.rows_dropped,
        "rows_incomplete": item.rows_incomplete,
        "reason": "; ".join(reasons),
        "threshold_share": thresholds.min_usable_share,
        "threshold_of_median": thresholds.min_usable_of_median,
    }


def grade_rows(
    runs: Iterable[FullRunRecord],
    thresholds: SelectorHealthThresholds = DEFAULT_THRESHOLDS,
) -> list[FullRunRecord]:
    """Every run with each table's `rows_degraded` reason filled in against
    the runs before it, so the page shows what the alert saw."""
    ordered = sorted(runs, key=_run_order)
    graded: list[FullRunRecord] = []
    for run in ordered:
        components = []
        for item in run.components:
            reason = None
            if item.component in {c.value for c in RECORDINGS}:
                details = rows_degradation(
                    run, Component(item.component), ordered, thresholds
                )
                reason = details["reason"] if details else None
            components.append(replace(item, rows_degraded=reason))
        graded.append(replace(run, components=tuple(components)))
    return graded


# A planner observation per (condition, subject): breach details, or None for
# a healthy observation. A subject with no observation keeps its episode.
Observations = dict[tuple[str, str], dict[str, Any] | None]


def _observe_runs(
    runs: list[FullRunRecord], thresholds: SelectorHealthThresholds
) -> Observations:
    observed: Observations = {}
    completed = _completed(runs)
    if not completed:
        return observed
    latest = completed[-1]
    for component in WHOLE_COMPONENTS:
        last = _last_published(runs, component)
        item = latest.component(component)
        key = (SelectorCondition.RUN_INCOMPLETE.value, component.value)
        if item is not None and item.status == ComponentStatus.BROKEN:
            observed[key] = {
                "component": component.value,
                "build_number": latest.build_number,
                "kind": latest.kind,
                "created_at": latest.created_at.isoformat(),
                "expected_jobs": item.expected_jobs,
                "delivered_jobs": item.delivered_jobs,
                "rows": item.rows,
                "usable_rows": item.usable_rows,
                "map_objects": item.map_objects,
                "verdict": item.verdict,
                "job_state": item.job_state,
                "soft_failed": item.soft_failed,
                "source": item.source,
                "last_published": _run_ref(last),
                "stale_hours": (
                    _hours(latest.created_at - last.created_at) if last else None
                ),
            }
        else:
            observed[key] = None
        if component not in RECORDINGS:
            continue

        key = (SelectorCondition.ROWS_DEGRADED.value, component.value)
        observed[key] = rows_degradation(latest, component, completed, thresholds)

        key = (SelectorCondition.STALE.value, component.value)
        if last is None and component == Component.KERNREC_ROCM:
            # ROCm alerts only once it has published at least once.
            continue
        lag = latest.created_at - last.created_at if last is not None else None
        if lag is None or lag > thresholds.stale_after:
            observed[key] = {
                "component": component.value,
                "newest_run": _run_ref(latest),
                "last_published": _run_ref(last),
                "stale_hours": _hours(lag) if lag is not None else None,
                "history_days": thresholds.history.days,
                "threshold_hours": _hours(thresholds.stale_after),
            }
        else:
            observed[key] = None
    return observed


def _observe_decisions(
    *,
    now: datetime,
    runs: list[FullRunRecord],
    decisions: list[SelectorDecision],
    thresholds: SelectorHealthThresholds,
) -> Observations:
    observed: Observations = {}
    by_build = {run.build_number: run for run in runs}
    recent = [
        decision
        for decision in decisions
        if decision.created_at >= now - thresholds.pr_stale_window
    ]
    for recorder, component in RECORD_COMPONENTS.items():
        used = [
            build
            for decision in recent
            if (build := getattr(decision, f"{recorder}_build")) is not None
        ]
        newest = _last_published(runs, component)
        if not used or newest is None:
            continue
        median = statistics.median_low(used)
        key = (SelectorCondition.PR_STALE.value, recorder)
        if median >= newest.build_number:
            observed[key] = None
            continue
        used_run = by_build.get(median)
        if used_run is not None:
            lag: timedelta | None = newest.created_at - used_run.created_at
        elif runs and median < min(by_build):
            lag = None  # older than every run in view
        else:
            continue  # not a full run this scan knows; no observation
        if lag is not None and lag <= thresholds.stale_after:
            observed[key] = None
            continue
        observed[key] = {
            "recorder": recorder,
            "component": component.value,
            "median_build": median,
            "median_run": _run_ref(used_run),
            "newest_published": _run_ref(newest),
            "lag_hours": _hours(lag) if lag is not None else None,
            "decisions": len(used),
            "window_hours": _hours(thresholds.pr_stale_window),
            "threshold_hours": _hours(thresholds.stale_after),
            "history_days": thresholds.history.days,
        }

    window = [
        decision
        for decision in decisions
        if decision.created_at >= now - thresholds.pr_error_window
    ]
    if window:
        errors = [
            decision
            for decision in window
            if decision.outcome == DecisionOutcome.FALLBACK
            and (decision.reason or "").lower().startswith(SELECTOR_ERROR_PREFIXES)
        ]
        rate = len(errors) / len(window)
        key = (SelectorCondition.PR_ERRORS.value, "selector")
        if (
            len(errors) >= thresholds.pr_error_min_builds
            and rate > thresholds.pr_error_rate
        ):
            reasons = Counter((decision.reason or "")[:160] for decision in errors)
            observed[key] = {
                "errors": len(errors),
                "builds": len(window),
                "rate": round(rate, 4),
                "window_hours": _hours(thresholds.pr_error_window),
                "threshold_rate": thresholds.pr_error_rate,
                "reasons": [
                    {"reason": reason, "count": count}
                    for reason, count in reasons.most_common(3)
                ],
                "builds_sample": sorted(
                    (decision.build_number for decision in errors), reverse=True
                )[:5],
            }
        else:
            observed[key] = None
    return observed


def plan_selector_health(
    *,
    now: datetime,
    runs: Iterable[FullRunRecord],
    decisions: Iterable[SelectorDecision],
    open_episodes: Iterable[SelectorAlertEpisode],
    thresholds: SelectorHealthThresholds = DEFAULT_THRESHOLDS,
) -> SelectorHealthPlan:
    """Open an episode on each new breach and resolve each open episode on
    its first healthy observation. Episodes open on the first observation:
    a full run only comes twice a day, so a second look would cost 12 hours.
    """
    run_list = [
        run for run in runs if run.created_at >= now - thresholds.history
    ]
    decision_list = [
        decision for decision in decisions if decision.branch != "main"
    ]
    observed = {
        **_observe_runs(run_list, thresholds),
        **_observe_decisions(
            now=now, runs=run_list, decisions=decision_list, thresholds=thresholds
        ),
    }
    current = {
        (episode.condition, episode.subject_key): episode for episode in open_episodes
    }
    opened: list[SelectorAlertEpisode] = []
    resolved: list[SelectorAlertEpisode] = []
    for (condition, subject), details in sorted(observed.items()):
        episode = current.get((condition, subject))
        if details is not None and episode is None:
            opened.append(
                SelectorAlertEpisode(
                    condition=condition,
                    subject_key=subject,
                    opened_at=now,
                    details=details,
                )
            )
        elif details is None and episode is not None:
            resolved.append(replace(episode, resolved_at=now))
    return SelectorHealthPlan(opened=tuple(opened), resolved=tuple(resolved))


# --- Rendering --------------------------------------------------------------


def _escape(value: Any) -> str:
    return html.escape(str(value), quote=False)


def _build_link(build_number: Any) -> str:
    return f"<{BUILD_URL.format(build_number)}|#{_escape(build_number)}>"


def _jobs(details: Mapping[str, Any]) -> str:
    expected, delivered = details.get("expected_jobs"), details.get("delivered_jobs")
    if expected is None and delivered is None:
        return "job counts not reported (run before ci-infra#881)"
    return f"delivered {delivered if delivered is not None else '?'} of {expected if expected is not None else '?'} expected jobs"


def _published_line(details: Mapping[str, Any], key: str = "last_published") -> str:
    last = details.get(key)
    hours = details.get("stale_hours")
    if not isinstance(last, dict):
        return (
            f"Nothing published in the last {_escape(details.get('history_days', 14))} days."
        )
    stale = f", {_escape(hours)} h before the newest completed run" if hours else ""
    return (
        f"Last published by {last.get('kind', 'full')} run "
        f"{_build_link(last.get('build_number'))}{stale}."
    )


def _label(component: Any) -> str:
    try:
        return COMPONENT_LABELS[Component(str(component))]
    except ValueError:
        return _escape(component)


def render_open(episode: SelectorAlertEpisode) -> str:
    details = episode.details
    if episode.condition == SelectorCondition.RUN_INCOMPLETE and str(
        details.get("component") or ""
    ).startswith("map_"):
        objects = details.get("map_objects")
        return "\n".join(
            [
                f":rotating_light: *CI selector* — {_label(details.get('component'))} "
                f"broken in {details.get('kind', 'full')} run "
                f"{_build_link(details.get('build_number'))}",
                f"Verdict: {_escape(details.get('verdict') or 'unknown')}"
                + (f" ({_escape(objects)} objects)." if objects is not None else "."),
                "The kernel collect cannot pair this backend's table with a map "
                f"from this run. <{PAGE_URL}|Recording health>",
            ]
        )
    if episode.condition == SelectorCondition.ROWS_DEGRADED:
        failing = [
            f"{_escape(details.get(key))} {label}"
            for key, label in (
                ("rows_trace_incomplete", "with an incomplete trace"),
                ("rows_not_passed", "from jobs that did not pass"),
                ("rows_dropped", "with dropped recordings"),
                ("rows_incomplete", "incomplete"),
            )
            if details.get(key)
        ]
        median = details.get("median_usable_rows")
        lines = [
            f":warning: *CI selector* — {_label(details.get('component'))} "
            f"degraded in {details.get('kind', 'full')} run "
            f"{_build_link(details.get('build_number'))}",
            f"{_escape(details.get('reason') or 'usable rows dropped')}.",
        ]
        if failing:
            lines.append("Unusable rows: " + ", ".join(failing) + ".")
        if median is not None:
            lines.append(
                f"Median usable rows of the previous {_escape(details.get('median_runs'))} "
                f"runs: {_escape(f'{median:g}' if isinstance(median, (int, float)) else median)}."
            )
        lines.append(
            "The table published, so PR builds select from it with fewer rows. "
            f"<{PAGE_URL}|Recording health>"
        )
        return "\n".join(lines)
    if episode.condition == SelectorCondition.RUN_INCOMPLETE:
        rows = details.get("usable_rows", details.get("rows"))
        return "\n".join(
            [
                f":rotating_light: *CI selector* — {_label(details.get('component'))} "
                f"not whole in {details.get('kind', 'full')} run "
                f"{_build_link(details.get('build_number'))}",
                f"Verdict: {_escape(details.get('verdict') or 'unknown')}",
                f"Collect: {_escape(_jobs(details))}"
                + (f", {_escape(rows)} usable rows." if rows is not None else "."),
                _published_line(details),
                f"PR builds keep using the last published recording. <{PAGE_URL}|Recording health>",
            ]
        )
    if episode.condition == SelectorCondition.STALE:
        newest = details.get("newest_run") or {}
        hours = details.get("stale_hours")
        headline = (
            f"stale for {_escape(hours)} h"
            if hours is not None
            else f"not published in {_escape(details.get('history_days', 14))} days"
        )
        return "\n".join(
            [
                f":rotating_light: *CI selector* — {_label(details.get('component'))} "
                f"{headline}",
                _published_line(details)
                + f" Newest completed run: {_build_link(newest.get('build_number'))} "
                f"(threshold {_escape(details.get('threshold_hours'))} h).",
                f"<{PAGE_URL}|Recording health>",
            ]
        )
    if episode.condition == SelectorCondition.PR_STALE:
        newest = details.get("newest_published") or {}
        lag = details.get("lag_hours")
        lag_text = (
            f"{_escape(lag)} h older than"
            if lag is not None
            else f"older than the {_escape(details.get('history_days', 14))}-day history before"
        )
        return "\n".join(
            [
                f":rotating_light: *CI selector* — PR builds are not picking up the "
                f"newest {_escape(details.get('recorder'))} recording",
                f"Median recording build in the last {_escape(details.get('window_hours'))} h "
                f"of decisions ({_escape(details.get('decisions'))}): "
                f"{_build_link(details.get('median_build'))}, {lag_text} "
                f"the newest published, {_build_link(newest.get('build_number'))}.",
                f"<{PAGE_URL}|Recording health>",
            ]
        )
    if episode.condition == SelectorCondition.PR_ERRORS:
        rate = float(details.get("rate") or 0) * 100
        reasons = details.get("reasons") or []
        lines = [
            f":rotating_light: *CI selector* — {_escape(details.get('errors'))} of "
            f"{_escape(details.get('builds'))} PR builds ({rate:.1f}%) fell back on a "
            f"selector error in the last {_escape(details.get('window_hours'))} h",
        ]
        for entry in reasons:
            if isinstance(entry, dict):
                lines.append(
                    f"• {_escape(entry.get('count'))}× `{_escape(entry.get('reason'))}`"
                )
        sample = details.get("builds_sample") or []
        if sample:
            lines.append("Builds: " + ", ".join(_build_link(build) for build in sample))
        lines.append(f"<{PAGE_URL}|Recording health>")
        return "\n".join(lines)
    raise ValueError(f"no open renderer for condition: {episode.condition}")


def render_resolve(episode: SelectorAlertEpisode) -> str:
    """Posted only when the open message is gone; otherwise the runtime edits
    the open message in place."""
    subject = (
        _label(episode.subject_key)
        if episode.condition
        in (
            SelectorCondition.RUN_INCOMPLETE,
            SelectorCondition.STALE,
            SelectorCondition.ROWS_DEGRADED,
        )
        else _escape(episode.subject_key)
    )
    return (
        f":white_check_mark: *CI selector resolved* — {episode.condition.replace('_', ' ')}: "
        f"{subject}"
    )


def _intent(
    episode: SelectorAlertEpisode,
    *,
    verb: str,
    text: str,
    delivery_mode: DeliveryMode,
) -> NotificationIntent:
    digest = hashlib.sha256(
        f"{episode.condition}\0{episode.subject_key}".encode()
    ).hexdigest()[:16]
    epoch = int(episode.opened_at.timestamp())
    return NotificationIntent(
        # ':resolve' edits the paired ':open' message in place (see runtime).
        delivery_id=f"selector:{episode.condition}:{digest}:{epoch}:{verb}",
        alert_ref=f"selector:{episode.condition}:{episode.subject_key}",
        alert_path=AlertPath.SELECTOR,
        delivery_mode=delivery_mode,
        destination_mode=DestinationMode.BOT_TOKEN,
        destination=infra_slack_channel(),
        payload=headed_payload(text, source="CI SELECTOR", icon="🧭"),
    )


def selector_notifications(
    plan: SelectorHealthPlan, *, delivery_mode: DeliveryMode
) -> list[NotificationIntent]:
    """Exactly one intent per applied transition."""
    return [
        *(
            _intent(
                episode, verb="open", text=render_open(episode), delivery_mode=delivery_mode
            )
            for episode in plan.opened
        ),
        *(
            _intent(
                episode,
                verb="resolve",
                text=render_resolve(episode),
                delivery_mode=delivery_mode,
            )
            for episode in plan.resolved
        ),
    ]


# --- Handler ----------------------------------------------------------------


class SelectorHealthHandler:
    """Ingest full runs and PR decisions, then plan and commit episodes.

    The twice-daily scan reads full runs and decisions; the hourly PR scan
    reads only decisions and re-plans with the stored runs.
    """

    def __init__(
        self,
        *,
        source: SelectorSource,
        store: SelectorHealthStore,
        clock: Clock,
        delivery_mode: DeliveryMode = DeliveryMode.LIVE,
        thresholds: SelectorHealthThresholds = DEFAULT_THRESHOLDS,
        ingest_full_runs: bool = True,
    ) -> None:
        self._source = source
        self._store = store
        self._clock = clock
        self._delivery_mode = delivery_mode
        self._thresholds = thresholds
        self._ingest_full_runs = ingest_full_runs

    def __call__(self, command: ScheduledCommand) -> HandlerCompletion:
        now = command.target_time
        since = now - self._thresholds.history
        decisions_since = now - DECISION_LOOKBACK
        state = self._store.selector_health_state(
            runs_since=since, decisions_since=decisions_since
        )
        runs = {run.build_number: run for run in state.runs}
        fresh: list[FullRunRecord] = []
        if self._ingest_full_runs:
            fresh = self._source.full_runs(
                since=since,
                up_to=now,
                settled=frozenset(n for n, run in runs.items() if run.settled),
            )
            runs.update({run.build_number: run for run in fresh})
            # Store each fresh run with its tables' rows_degraded reasons.
            graded = {
                run.build_number: run
                for run in grade_rows(runs.values(), self._thresholds)
            }
            fresh = [graded[run.build_number] for run in fresh]
        new_decisions = self._source.decisions(
            since=decisions_since,
            up_to=now,
            known=frozenset(decision.build_number for decision in state.decisions),
        )
        plan = plan_selector_health(
            now=now,
            runs=runs.values(),
            decisions=[*state.decisions, *new_decisions],
            open_episodes=state.open_episodes,
            thresholds=self._thresholds,
        )
        plan = replace(plan, runs=tuple(fresh), decisions=tuple(new_decisions))
        self._store.commit_selector_health(
            command=command,
            plan=plan,
            now=self._clock.now(),
            notification_factory=lambda applied: selector_notifications(
                applied, delivery_mode=self._delivery_mode
            ),
        )
        return HandlerCompletion.TRANSACTIONAL


# --- Buildkite adapter ------------------------------------------------------


class SelectorBuildkitePort(Protocol):
    def list_builds(
        self, *, start_time: datetime | None, up_to: datetime, branch: str | None = "main"
    ) -> list[dict[str, Any]]: ...

    def list_jobs(self, build_number: int) -> list[dict[str, Any]]: ...

    def list_job_artifacts(
        self, build_number: int, job_id: str
    ) -> list[dict[str, Any]]: ...

    def download_artifact(self, download_url: str, *, max_bytes: int) -> bytes: ...

    def job_log_tail(
        self, build_number: int, job_id: str, *, max_bytes: int
    ) -> str: ...


def _decode_json(body: bytes, *, max_bytes: int = MAX_JSON_BYTES) -> dict[str, Any] | None:
    """A JSON object from plain or gzipped bytes; ValueError when unreadable
    or larger than `max_bytes` once decompressed."""
    if body[:2] == b"\x1f\x8b":
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(body)) as stream:
                body = stream.read(max_bytes + 1)
        except (OSError, EOFError) as exc:
            raise ValueError(f"bad gzip: {exc}") from exc
        if len(body) > max_bytes:
            raise ValueError(f"over {max_bytes} bytes decompressed")
    payload = json.loads(body)
    return payload if isinstance(payload, dict) else None


def _parse_time(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _pull_request(build: Mapping[str, Any]) -> int | None:
    pull = build.get("pull_request")
    value = pull.get("id") if isinstance(pull, dict) else None
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


class BuildkiteSelectorSource:
    """Read full runs and decisions through the Buildkite REST client."""

    def __init__(self, buildkite: SelectorBuildkitePort) -> None:
        self._buildkite = buildkite

    def _artifacts(self, build_number: int, job: Mapping[str, Any]) -> list[dict[str, Any]]:
        return self._buildkite.list_job_artifacts(build_number, str(job["id"]))

    @staticmethod
    def _find(
        artifacts: Iterable[Mapping[str, Any]], name: str
    ) -> Mapping[str, Any] | None:
        for artifact in artifacts:
            path = str(artifact.get("path") or "")
            if path == name or path.endswith(f"/{name}"):
                return artifact
        return None

    def _download(self, artifact: Mapping[str, Any], *, max_bytes: int) -> bytes:
        return self._buildkite.download_artifact(
            str(artifact["download_url"]), max_bytes=max_bytes
        )

    def _json_artifact(
        self,
        artifacts: Iterable[Mapping[str, Any]],
        name: str,
        *,
        max_bytes: int = MAX_ARTIFACT_BYTES,
    ) -> dict[str, Any] | None:
        artifact = self._find(artifacts, name)
        if artifact is None:
            return None
        return _decode_json(self._download(artifact, max_bytes=max_bytes))

    def _kernel_table(
        self, artifacts: Iterable[Mapping[str, Any]], name: str
    ) -> KernelTableStats | None:
        """The kernel table's row counts; None when it is absent or cannot
        be read, and the summary's or log's usable rows stand."""
        try:
            payload = self._json_artifact(artifacts, name, max_bytes=MAX_TABLE_BYTES)
        except Exception:  # noqa: BLE001 — any failure falls back to the summary
            return None
        return kernel_table_stats(payload) if payload is not None else None

    def full_runs(
        self, *, since: datetime, up_to: datetime, settled: frozenset[int]
    ) -> list[FullRunRecord]:
        runs: list[FullRunRecord] = []
        for build in self._buildkite.list_builds(start_time=since, up_to=up_to):
            first_line = str(build.get("message") or "").strip().split("\n", 1)[0]
            kind = FULL_RUN_MESSAGES.get(first_line.strip())
            number = int(build["number"])
            if kind is None or number in settled:
                continue
            runs.append(self._full_run(build, number, kind))
        return sorted(runs, key=lambda run: (run.created_at, run.build_number))

    def _full_run(
        self, build: Mapping[str, Any], number: int, kind: str
    ) -> FullRunRecord:
        jobs: dict[str, dict[str, Any]] = {}
        for job in self._buildkite.list_jobs(number):
            key = job.get("step_key")
            if key in (FNREC_COLLECT, KERNREC_COLLECT, IMAGE_BUILD, IMAGE_BUILD_AMD):
                jobs[str(key)] = job
        build_state = str(build.get("state") or "")
        commit = str(build.get("commit") or "")
        fn_job, kern_job = jobs.get(FNREC_COLLECT), jobs.get(KERNREC_COLLECT)

        def finished(job: Mapping[str, Any] | None) -> bool:
            return job is not None and str(job.get("state")) in TERMINAL_JOB_STATES

        components: list[RunComponent] = []
        # Python collect: summary, else log. Its table is too big to read.
        fn_reading, fn_source = None, "none"
        fn_artifacts: list[dict[str, Any]] = []
        if finished(fn_job):
            assert fn_job is not None
            fn_artifacts = self._artifacts(number, fn_job)
            summary = self._json_artifact(fn_artifacts, FNREC_SUMMARY)
            if summary is not None:
                fn_reading, fn_source = fnrec_summary_reading(summary), "summary"
            elif fn_job.get("started_at"):
                fn_reading, fn_source = parse_fnrec_log(
                    self._buildkite.job_log_tail(
                        number, str(fn_job["id"]), max_bytes=LOG_TAIL_BYTES
                    )
                ), "log"
        components.append(
            recording_component(
                Component.FNREC,
                fn_job,
                fn_reading,
                source=fn_source,
                blame_job=True,
                collected=self._find(fn_artifacts, FNREC_TABLE) is not None,
            )
        )
        # Kernel collect: one job, two backends, two small tables read whole.
        kern_readings: dict[Component, RecordingReading] = {}
        kern_source = "none"
        kern_artifacts: list[dict[str, Any]] = []
        tables: dict[Component, KernelTableStats | None] = {}
        if finished(kern_job):
            assert kern_job is not None
            kern_artifacts = self._artifacts(number, kern_job)
            summary = self._json_artifact(kern_artifacts, KERNREC_SUMMARY)
            if summary is not None:
                kern_readings, kern_source = kernrec_summary_readings(summary), "summary"
            elif kern_job.get("started_at"):
                kern_readings, kern_source = parse_kernrec_log(
                    self._buildkite.job_log_tail(
                        number, str(kern_job["id"]), max_bytes=LOG_TAIL_BYTES
                    )
                ), "log"
            tables = {
                Component.KERNREC_CUDA: self._kernel_table(kern_artifacts, CUDA_TABLE),
                Component.KERNREC_ROCM: self._kernel_table(kern_artifacts, ROCM_TABLE),
            }
        table_names = {
            Component.KERNREC_CUDA: CUDA_TABLE,
            Component.KERNREC_ROCM: ROCM_TABLE,
        }

        def grade_kernels(blame_job: bool) -> dict[Component, RunComponent]:
            return {
                component: recording_component(
                    component,
                    kern_job,
                    kern_readings.get(component),
                    source=kern_source,
                    blame_job=blame_job,
                    collected=self._find(kern_artifacts, table_names[component])
                    is not None,
                    table=tables.get(component),
                )
                for component in KERNEL_TABLES
            }

        graded = grade_kernels(False)
        if (
            kern_job is not None
            and finished(kern_job)
            and _job_failed(kern_job)
            and not any(item.status == ComponentStatus.BROKEN for item in graded.values())
        ):
            # Nothing a backend said explains the failure: blame the job.
            graded = grade_kernels(True)
        components.extend(graded.values())
        # Kernel source maps from the image builds.
        for component, step, wanted, recording, backend in (
            (Component.MAP_CUDA, IMAGE_BUILD, CUDA_MAP, Component.KERNREC_CUDA, "cuda"),
            (
                Component.MAP_ROCM,
                IMAGE_BUILD_AMD,
                ROCM_MAP,
                Component.KERNREC_ROCM,
                "rocm",
            ),
        ):
            image_job = jobs.get(step)
            image_artifacts = (
                self._artifacts(number, image_job)
                if image_job is not None and finished(image_job)
                else None
            )
            stats: SourceMapStats | None = None
            unreadable: str | None = None
            found = (
                self._find(image_artifacts, wanted) if image_artifacts is not None else None
            )
            if found is not None:
                body = self._download(found, max_bytes=MAX_MAP_BYTES)
                try:
                    payload = _decode_json(body)
                except ValueError as exc:
                    unreadable = str(exc)[:200]
                else:
                    if payload is None:
                        unreadable = "not a JSON object"
                    else:
                        stats = source_map_stats(
                            payload, build_commit=commit, backend=backend
                        )
            armed = graded[recording].status in (
                ComponentStatus.OK,
                ComponentStatus.BROKEN,
            )
            components.append(
                map_component(
                    component,
                    image_job,
                    [str(item.get("path") or "") for item in image_artifacts]
                    if image_artifacts is not None
                    else None,
                    wanted=wanted,
                    armed=armed,
                    stats=stats,
                    unreadable=unreadable,
                    republished=self._find(kern_artifacts, wanted) is not None,
                )
            )
        settled = (finished(fn_job) or fn_job is None) and (
            finished(kern_job) or kern_job is None
        )
        if fn_job is None and kern_job is None:
            # A build without collect steps is done once the build is.
            settled = build_state in TERMINAL_BUILD_STATES
        return FullRunRecord(
            build_number=number,
            kind=kind,
            created_at=_parse_time(build.get("created_at")),
            commit_sha=commit,
            build_state=build_state,
            settled=settled,
            components=tuple(components),
        )

    def decisions(
        self, *, since: datetime, up_to: datetime, known: frozenset[int]
    ) -> list[SelectorDecision]:
        builds = [
            build
            for build in self._buildkite.list_builds(
                start_time=since, up_to=up_to, branch=None
            )
            if str(build.get("branch") or "") != "main"
            and int(build["number"]) not in known
        ]
        builds.sort(key=lambda build: int(build["number"]), reverse=True)
        decisions: list[SelectorDecision] = []
        for build in builds[:MAX_DECISION_BUILDS_PER_SCAN]:
            decision = self._decision(build)
            if decision is not None:
                decisions.append(decision)
        return decisions

    def _decision(self, build: Mapping[str, Any]) -> SelectorDecision | None:
        number = int(build["number"])
        bootstrap = next(
            (
                job
                for job in self._buildkite.list_jobs(number)
                if job.get("step_key") == BOOTSTRAP
            ),
            None,
        )
        build_done = str(build.get("state") or "") in TERMINAL_BUILD_STATES
        if bootstrap is None and not build_done:
            return None  # not uploaded yet; the next scan looks again
        if bootstrap is not None and str(bootstrap.get("state")) not in TERMINAL_JOB_STATES:
            return None
        payload = (
            self._json_artifact(self._artifacts(number, bootstrap), DECISION_ARTIFACT)
            if bootstrap is not None
            else None
        )
        return parse_decision(
            payload,
            build_number=number,
            created_at=_parse_time(build.get("created_at")),
            branch=str(build.get("branch") or ""),
            pull_request=_pull_request(build),
        )
