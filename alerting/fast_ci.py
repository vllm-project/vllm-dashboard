"""Fast CI scan command handler and durable record model."""

from __future__ import annotations

import hashlib
import html
import os
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any, Mapping, Protocol

from alerting.commands import ScheduledCommand
from alerting.ports import (
    AlertPath,
    Clock,
    DeliveryMode,
    DestinationMode,
    NotificationIntent,
)
from alerting.runtime import HandlerCompletion
from alerting.slack import headed_payload

INITIAL_LOOKBACK = timedelta(minutes=30)
SAFETY_OVERLAP = timedelta(minutes=15)
MAX_DURATION_SECONDS = 30
SLACK_BATCH_SIZE = 8
# Fast CI and Main CI image builds post to one alert channel, told apart by
# each post's header block; infra alerts and Full CI reports have their own.
# All are overridable from secrets manager, so a channel move stays a secret
# edit: SLACK_CI_ALERT_CHANNEL, SLACK_CI_INFRA_ALERT_CHANNEL and
# SLACK_CI_NOTIFICATIONS_CHANNEL (SLACK_CHANNEL_ID is Full CI's legacy
# fallback).
ALERTS_SLACK_CHANNEL = "C0ANHBE642Y"
CI_NOTIFICATIONS_SLACK_CHANNEL = "C0ABTNM9L5U"
STALE_NOTIFICATION_AGE = timedelta(minutes=30)


def slack_channel() -> str:
    """The shared alert channel Fast CI, Main CI and infra intents post to."""
    return os.environ.get("SLACK_CI_ALERT_CHANNEL", ALERTS_SLACK_CHANNEL)


def infra_slack_channel() -> str:
    """The channel infra alerts post to: the daily summary's channel, else the alerts one."""
    return os.environ.get("SLACK_CI_INFRA_ALERT_CHANNEL") or slack_channel()


def full_ci_slack_channel() -> str:
    """The channel Full CI report intents post to."""
    return os.environ.get(
        "SLACK_CI_NOTIFICATIONS_CHANNEL",
        os.environ.get("SLACK_CHANNEL_ID", CI_NOTIFICATIONS_SLACK_CHANNEL),
    )


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


class WarehouseQueryPort(Protocol):
    """Runs one read-only SQL statement against the CI data warehouse.

    `params` binds the statement's typed `{name:Type}` placeholders; values
    are never interpolated into the SQL text.
    """

    def query(
        self, sql: str, params: Mapping[str, str] | None = None
    ) -> list[dict[str, Any]]: ...


CLICKHOUSE_MAX_EXECUTION_SECONDS = 100
CLICKHOUSE_REQUEST_TIMEOUT_SECONDS = 110


class ClickHouseQueryClient:
    """Minimal ClickHouse HTTP-interface client for Fast CI scans.

    Like the Databricks client it replaced, it makes one attempt per scan
    (the scheduled command retries a failed scan) and gives the query
    110 seconds overall; the server stops the query at 100.
    """

    def __init__(self, *, url: str, user: str, password: str) -> None:
        self._url = url.rstrip("/") + "/"
        self._user = user
        self._password = password

    def query(
        self, sql: str, params: Mapping[str, str] | None = None
    ) -> list[dict[str, Any]]:
        settings = {
            "default_format": "JSONEachRow",
            "date_time_output_format": "iso",
            "max_execution_time": str(CLICKHOUSE_MAX_EXECUTION_SECONDS),
            # Buffer the result so a query error is reported as an HTTP
            # error status instead of after a 200 has been sent.
            "wait_end_of_query": "1",
        }
        settings.update(
            {f"param_{name}": value for name, value in (params or {}).items()}
        )
        request = urllib.request.Request(
            f"{self._url}?{urllib.parse.urlencode(settings)}",
            data=sql.encode(),
            method="POST",
            headers={
                "X-ClickHouse-User": self._user,
                "X-ClickHouse-Key": self._password,
                "Content-Type": "text/plain; charset=utf-8",
                "User-Agent": "vllm-fast-ci-failure-alert/1.0",
            },
        )
        try:
            with urllib.request.urlopen(
                request, timeout=CLICKHOUSE_REQUEST_TIMEOUT_SECONDS
            ) as response:
                body = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            response_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"ClickHouse query failed with HTTP {exc.code}: {response_body[:1000]}"
            ) from exc
        return _json_each_row(body)


def _json_each_row(body: str) -> list[dict[str, Any]]:
    """Parse a JSONEachRow body, failing on an exception written mid-stream.

    A ClickHouse error raised after the 200 status was sent arrives as a
    plain-text line inside the body rather than as an HTTP error.
    """
    rows: list[dict[str, Any]] = []
    for line in body.splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            row = None
        if not isinstance(row, dict):
            raise RuntimeError(f"ClickHouse query failed mid-stream: {line[:1000]}")
        rows.append(row)
    return rows


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
    """Render a scan bound as a `DateTime64(6, 'UTC')` query parameter."""
    if value.tzinfo is None:
        raise ValueError("scan bounds must be timezone-aware")
    return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")


# Fivetran's Buildkite tables in ClickHouse are ReplacingMergeTree keyed by
# id, so every read uses FINAL and drops soft-deleted rows. Builds are
# narrowed first (CI pipeline, main branch, created by the end of the window)
# and jobs are restricted to them before the join. The duration is truncated
# whole seconds, matching Databricks' TIMESTAMPDIFF(SECOND, ...), and
# finished_at is cast to microseconds so it parses with `fromisoformat`.
_MAIN_CI_BUILDS = """
  SELECT id, pipeline_id, web_url, message, commit, branch,
    github_author_username, pr_number
  FROM buildkite.build FINAL
  WHERE NOT _fivetran_deleted
    AND branch = 'main'
    AND pipeline_id IN (SELECT id FROM buildkite.pipeline FINAL WHERE name = 'CI')
    AND (created_at IS NULL OR created_at <= {end_time:DateTime64(6, 'UTC')})
"""

_DURATION_SECONDS = (
    "intDiv(toUnixTimestamp64Micro(j.finished_at)"
    " - toUnixTimestamp64Micro(j.started_at), 1000000)"
)


def _alert_query(start_time: datetime, end_time: datetime) -> tuple[str, dict[str, str]]:
    states = ", ".join(f"'{state.value}'" for state in FastFailureState)
    sql = f"""
      SELECT
        j.id AS job_id,
        j.name AS job_name,
        j.web_url AS job_url,
        j.state AS state,
        j.soft_failed AS soft_failed,
        {_DURATION_SECONDS} AS duration_secs,
        toDateTime64(j.finished_at, 6, 'UTC') AS finished_at,
        b.web_url AS build_url,
        b.message AS message,
        b.commit AS commit_sha,
        b.branch AS branch,
        b.github_author_username AS author,
        b.pr_number AS pr_number,
        p.name AS pipeline
      FROM buildkite.build_job AS j FINAL
      INNER JOIN ({_MAIN_CI_BUILDS}) AS b ON j.build_id = b.id
      INNER JOIN (
        SELECT id, name FROM buildkite.pipeline FINAL WHERE name = 'CI'
      ) AS p ON b.pipeline_id = p.id
      WHERE NOT j._fivetran_deleted
        AND j.build_id IN (SELECT id FROM ({_MAIN_CI_BUILDS}))
        AND j.type = 'script'
        AND j.name IS NOT NULL
        AND b.branch = 'main'
        AND j.soft_failed = false
        AND j.state IN ({states})
        AND j.started_at IS NOT NULL
        AND j.finished_at IS NOT NULL
        AND j.finished_at >= {{start_time:DateTime64(6, 'UTC')}}
        AND j.finished_at <= {{end_time:DateTime64(6, 'UTC')}}
        AND {_DURATION_SECONDS} BETWEEN 0 AND {MAX_DURATION_SECONDS}
      ORDER BY j.finished_at ASC
    """
    params = {
        "start_time": _sql_timestamp(start_time),
        "end_time": _sql_timestamp(end_time),
    }
    return sql, params


def _parse_datetime(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("warehouse finished_at must be timezone-aware")
    return parsed


def _truthy(value: Any) -> bool:
    return str(value or "").lower() in {"1", "true"}


class WarehouseFastCISource:
    """Runs the preserved Fast CI predicate against the warehouse and maps rows."""

    def __init__(self, warehouse: WarehouseQueryPort) -> None:
        self._warehouse = warehouse

    def fetch_failures(
        self, *, start_time: datetime, end_time: datetime
    ) -> list[FastFailureEvent]:
        sql, params = _alert_query(start_time, end_time)
        rows = self._warehouse.query(sql, params)
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
                    payload=headed_payload(
                        _build_message(group, index, len(groups)),
                        source="FAST CI",
                        icon="⚡",
                    ),
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
            payload=headed_payload(
                _build_message(ordered_events, 1, 1, recovery=True),
                source="FAST CI",
                icon="⚡",
            ),
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
