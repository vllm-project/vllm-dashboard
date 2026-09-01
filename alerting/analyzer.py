"""Full CI analyzer compatibility adapter.

The bundled analyzer instructions run behind this adapter through an
`AnalyzerRunner` (see `alerting.kimi`). Before analysis the adapter
materializes the working files the instructions
expect (`.logs/nightly_summary.json`, `.logs/nightly_full.json`,
`.logs/failed_tests_cache.json`, and the agent-memory directory) from Postgres,
Buildkite, and the latest referenced S3 checkpoint. After analysis it validates
the skill's outputs, uploads a new immutable checkpoint, and transactionally
persists classifications, attribution, the rendered report, the checkpoint
reference, and the Slack notification intent.

A failure at any point — LLM error, invalid output, missing checkpoint, upload
or commit failure — leaves the previous baseline authoritative and finalizes
no outbox row, so the next tick retries from durable state.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import importlib.resources
import json
import re
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol, cast
from zoneinfo import ZoneInfo

from alerting.commands import ScheduledCommand, SCHEMA_VERSION
from alerting.fast_ci import slack_channel
from alerting.full_ci import FullCIJobOutcome, FullCIRun
from alerting.ports import (
    AlertPath,
    Clock,
    DeliveryMode,
    DestinationMode,
    NotificationIntent,
)

COMPLETENESS_THRESHOLD = 0.95
REPORT_CHAR_LIMIT = 2800
CHECKPOINT_SCHEMA_VERSION = SCHEMA_VERSION
PACIFIC = ZoneInfo("America/Los_Angeles")

# The NVIDIA-GPU scope filter preserved verbatim from the existing pre-script.
NON_NVIDIA_JOB = re.compile(
    r"AMD|MI300|Neuron|HPU|Intel|Ascend|NPU|IBM|Torch Nightly", re.IGNORECASE
)

MEMORY_DIR = Path(".claude/agent-memory/vllm-ci-failure-analyzer")
REPORT_FILE = Path(".logs/ci_report.txt")
CACHE_FILE = Path(".logs/failed_tests_cache.json")
SUSPICIOUS_PRS_FILE = Path(".logs/suspicious_prs.json")
SUMMARY_FILE = Path(".logs/nightly_summary.json")
FULL_BUILD_FILE = Path(".logs/nightly_full.json")
ANALYZER_AGENT_FILE = Path(".claude/agents/vllm-ci-failure-analyzer.md")


class AnalyzerError(Exception):
    """The analyzer failed or produced an invalid result. Nothing persists."""


class CheckpointUnavailable(AnalyzerError):
    """The referenced checkpoint cannot be read from the configured bucket.

    Raised when a stack recreation swapped the bucket out from under stored
    references (foreign bucket, missing object, access denied). Recoverable:
    the handler falls back to empty memory and uploads a fresh checkpoint.
    """


class CauseCategory(StrEnum):
    INFRASTRUCTURE = "infrastructure"
    FLAKY_TEST = "flaky_test"
    TEST = "test"
    CODE = "code"
    UNKNOWN = "unknown"


class FailureLifecycle(StrEnum):
    NEW = "new"
    RECURRING = "recurring"
    FIXED = "fixed"


@dataclass(frozen=True)
class PullRequestRef:
    number: int
    url: str
    title: str


@dataclass(frozen=True)
class FailureCondition:
    """One job's classification for one Full CI comparison."""

    job_name: str
    lifecycle: FailureLifecycle
    cause: CauseCategory
    summary: str
    culprit_pr: PullRequestRef | None = None
    fixing_pr: PullRequestRef | None = None


@dataclass(frozen=True)
class FailureCache:
    """The analyzer's previous-failure cache; the next comparison's baseline."""

    build_number: int | None
    commit: str | None
    failed_tests: tuple[str, ...]

    @classmethod
    def empty(cls) -> FailureCache:
        return cls(build_number=None, commit=None, failed_tests=())


@dataclass(frozen=True)
class SuspiciousPR:
    pr_number: int
    pr_url: str
    pr_title: str
    failure_count: int
    failed_tests: tuple[str, ...]
    summary: str


@dataclass(frozen=True)
class CheckpointRef:
    """Postgres's reference to one immutable versioned checkpoint object."""

    s3_uri: str
    sha256: str
    schema_version: int


@dataclass(frozen=True)
class ComparisonContext:
    """One unanalyzed comparison and the current run's durable identity."""

    previous_build_id: str
    current: FullCIRun


@dataclass(frozen=True)
class PersistedAnalysis:
    current_build_id: str
    previous_build_id: str
    report_text: str
    failure_cache: FailureCache
    suspicious_prs: tuple[SuspiciousPR, ...]
    conditions: tuple[FailureCondition, ...]
    analyzed_at: datetime


@dataclass(frozen=True)
class CompletedAnalysis:
    """Everything one successful analysis commits, plus its new checkpoint."""

    current_build_id: str
    previous_build_id: str
    report_text: str
    failure_cache: FailureCache
    suspicious_prs: tuple[SuspiciousPR, ...]
    conditions: tuple[FailureCondition, ...]
    checkpoint: CheckpointRef
    """The pull request the analyzed run's head commit merged, when GitHub
    reaches one. Resolved anyway to write the report, so recording it costs no
    extra request and lets readers name the change a run carried."""
    commit_pull_request: PullRequestRef | None = None


@dataclass(frozen=True)
class ReportAttribution:
    """One parsed new-failure bullet from the rendered report."""

    cause: CauseCategory
    summary: str
    pr_number: int | None


class FullCIBuildPort(Protocol):
    def get_build(self, build_number: int) -> dict[str, Any]: ...


class AnalyzerRunner(Protocol):
    """Runs the analyzer instructions in a prepared working directory."""

    def run(self, working_dir: Path) -> None:
        """Raise AnalyzerError on any LLM failure."""
        ...


class CheckpointStore(Protocol):
    def upload(self, files: Mapping[str, bytes]) -> CheckpointRef:
        """Store one immutable object; raise if it cannot be confirmed."""
        ...

    def download(self, s3_uri: str) -> bytes:
        """The raw object; the caller verifies it against the recorded checksum."""
        ...


class GitHubPort(Protocol):
    """Read-only GitHub lookups used for attribution."""

    def pull_for_commit(self, commit_sha: str) -> PullRequestRef | None: ...

    def find_merged_revert(self, pr_number: int) -> PullRequestRef | None:
        """A merged PR that reverts `pr_number`, else None. Never invented."""
        ...


class AnalyzerStore(Protocol):
    def pending_comparisons(self) -> list[ComparisonContext]:
        """Unanalyzed comparisons, oldest current run first."""
        ...

    def failure_cache_before(self, scheduled_at: datetime) -> FailureCache:
        """Latest analyzed or imported failure baseline before this run."""
        ...

    def latest_checkpoint(self) -> CheckpointRef | None:
        """The checkpoint referenced by the most recent analysis."""
        ...

    def prior_condition(
        self, job_name: str, *, before: datetime
    ) -> FailureCondition | None:
        """The job's most recent condition from runs scheduled before `before`."""
        ...

    def commit_analysis(
        self,
        *,
        analysis: CompletedAnalysis,
        notification: NotificationIntent,
        now: datetime,
    ) -> None:
        """Atomically persist the analysis, its conditions, the checkpoint
        reference, and the notification intent. Already-persisted analyses are
        a no-op so retried commands cannot duplicate them."""
        ...


def pack_checkpoint(files: Mapping[str, bytes]) -> bytes:
    """A deterministic gzip tarball: sorted names, zeroed metadata."""
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
        for name in sorted(files):
            info = tarfile.TarInfo(name)
            info.size = len(files[name])
            info.mtime = 0
            tar.addfile(info, io.BytesIO(files[name]))
    return gzip.compress(tar_buffer.getvalue(), mtime=0)


def unpack_checkpoint(blob: bytes) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(blob)), mode="r:") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            extracted = tar.extractfile(member)
            if extracted is None:
                continue
            files[member.name] = extracted.read()
    return files


_BULLET = re.compile(r"^•\s+(?P<name>.+?)\s+—\s+_(?P<summary>.+?)_\s*$")
_PR_LINK = re.compile(r"pull/(?P<number>\d+)")
_PR_TEXT = re.compile(r"PR #(?P<number>\d+)")


def parse_report_attributions(report_text: str) -> dict[str, ReportAttribution]:
    """Parse `• Name — _summary_` bullets; only new-failure bullets carry one."""
    attributions: dict[str, ReportAttribution] = {}
    for line in report_text.splitlines():
        match = _BULLET.match(line)
        if match is None:
            continue
        summary = match.group("summary")
        attributions[match.group("name")] = ReportAttribution(
            cause=_cause_for_summary(summary),
            summary=summary,
            pr_number=_pr_number(summary),
        )
    return attributions


def _cause_for_summary(summary: str) -> CauseCategory:
    lowered = summary.lower()
    if lowered.startswith("env:"):
        return CauseCategory.INFRASTRUCTURE
    if lowered.startswith("suspicious:"):
        return CauseCategory.CODE
    if lowered.startswith("possibly flaky"):
        return CauseCategory.FLAKY_TEST
    if lowered.startswith("newly enabled"):
        return CauseCategory.TEST
    return CauseCategory.UNKNOWN


def _pr_number(summary: str) -> int | None:
    match = _PR_LINK.search(summary) or _PR_TEXT.search(summary)
    return int(match.group("number")) if match is not None else None


_BULLET_NAME_LINK = re.compile(r"^(?P<prefix>\s*•\s+)<https?://[^|>]+\|(?P<label>[^>]+)>")
_BULLET_NAME_CODE = re.compile(r"^(?P<prefix>\s*•\s+)`(?P<name>[^`]+)`")


def _plain_bullet_names(report_text: str) -> str:
    """Unwrap links and code spans around job names at bullet starts.

    The model wraps names inconsistently; Slack does not render custom emoji
    shortcodes (":nvidia:") inside link labels or code spans, and the mangled
    names also fail to match Buildkite job names during attribution parsing.
    """
    lines = []
    for line in report_text.splitlines():
        linked = _BULLET_NAME_LINK.match(line)
        if linked is not None:
            name = linked.group("label").strip().strip("`")
            line = f"{linked.group('prefix')}{name}{line[linked.end():]}"
        coded = _BULLET_NAME_CODE.match(line)
        if coded is not None:
            line = f"{coded.group('prefix')}{coded.group('name')}{line[coded.end():]}"
        lines.append(line)
    text = "\n".join(lines)
    return text + "\n" if report_text.endswith("\n") else text


def _hard_failures(jobs: list[FullCIJobOutcome]) -> set[str]:
    return {job.name for job in jobs if job.state == "failed" and not job.soft_failed}


def _complete_enough(jobs: list[FullCIJobOutcome]) -> bool:
    """The preserved 95% NVIDIA-job completeness gate from the legacy
    pre-script. Under-threshold builds stay pending and are picked up by the
    next scheduled tick; this is not a new readiness polling loop."""
    if not jobs:
        return False
    finished = sum(1 for job in jobs if job.state in ("passed", "failed"))
    return finished / len(jobs) >= COMPLETENESS_THRESHOLD


def _pacific_timestamp(value: datetime) -> str:
    return value.astimezone(PACIFIC).strftime("%b %d, %I:%M %p PT")


def _duration_text(build: Mapping[str, Any], now: datetime) -> str:
    started_raw = build.get("started_at")
    if not started_raw:
        return "unknown"
    started = datetime.fromisoformat(str(started_raw).replace("Z", "+00:00"))
    finished_raw = build.get("finished_at")
    suffix = ""
    if finished_raw:
        finished = datetime.fromisoformat(str(finished_raw).replace("Z", "+00:00"))
    else:
        finished = now
        suffix = " (in progress)"
    seconds = max(0, int((finished - started).total_seconds()))
    return f"{seconds // 3600}h {(seconds % 3600) // 60}m{suffix}"


def _build_summary(
    *,
    build: Mapping[str, Any],
    jobs: list[FullCIJobOutcome],
    cache: FailureCache,
    pr: PullRequestRef | None,
    now: datetime,
) -> dict[str, Any]:
    """The `.logs/nightly_summary.json` projection the skill expects."""
    scheduled_raw = build.get("scheduled_at")
    return {
        "number": build.get("number"),
        "state": build.get("state"),
        "web_url": build.get("web_url"),
        "commit": build.get("commit"),
        "message": build.get("message"),
        "triggered_pt": (
            _pacific_timestamp(
                datetime.fromisoformat(str(scheduled_raw).replace("Z", "+00:00"))
            )
            if scheduled_raw
            else "unknown"
        ),
        "duration": _duration_text(build, now),
        "pr_url": pr.url if pr is not None else None,
        "pr_title": pr.title if pr is not None else None,
        "pr_number": pr.number if pr is not None else None,
        "jobs": [
            {"name": job.name, "state": job.state, "soft_failed": job.soft_failed}
            for job in jobs
        ],
        "skip_report": False,
        "previous_failures": {
            "build_number": cache.build_number,
            "commit": cache.commit,
            "failed_tests": list(cache.failed_tests),
        },
    }


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))


def _materialize_workdir(
    workdir: Path,
    *,
    build: Mapping[str, Any],
    summary: Mapping[str, Any],
    cache: FailureCache,
    memory_files: Mapping[str, bytes],
) -> None:
    """Project durable state into the files the unchanged skill expects."""
    _write_json(workdir / FULL_BUILD_FILE, build)
    _write_json(workdir / SUMMARY_FILE, summary)
    agent = workdir / ANALYZER_AGENT_FILE
    agent.parent.mkdir(parents=True, exist_ok=True)
    agent.write_bytes(
        importlib.resources.files("alerting")
        .joinpath("assets/vllm-ci-failure-analyzer.md")
        .read_bytes()
    )
    _write_json(
        workdir / CACHE_FILE,
        {
            "build_number": cache.build_number,
            "commit": cache.commit,
            "failed_tests": list(cache.failed_tests),
        },
    )
    for name, content in memory_files.items():
        target = workdir / MEMORY_DIR / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


@dataclass(frozen=True)
class _AnalyzerOutputs:
    report_text: str
    cache: FailureCache
    suspicious_prs: tuple[SuspiciousPR, ...]
    attributions: Mapping[str, ReportAttribution]


def _read_json_file(path: Path, description: str) -> Any:
    if not path.is_file():
        raise AnalyzerError(f"analyzer wrote no {description}")
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise AnalyzerError(
            f"analyzer wrote an unreadable {description}: {exc}"
        ) from exc


def _read_outputs(
    workdir: Path,
    *,
    expected_failures: set[str],
    build_number: int,
    commit_sha: str,
) -> _AnalyzerOutputs:
    report_path = workdir / REPORT_FILE
    if not report_path.is_file():
        raise AnalyzerError("analyzer wrote no report")
    report_text = report_path.read_text()
    if not report_text.strip():
        raise AnalyzerError("analyzer wrote an empty report")
    if report_text.strip() == "SKIP":
        raise AnalyzerError("analyzer skipped a comparison the adapter deemed ready")
    report_text = _plain_bullet_names(report_text)
    if len(report_text) > REPORT_CHAR_LIMIT:
        raise AnalyzerError(
            f"report exceeds {REPORT_CHAR_LIMIT} characters: {len(report_text)}"
        )

    raw_cache = _read_json_file(workdir / CACHE_FILE, "failure cache")
    if not isinstance(raw_cache, dict):
        raise AnalyzerError("failure cache is not an object")
    raw_tests = raw_cache.get("failed_tests")
    if not isinstance(raw_tests, list):
        raise AnalyzerError("failure cache has no failed_tests list")
    failed_tests = tuple(sorted({str(name) for name in raw_tests}))
    if set(failed_tests) != expected_failures:
        raise AnalyzerError(
            "failure cache does not match the durable failure baseline: "
            f"cache={sorted(failed_tests)} expected={sorted(expected_failures)}"
        )
    if raw_cache.get("build_number") != build_number:
        raise AnalyzerError("failure cache names the wrong build")
    cache = FailureCache(
        build_number=build_number,
        commit=commit_sha,
        failed_tests=failed_tests,
    )

    raw_suspicious = _read_json_file(workdir / SUSPICIOUS_PRS_FILE, "suspicious PRs")
    suspicious_prs = _parse_suspicious_prs(raw_suspicious)
    return _AnalyzerOutputs(
        report_text=report_text,
        cache=cache,
        suspicious_prs=suspicious_prs,
        attributions=parse_report_attributions(report_text),
    )


def _parse_suspicious_prs(raw: Any) -> tuple[SuspiciousPR, ...]:
    if not isinstance(raw, dict) or not isinstance(raw.get("suspicious_prs"), list):
        raise AnalyzerError("suspicious PRs file has no suspicious_prs list")
    parsed: list[SuspiciousPR] = []
    for entry in raw["suspicious_prs"]:
        try:
            parsed.append(
                SuspiciousPR(
                    pr_number=int(entry["pr_number"]),
                    pr_url=str(entry["pr_url"]),
                    pr_title=str(entry["pr_title"]),
                    failure_count=int(entry["failure_count"]),
                    failed_tests=tuple(str(name) for name in entry["failed_tests"]),
                    summary=str(entry["summary"]),
                )
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise AnalyzerError(f"invalid suspicious PR entry: {exc}") from exc
    return tuple(parsed)


def _read_memory(workdir: Path) -> dict[str, bytes]:
    memory_root = workdir / MEMORY_DIR
    files: dict[str, bytes] = {}
    if not memory_root.is_dir():
        return files
    for path in sorted(memory_root.rglob("*")):
        if path.is_file():
            files[str(path.relative_to(memory_root))] = path.read_bytes()
    return files


class FullCIAnalysisHandler:
    """Analyze every pending comparison, oldest first, one commit each."""

    def __init__(
        self,
        *,
        store: AnalyzerStore,
        builds: FullCIBuildPort,
        runner: AnalyzerRunner,
        checkpoints: CheckpointStore,
        github: GitHubPort,
        clock: Clock,
        delivery_mode: DeliveryMode = DeliveryMode.LIVE,
    ) -> None:
        self._store = store
        self._builds = builds
        self._runner = runner
        self._checkpoints = checkpoints
        self._github = github
        self._clock = clock
        self._delivery_mode = delivery_mode

    def __call__(self, command: ScheduledCommand) -> None:
        # Each comparison commits independently, so a crash or failure leaves
        # completed analyses durable and the rest pending for the next tick.
        # The runtime completes this command's execution after the handler
        # returns; a crash before that is recovered by idempotent replay.
        for context in self._store.pending_comparisons():
            if not self._analyze(context):
                break

    def _analyze(self, context: ComparisonContext) -> bool:
        build = self._builds.get_build(context.current.build_number)
        raw_jobs = build.get("jobs")
        if not isinstance(raw_jobs, list):
            raise AnalyzerError("Buildkite build JSON has no jobs list")
        jobs = [
            FullCIJobOutcome(
                name=str(job["name"]),
                state=str(job.get("state") or ""),
                soft_failed=bool(job.get("soft_failed")),
            )
            for job in cast(list[dict[str, Any]], raw_jobs)
            if job.get("name") is not None
            and NON_NVIDIA_JOB.search(str(job["name"])) is None
        ]
        if not _complete_enough(jobs):
            return False  # newer comparisons cannot overtake this baseline

        cache = self._store.failure_cache_before(context.current.scheduled_at)
        passed = {job.name for job in jobs if job.state == "passed"}
        expected_failures = _hard_failures(jobs) | (
            set(cache.failed_tests) - passed
        )
        checkpoint = self._store.latest_checkpoint()
        if checkpoint is None:
            # First-ever analysis has no durable memory yet; it starts empty
            # and its own commit uploads the initial checkpoint.
            memory_files: dict[str, bytes] = {}
        else:
            try:
                blob = self._checkpoints.download(checkpoint.s3_uri)
            except CheckpointUnavailable:
                # A stack recreation swaps the bucket and strands stored URIs.
                # Restart from empty memory rather than wedging the analyzer;
                # this run's commit uploads the new bucket's first checkpoint.
                memory_files = {}
            else:
                if hashlib.sha256(blob).hexdigest() != checkpoint.sha256:
                    raise AnalyzerError(
                        f"checkpoint checksum mismatch for {checkpoint.s3_uri}"
                    )
                memory_files = unpack_checkpoint(blob)

        commit_sha = str(build.get("commit") or context.current.commit_sha)
        with tempfile.TemporaryDirectory(prefix="full-ci-analysis-") as tmp:
            workdir = Path(tmp)
            commit_pull_request = self._github.pull_for_commit(commit_sha)
            summary = _build_summary(
                build=build,
                jobs=jobs,
                cache=cache,
                pr=commit_pull_request,
                now=self._clock.now(),
            )
            _materialize_workdir(
                workdir,
                build=build,
                summary=summary,
                cache=cache,
                memory_files=memory_files,
            )
            self._runner.run(workdir)
            outputs = _read_outputs(
                workdir,
                expected_failures=expected_failures,
                build_number=context.current.build_number,
                commit_sha=commit_sha,
            )
            conditions = self._classify(context, jobs, cache, outputs)
            checkpoint = self._checkpoints.upload(_read_memory(workdir))
            self._store.commit_analysis(
                analysis=CompletedAnalysis(
                    current_build_id=context.current.build_id,
                    previous_build_id=context.previous_build_id,
                    report_text=outputs.report_text,
                    failure_cache=outputs.cache,
                    suspicious_prs=outputs.suspicious_prs,
                    conditions=conditions,
                    checkpoint=checkpoint,
                    commit_pull_request=commit_pull_request,
                ),
                notification=NotificationIntent(
                    delivery_id=f"full-ci:{context.current.build_id}",
                    alert_ref=f"full-ci-comparison:{context.current.build_id}",
                    alert_path=AlertPath.FULL_CI,
                    delivery_mode=self._delivery_mode,
                    destination_mode=DestinationMode.BOT_TOKEN,
                    destination=slack_channel(),
                    payload={"text": outputs.report_text},
                ),
                now=self._clock.now(),
            )
        return True

    def _classify(
        self,
        context: ComparisonContext,
        jobs: list[FullCIJobOutcome],
        cache: FailureCache,
        outputs: _AnalyzerOutputs,
    ) -> tuple[FailureCondition, ...]:
        hard = _hard_failures(jobs)
        previous = set(cache.failed_tests)
        before = context.current.scheduled_at

        conditions: list[FailureCondition] = []
        suspicious_by_test: dict[str, SuspiciousPR] = {}
        for pr in outputs.suspicious_prs:
            for name in pr.failed_tests:
                suspicious_by_test.setdefault(name, pr)

        for name in sorted(hard - previous):
            conditions.append(
                self._new_condition(name, suspicious_by_test.get(name), outputs)
            )
        for name in sorted(hard & previous):
            prior = self._store.prior_condition(name, before=before)
            conditions.append(
                FailureCondition(
                    job_name=name,
                    lifecycle=FailureLifecycle.RECURRING,
                    cause=prior.cause if prior is not None else CauseCategory.UNKNOWN,
                    summary=prior.summary if prior is not None else "",
                    culprit_pr=prior.culprit_pr if prior is not None else None,
                )
            )
        passed = {job.name for job in jobs if job.state == "passed"}
        for name in sorted((previous - hard) & passed):
            prior = self._store.prior_condition(name, before=before)
            conditions.append(self._passed_condition(name, prior))
        return tuple(conditions)

    @staticmethod
    def _new_condition(
        name: str,
        suspicious: SuspiciousPR | None,
        outputs: _AnalyzerOutputs,
    ) -> FailureCondition:
        if suspicious is not None:
            return FailureCondition(
                job_name=name,
                lifecycle=FailureLifecycle.NEW,
                cause=CauseCategory.CODE,
                summary=suspicious.summary,
                culprit_pr=PullRequestRef(
                    number=suspicious.pr_number,
                    url=suspicious.pr_url,
                    title=suspicious.pr_title,
                ),
            )
        attribution = outputs.attributions.get(name)
        if attribution is None:
            return FailureCondition(
                job_name=name,
                lifecycle=FailureLifecycle.NEW,
                cause=CauseCategory.UNKNOWN,
                summary="",
            )
        culprit = None
        if (
            attribution.cause is CauseCategory.CODE
            and attribution.pr_number is not None
        ):
            culprit = PullRequestRef(
                number=attribution.pr_number,
                url=f"https://github.com/vllm-project/vllm/pull/{attribution.pr_number}",
                title="",
            )
        return FailureCondition(
            job_name=name,
            lifecycle=FailureLifecycle.NEW,
            cause=attribution.cause,
            summary=attribution.summary,
            culprit_pr=culprit,
        )

    def _passed_condition(
        self, name: str, prior: FailureCondition | None
    ) -> FailureCondition:
        if prior is not None and prior.culprit_pr is not None:
            revert = self._github.find_merged_revert(prior.culprit_pr.number)
            if revert is not None:
                return FailureCondition(
                    job_name=name,
                    lifecycle=FailureLifecycle.FIXED,
                    cause=CauseCategory.CODE,
                    summary=f"verified merged fixing PR #{revert.number}",
                    culprit_pr=prior.culprit_pr,
                    fixing_pr=revert,
                )
        if prior is not None and prior.cause is CauseCategory.INFRASTRUCTURE:
            return FailureCondition(
                job_name=name,
                lifecycle=FailureLifecycle.FIXED,
                cause=CauseCategory.INFRASTRUCTURE,
                summary="environmental recovery; no verified fixing PR",
                culprit_pr=prior.culprit_pr,
            )
        if prior is not None and prior.cause is CauseCategory.FLAKY_TEST:
            return FailureCondition(
                job_name=name,
                lifecycle=FailureLifecycle.FIXED,
                cause=CauseCategory.FLAKY_TEST,
                summary="flaky recovery; no verified fixing PR",
                culprit_pr=prior.culprit_pr,
            )
        return FailureCondition(
            job_name=name,
            lifecycle=FailureLifecycle.FIXED,
            cause=CauseCategory.UNKNOWN,
            summary="passed without a verified cause",
            culprit_pr=prior.culprit_pr if prior is not None else None,
        )


class GitHubRestClient:
    """Read-only GitHub REST client for commit PRs and merged reverts."""

    _API = "https://api.github.com"

    def __init__(self, *, token: str, repo: str = "vllm-project/vllm") -> None:
        self._token = token
        self._repo = repo

    def _get_json(self, url: str) -> Any:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "api.github.com":
            raise RuntimeError("GitHub query returned an untrusted URL")
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "vllm-ci-alerting/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"GET {parsed.path} failed with HTTP {exc.code}: {body[:1000]}"
            ) from exc

    def pull_for_commit(self, commit_sha: str) -> PullRequestRef | None:
        payload = self._get_json(
            f"{self._API}/repos/{self._repo}/commits/{commit_sha}/pulls"
        )
        if not isinstance(payload, list) or not payload:
            return None
        first = cast(dict[str, Any], payload[0])
        return PullRequestRef(
            number=int(first["number"]),
            url=str(first["html_url"]),
            title=str(first.get("title") or ""),
        )

    def find_merged_revert(self, pr_number: int) -> PullRequestRef | None:
        query = urllib.parse.urlencode(
            {"q": f"repo:{self._repo} is:pr is:merged in:title Revert {pr_number}"}
        )
        payload = self._get_json(f"{self._API}/search/issues?{query}")
        if not isinstance(payload, dict):
            return None
        items = payload.get("items")
        if not isinstance(items, list):
            return None
        for item in cast(list[dict[str, Any]], items):
            title = str(item.get("title") or "")
            # Phase E titles reverts as: Revert "TITLE" (#ORIGINAL_NUMBER)
            if title.rstrip().endswith(f"(#{pr_number})"):
                return PullRequestRef(
                    number=int(item["number"]),
                    url=str(item["html_url"]),
                    title=title,
                )
        return None


class S3CheckpointStore:
    """Immutable versioned checkpoint objects; boto3 imported lazily."""

    def __init__(self, *, bucket: str, prefix: str = "analyzer-checkpoints/") -> None:
        self._bucket = bucket
        self._prefix = prefix

    def _client(self) -> Any:
        import boto3  # type: ignore[import-untyped]  # optional, production-only

        return boto3.client("s3")

    def upload(self, files: Mapping[str, bytes]) -> CheckpointRef:
        blob = pack_checkpoint(files)
        digest = hashlib.sha256(blob).hexdigest()
        key = f"{self._prefix}{digest}.tar.gz"
        self._client().put_object(Bucket=self._bucket, Key=key, Body=blob)
        return CheckpointRef(
            s3_uri=f"s3://{self._bucket}/{key}",
            sha256=digest,
            schema_version=CHECKPOINT_SCHEMA_VERSION,
        )

    def download(self, s3_uri: str) -> bytes:
        parsed = urllib.parse.urlsplit(s3_uri)
        if parsed.scheme != "s3" or parsed.netloc != self._bucket:
            raise CheckpointUnavailable(
                f"checkpoint URI is outside the configured bucket: {s3_uri}"
            )
        try:
            response = self._client().get_object(
                Bucket=self._bucket, Key=parsed.path.lstrip("/")
            )
        except Exception as exc:
            code = getattr(exc, "response", {}).get("Error", {}).get("Code")
            if code in {"NoSuchKey", "NoSuchBucket", "404", "AccessDenied"}:
                raise CheckpointUnavailable(
                    f"checkpoint cannot be read: {s3_uri} ({code})"
                ) from exc
            raise
        return cast(bytes, response["Body"].read())
