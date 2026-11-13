"""Publish the shard timings snapshot that CI builds plan from.

The pipeline generator used to call /api/timings/latest once per enrolled
step while a build bootstraps, so a slow or failing dashboard database left
steps unsharded. This hourly job calls the endpoint instead, one step at a
time and off the build's path, and publishes every answer as one S3 object
the generator downloads once per build.

What is stored is the endpoint's own JSON, so its rules (p80, treatment
branch, fallbacks) stay in one place. A key whose fetch fails keeps its last
good entry; a run where every fetch fails publishes nothing. The snapshot is
uploaded first and `latest.json` moved second, so a reader never finds a
half-written one.
"""

from __future__ import annotations

import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from datetime import datetime, timedelta, timezone
from typing import Any

TIMINGS_URL = "https://ci.vllm.ai/api/timings/latest"
# The generator's own testsOverMs: (MAX_SHARD_SECONDS - MAX_SETUP_SECONDS) *
# 1000 in ci-infra runtime_shard.py. The generator ignores a snapshot made
# with another value.
TESTS_OVER_MS = 960_000
BUCKET = "vllm-ci-timings"
PREFIX = "ci/timings"
POINTER = f"{PREFIX}/latest.json"
# Each run lists every pair main ran in this window, the endpoint's own
# default, and also keeps every key the last snapshot had.
LOOKBACK_DAYS = 14
# A step's queues come from its newest job spans: enough to see a step that
# runs on two queues at once, and to drop the queue it left.
NEWEST_JOBS_PER_STEP = 20
FETCH_TIMEOUT_SECONDS = 120
# Fetching stops here and what was fetched is published; the rest keep their
# entries and go first next run. Below the unit's TimeoutStartSec (50 min)
# with one fetch timeout and the publish to spare: a run with 23 endpoint
# timeouts took about an hour.
FETCH_BUDGET_SECONDS = 40 * 60


# A plain DISTINCT reads every job span in the window, each a heap fetch
# (agent_queue is not in the index): 14 days ran past a 30 s statement
# timeout. This skips through a branch's partial index (migrations 0029, 0035)
# one step key at a time (about 560 descents), then reads each step's newest
# job spans only: 5 s cold, under 0.1 s warm. Each subquery repeats the index
# predicate literally, as /api/timings/latest does. The treatment branch
# counts too: the endpoint serves its timings for a step main never timed.
def _pairs_sql(branch: str) -> str:
    jobs = f"""span_name = 'buildkite.job'
      AND job_type = 'script'
      AND pipeline_slug = 'ci'
      AND (span_attributes->>'buildkite.build.branch') = '{branch}'
      AND start_time >= %(since)s"""
    return f"""(
  WITH RECURSIVE steps(step_key) AS (
    (SELECT step_key FROM otel_spans
     WHERE {jobs} AND step_key IS NOT NULL
     ORDER BY step_key LIMIT 1)
    UNION ALL
    SELECT (SELECT step_key FROM otel_spans
            WHERE {jobs} AND step_key > steps.step_key
            ORDER BY step_key LIMIT 1)
    FROM steps WHERE steps.step_key IS NOT NULL
  )
  SELECT steps.step_key, newest.agent_queue
  FROM steps
  CROSS JOIN LATERAL (
    SELECT agent_queue FROM otel_spans
    WHERE {jobs} AND step_key = steps.step_key
    ORDER BY start_time DESC LIMIT %(newest)s
  ) AS newest
  WHERE newest.agent_queue IS NOT NULL
)"""


PAIRS_SQL = _pairs_sql("main") + "\nUNION\n" + _pairs_sql("khluu/otel")

Fetch = Callable[[str, str], "dict[str, Any] | None"]


def list_pairs(connection: Any, *, now: datetime, days: int) -> set[tuple[str, str]]:
    """The (step_key, agent_queue) pairs main or the treatment branch ran in
    the last `days` days."""
    params = {"since": now - timedelta(days=days), "newest": NEWEST_JOBS_PER_STEP}
    rows = connection.execute(PAIRS_SQL, params).fetchall()
    return {(step_key, queue) for step_key, queue in rows}


def fetch_from_endpoint(step_key: str, queue: str) -> dict[str, Any] | None:
    """The endpoint's answer for one pair; None for its 404 (no passing main
    build). Any other failure raises."""
    query = urllib.parse.urlencode(
        {"stepKey": step_key, "queue": queue, "testsOverMs": TESTS_OVER_MS}
    )
    try:
        with urllib.request.urlopen(
            f"{TIMINGS_URL}?{query}", timeout=FETCH_TIMEOUT_SECONDS
        ) as response:
            body: dict[str, Any] = json.load(response)
            return body
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def _non_negative(value: Any) -> bool:
    return (
        isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
    )


def valid(response: Any) -> bool:
    """Whether the planner can read every field it uses from `response`."""
    if not isinstance(response, dict) or not _non_negative(response.get("setupMs", 0)):
        return False
    files = response.get("files")
    if not isinstance(files, list) or not files:
        return False
    for timing in files:
        if not isinstance(timing, dict):
            return False
        if not isinstance(timing.get("command"), str) or not isinstance(
            timing.get("file"), str
        ):
            return False
        if not _non_negative(timing.get("observedMs")):
            return False
        for test in timing.get("tests") or []:
            if not isinstance(test, dict) or not isinstance(test.get("nodeid"), str):
                return False
            if not _non_negative(test.get("observedMs")):
                return False
    return True


def refresh(
    keys: Iterable[str],
    previous: dict[str, Any],
    fetch: Fetch,
    *,
    now: datetime,
    deadline: float = float("inf"),
    clock: Callable[[], float] = time.monotonic,
) -> tuple[dict[str, Any], list[str], list[str]]:
    """New entries for `keys` ("<step_key>|<queue>"), the keys that failed,
    and the keys left unfetched at `deadline` (a `clock` reading).

    Keys go least recently tried first, new keys before all, so a run that
    stops at the deadline refreshes the rest next time. A failed fetch keeps
    the key's entry (its `fetched_at` still says how old the data is) and
    marks it `attempted_at`, so keys that keep failing go last and can't
    starve the rest. A 404 is stored as a null response, so builds skip the
    endpoint for a step main has never passed, unless the key had timings
    before: those are kept, as for a failed fetch.
    """
    fetched_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    entries: dict[str, Any] = {}
    failed: list[str] = []
    skipped: list[str] = []

    def last_tried(key: str) -> tuple[str, str]:
        entry = previous.get(key) or {}
        return (entry.get("attempted_at") or entry.get("fetched_at") or "", key)

    for key in sorted(keys, key=last_tried):
        step_key, queue = key.split("|", 1)
        old = previous.get(key)
        if clock() >= deadline:
            skipped.append(key)
            if old is not None:
                entries[key] = old
            continue
        try:
            response = fetch(step_key, queue)
            if response is not None and not valid(response):
                raise ValueError("response the planner cannot read")
        except Exception as error:  # timeout, 5xx, 422, bad body
            print(f"{key}: {type(error).__name__}: {error}", file=sys.stderr)
            failed.append(key)
            # Without a response, builds ask the endpoint for the key.
            entries[key] = {**(old or {}), "attempted_at": fetched_at}
            continue
        if response is None and old is not None and old.get("response") is not None:
            entries[key] = old
        else:
            entries[key] = {"fetched_at": fetched_at, "response": response}
    return entries, failed, skipped


class S3Store:
    """The snapshot objects in the bucket; boto3 imported lazily."""

    def __init__(self, bucket: str = BUCKET, client: Any | None = None) -> None:
        if client is None:
            import boto3  # type: ignore[import-not-found,import-untyped,unused-ignore]

            client = boto3.client("s3")
        self.bucket = bucket
        self.client = client

    def read_entries(self) -> dict[str, Any]:
        """The last published snapshot's entries; {} only before the first.
        Any other read failure raises, so a run never drops last-good data."""
        try:
            pointer = json.loads(
                self.client.get_object(Bucket=self.bucket, Key=POINTER)["Body"].read()
            )
        except self.client.exceptions.NoSuchKey:
            return {}
        body = self.client.get_object(Bucket=self.bucket, Key=pointer["path"])[
            "Body"
        ].read()
        entries: dict[str, Any] = json.loads(gzip.decompress(body))["entries"]
        return entries

    def publish(self, snapshot: dict[str, Any]) -> str:
        """Upload the snapshot, then move the pointer to it; its key."""
        stamp = snapshot["published_at"].replace(":", "")
        key = f"{PREFIX}/{stamp}/timings.json.gz"
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=gzip.compress(json.dumps(snapshot).encode()),
        )
        pointer = {"published_at": snapshot["published_at"], "path": key}
        self.client.put_object(
            Bucket=self.bucket,
            Key=POINTER,
            Body=(json.dumps(pointer) + "\n").encode(),
        )
        return key


def run(
    *,
    pairs: set[tuple[str, str]],
    store: Any,
    fetch: Fetch,
    now: datetime,
    deadline: float = float("inf"),
    dry_run: bool = False,
) -> int:
    """One refresh: fetch, then publish unless no fetch succeeded. Exit code."""
    previous = store.read_entries()
    keys = {f"{step_key}|{queue}" for step_key, queue in pairs} | set(previous)
    entries, failed, skipped = refresh(
        keys, previous, fetch, now=now, deadline=deadline
    )
    fetched = len(keys) - len(failed) - len(skipped)
    print(
        f"{len(keys)} keys ({len(pairs)} from the spans, {len(previous)} in the "
        f"last snapshot): {fetched} fetched, {len(failed)} failed, "
        f"{len(skipped)} left for the next run"
    )
    if keys and fetched == 0:
        print(
            "no fetch succeeded; latest.json still names the last snapshot",
            file=sys.stderr,
        )
        return 1
    snapshot = {
        "published_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tests_over_ms": TESTS_OVER_MS,
        "entries": entries,
    }
    if dry_run:
        print(f"dry run: would publish {len(entries)} entries")
        return 0
    print(f"published s3://{store.bucket}/{store.publish(snapshot)}")
    return 0


def main(arguments: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--days", type=int, default=LOOKBACK_DAYS, help="lookback for main's pairs"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="fetch everything, publish nothing"
    )
    args = parser.parse_args(arguments)
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("required environment variable is missing: DATABASE_URL")

    import psycopg

    now = datetime.now(timezone.utc)
    # The transaction pooler cannot hold prepared statements.
    with psycopg.connect(database_url, prepare_threshold=None) as connection:
        pairs = list_pairs(connection, now=now, days=args.days)
    return run(
        pairs=pairs,
        store=S3Store(),
        fetch=fetch_from_endpoint,
        now=now,
        deadline=time.monotonic() + FETCH_BUDGET_SECONDS,
        dry_run=args.dry_run,
    )


def main_recording_failures() -> int:
    """main(), leaving any failure where the unit's Slack notifier reads it."""
    from alerting.worker import _record_failure

    try:
        code = main()
    except Exception as error:
        _record_failure("timings-snapshot", f"{type(error).__name__}: {error}")
        raise
    if code:
        _record_failure(
            "timings-snapshot",
            "no endpoint fetch succeeded; builds use the last snapshot",
        )
    return code


if __name__ == "__main__":
    raise SystemExit(main_recording_failures())
