"""Fast CI scan command handler and durable record model."""

from __future__ import annotations

import hashlib
import html
import os
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any, Protocol

from alerting.commands import ScheduledCommand
from alerting.ports import (
    AlertPath,
    Clock,
    DeliveryMode,
    DestinationMode,
    NotificationIntent,
)
from alerting.runtime import HandlerCompletion

INITIAL_LOOKBACK = timedelta(minutes=30)
SAFETY_OVERLAP = timedelta(minutes=15)
MAX_DURATION_SECONDS = 30
SLACK_BATCH_SIZE = 8
# Both alert paths deliver through the Slack bot token. The channel comes from
# SLACK_CHANNEL_ID so a channel move is a secret edit, not a code change.
ALERTS_SLACK_CHANNEL = "C0ABTNM9L5U"
STALE_NOTIFICATION_AGE = timedelta(minutes=30)


def slack_channel() -> str:
    """The channel alert intents post to; SLACK_CHANNEL_ID wins when set."""
    return os.environ.get("SLACK_CHANNEL_ID", ALERTS_SLACK_CHANNEL)


class FastFailureState(StrEnum):
    FAILED = "failed"
    FAILING = "failing"
    BROKEN = "broken"
    TIMED_OUT = "timed_out"


@dataclass(frozen=True)
class FastFailureEvent:
    """One Buildkite job observed failing within the Fast CI threshold."""

    job_id: str
    job_name: str
    job_url: str
    state: FastFailureState
    soft_failed: bool
    duration_seconds: int
    finished_at: datetime
    build_url: str
    message: str
    commit_sha: str
    branch: str
    author: str
    pr_number: str | None
    pipeline: str


@dataclass(frozen=True)
class FastCINotificationBatch:
    message: NotificationIntent
    job_ids: tuple[str, ...]


BatchFactory = Callable[[list[FastFailureEvent]], list[FastCINotificationBatch]]


def ordered_unique_events(
    observations: list[FastFailureEvent],
) -> list[FastFailureEvent]:
    seen: set[str] = set()
    events: list[FastFailureEvent] = []
    for event in sorted(observations, key=lambda item: item.finished_at):
        if event.job_id in seen:
            continue
        seen.add(event.job_id)
        events.append(event)
    return events


class FastCISource(Protocol):
    def fetch_failures(
        self, *, start_time: datetime, end_time: datetime
    ) -> list[FastFailureEvent]: ...


class DatabricksQueryPort(Protocol):
    def query(self, sql: str) -> list[dict[str, Any]]: ...


class DatabricksStatementClient:
    """Minimal Databricks SQL Statements API client for Fast CI scans."""

    def __init__(self, *, host: str, token: str, warehouse_id: str) -> None:
        self._host = host.rstrip("/")
        self._token = token
        self._warehouse_id = warehouse_id

    def _request_json(
        self,
        method: str,
        url: str,
        *,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "User-Agent": "vllm-fast-ci-failure-alert/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                result: dict[str, Any] = json.load(response)
                return result
        except urllib.error.HTTPError as exc:
            response_body = exc.read().decode("utf-8", errors="replace")
            path = urllib.parse.urlsplit(url).path
            raise RuntimeError(
                f"{method} {path} failed with HTTP {exc.code}: {response_body[:1000]}"
            ) from exc

    def query(self, sql: str) -> list[dict[str, Any]]:
        response = self._request_json(
            "POST",
            f"{self._host}/api/2.0/sql/statements",
            payload={
                "warehouse_id": self._warehouse_id,
                "statement": sql,
                "wait_timeout": "50s",
                "disposition": "INLINE",
                "format": "JSON_ARRAY",
            },
        )
        statement_id = response.get("statement_id")
        deadline = time.monotonic() + 110
        while response.get("status", {}).get("state") in {"PENDING", "RUNNING"}:
            if not statement_id or time.monotonic() >= deadline:
                raise RuntimeError(
                    "Databricks query did not complete within 110 seconds"
                )
            time.sleep(2)
            response = self._request_json(
                "GET", f"{self._host}/api/2.0/sql/statements/{statement_id}"
            )
        status = response.get("status", {})
        if status.get("state") != "SUCCEEDED":
            error = status.get("error", {})
            detail = error.get("message", status.get("state", "unknown"))
            raise RuntimeError(f"Databricks query failed: {detail}")
        columns = [
            column["name"]
            for column in response.get("manifest", {})
            .get("schema", {})
            .get("columns", [])
        ]
        data_rows = response.get("result", {}).get("data_array", [])
        return [dict(zip(columns, row, strict=False)) for row in data_rows]


class FastCIStore(Protocol):
    def scan_cursor(self) -> datetime | None: ...

    def commit_scan(
        self,
        *,
        command: ScheduledCommand,
        observations: list[FastFailureEvent],
        scanned_through: datetime,
        now: datetime,
        batch_factory: BatchFactory,
    ) -> None:
        """Atomically insert unseen events and batches, advance the cursor,
        and complete the command execution. A failure commits none of them.
        """
        ...


def _sql_timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("scan bounds must be timezone-aware")
    return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f+00:00")


def _alert_query(start_time: datetime, end_time: datetime) -> str:
    states = ", ".join(f"'{state.value}'" for state in FastFailureState)
    return f"""
      SELECT
        j.id AS job_id,
        j.name AS job_name,
        j.web_url AS job_url,
        j.state,
        j.soft_failed,
        TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at) AS duration_secs,
        j.finished_at,
        b.web_url AS build_url,
        b.message,
        b.commit AS commit_sha,
        b.branch,
        b.github_author_username AS author,
        b.pr_number,
        p.name AS pipeline
      FROM vllm_data_warehouse.buildkite.build_job AS j
      INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
      INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
      WHERE j._fivetran_deleted = false
        AND b._fivetran_deleted = false
        AND j.type = 'script'
        AND j.name IS NOT NULL
        AND p.name = 'CI'
        AND b.branch = 'main'
        AND j.soft_failed = false
        AND j.state IN ({states})
        AND j.started_at IS NOT NULL
        AND j.finished_at IS NOT NULL
        AND j.finished_at >= TIMESTAMP '{_sql_timestamp(start_time)}'
        AND j.finished_at <= TIMESTAMP '{_sql_timestamp(end_time)}'
        AND TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at)
          BETWEEN 0 AND {MAX_DURATION_SECONDS}
      ORDER BY j.finished_at ASC
    """


def _parse_datetime(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Databricks finished_at must be timezone-aware")
    return parsed


def _truthy(value: Any) -> bool:
    return str(value or "").lower() in {"1", "true"}


class DatabricksFastCISource:
    """Runs the preserved Fast CI SQL predicate and maps its result rows."""

    def __init__(self, databricks: DatabricksQueryPort) -> None:
        self._databricks = databricks

    def fetch_failures(
        self, *, start_time: datetime, end_time: datetime
    ) -> list[FastFailureEvent]:
        rows = self._databricks.query(_alert_query(start_time, end_time))
        return [
            FastFailureEvent(
                job_id=str(row["job_id"]),
                job_name=str(row["job_name"]),
                job_url=str(row.get("job_url") or ""),
                state=FastFailureState(str(row["state"])),
                soft_failed=_truthy(row.get("soft_failed")),
                duration_seconds=int(row["duration_secs"]),
                finished_at=_parse_datetime(row["finished_at"]),
                build_url=str(row.get("build_url") or ""),
                message=str(row.get("message") or ""),
                commit_sha=str(row.get("commit_sha") or ""),
                branch=str(row.get("branch") or ""),
                author=str(row.get("author") or ""),
                pr_number=(
                    str(row["pr_number"])
                    if row.get("pr_number") not in (None, "")
                    else None
                ),
                pipeline=str(row.get("pipeline") or "CI"),
            )
            for row in rows
        ]


def _slack_escape(value: Any) -> str:
    return html.escape(str(value or ""), quote=False)


def _slack_code(value: Any) -> str:
    escaped = _slack_escape(value).replace("`", "'")
    return f"`{escaped}`"


def _safe_https_url(value: Any) -> str | None:
    text = str(value or "")
    parsed = urllib.parse.urlsplit(text)
    return text if parsed.scheme == "https" and parsed.netloc else None


def _slack_label(value: Any) -> str:
    return _slack_escape(value).replace("|", "¦").replace("`", "'")


def _slack_link(url: Any, label: Any) -> str:
    safe_url = _safe_https_url(url)
    safe_label = _slack_label(label)
    return f"<{safe_url}|{safe_label}>" if safe_url else safe_label


def _one_line(value: Any, limit: int = 120) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _build_number(build_url: str) -> str:
    match = re.search(r"/builds/(\d+)", build_url)
    return match.group(1) if match else "?"


_LEADING_JOB_EMOJI = re.compile(r"^((?::[a-z0-9_+-]+:\s*)+)", re.IGNORECASE)


def _split_job_emoji(name: str) -> tuple[str, str]:
    """Custom emoji shortcodes are not reliably rendered inside Slack link
    labels; keep a leading job emoji (":nvidia:") outside the linked name."""
    match = _LEADING_JOB_EMOJI.match(name)
    if match is None:
        return "", name
    return match.group(1).strip(), name[match.end() :].strip()


def _build_message(
    events: list[FastFailureEvent],
    batch_number: int,
    batch_count: int,
    *,
    recovery: bool = False,
) -> str:
    if recovery:
        heading = (
            f":rotating_light: *Fast CI recovery summary* — {len(events)} "
            f"job{'s' if len(events) != 1 else ''} failed in "
            f"{MAX_DURATION_SECONDS}s or less (main branch, required jobs only) "
            "while notifications were unavailable"
        )
    else:
        suffix = f" — batch {batch_number}/{batch_count}" if batch_count > 1 else ""
        heading = (
            f":rotating_light: *Fast CI job failure alert* — {len(events)} "
            f"job{'s' if len(events) != 1 else ''} failed in "
            f"{MAX_DURATION_SECONDS}s or less (main branch, required jobs only){suffix}"
        )
    lines = [
        heading,
        "",
    ]
    for event in events:
        details = [
            _slack_code(f"{event.duration_seconds}s"),
            _slack_link(
                event.build_url,
                f"{event.pipeline or 'CI'} #{_build_number(event.build_url)}",
            ),
            f"branch {_slack_code(event.branch or '?')}",
        ]
        if event.commit_sha:
            details.append(f"commit {_slack_code(event.commit_sha[:8])}")
        if event.pr_number:
            details.append(f"PR #{_slack_escape(event.pr_number)}")
        if event.author:
            details.append(f"by {_slack_escape(event.author)}")
        if event.soft_failed:
            details.append("_soft fail_")
        job_emoji, job_name = _split_job_emoji(event.job_name or "Unknown job")
        job = _slack_link(event.job_url, job_name)
        if job_emoji:
            job = f"{job_emoji} {job}"
        lines.append(f":red_circle: {job} — {' · '.join(details)}")
        if event.message:
            lines.append(f"> {_slack_escape(_one_line(event.message))}")
    return "\n".join(lines)


def _notification_batches(
    events: list[FastFailureEvent],
    *,
    delivery_mode: DeliveryMode = DeliveryMode.LIVE,
) -> list[FastCINotificationBatch]:
    groups = [
        events[index : index + SLACK_BATCH_SIZE]
        for index in range(0, len(events), SLACK_BATCH_SIZE)
    ]
    batches: list[FastCINotificationBatch] = []
    for index, group in enumerate(groups, start=1):
        job_ids = tuple(event.job_id for event in group)
        digest = hashlib.sha256("\0".join(job_ids).encode()).hexdigest()
        delivery_id = f"fast-ci:{digest}"
        batches.append(
            FastCINotificationBatch(
                message=NotificationIntent(
                    delivery_id=delivery_id,
                    alert_ref=delivery_id,
                    alert_path=AlertPath.FAST_CI,
                    delivery_mode=delivery_mode,
                    destination_mode=DestinationMode.BOT_TOKEN,
                    destination=slack_channel(),
                    payload={"text": _build_message(group, index, len(groups))},
                ),
                job_ids=job_ids,
            )
        )
    return batches


def recovery_notification(
    events: list[FastFailureEvent], stale_delivery_ids: list[str]
) -> FastCINotificationBatch:
    ordered_events = ordered_unique_events(events)
    digest = hashlib.sha256("\0".join(sorted(stale_delivery_ids)).encode()).hexdigest()
    delivery_id = f"fast-ci-recovery:{digest}"
    return FastCINotificationBatch(
        message=NotificationIntent(
            delivery_id=delivery_id,
            alert_ref=delivery_id,
            alert_path=AlertPath.FAST_CI,
            delivery_mode=DeliveryMode.LIVE,
            destination_mode=DestinationMode.BOT_TOKEN,
            destination=slack_channel(),
            payload={"text": _build_message(ordered_events, 1, 1, recovery=True)},
        ),
        job_ids=tuple(event.job_id for event in ordered_events),
    )


class FastCIScanHandler:
    """Query one cursor window and atomically persist its durable effects."""

    def __init__(
        self,
        *,
        source: FastCISource,
        store: FastCIStore,
        clock: Clock,
        delivery_mode: DeliveryMode = DeliveryMode.LIVE,
    ) -> None:
        self._source = source
        self._store = store
        self._clock = clock
        self._delivery_mode = delivery_mode

    def __call__(self, command: ScheduledCommand) -> HandlerCompletion:
        cursor = self._store.scan_cursor()
        if cursor is None:
            start_time = command.target_time - INITIAL_LOOKBACK
        elif command.target_time >= cursor:
            start_time = cursor - SAFETY_OVERLAP
        else:
            start_time = command.target_time - SAFETY_OVERLAP
        observations = self._source.fetch_failures(
            start_time=start_time,
            end_time=command.target_time,
        )
        self._store.commit_scan(
            command=command,
            observations=observations,
            scanned_through=command.target_time,
            now=self._clock.now(),
            batch_factory=lambda events: _notification_batches(
                events,
                delivery_mode=self._delivery_mode,
            ),
        )
        return HandlerCompletion.TRANSACTIONAL
