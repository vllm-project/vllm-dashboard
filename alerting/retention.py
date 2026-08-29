"""Prune alerting rows past their retention window.

Fast failure events are an operational feed, not an archive: the dashboard
reads a seven-day window, so a daily systemd timer on the worker host deletes
older rows. Notification rows cascade on the event delete.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

RETENTION = timedelta(days=7)


def prune_fast_failure_events(
    connection: Any,
    *,
    now: datetime,
    retention: timedelta = RETENTION,
) -> int:
    """Delete fast failure events older than the retention window."""
    cutoff = now.astimezone(timezone.utc) - retention
    with connection.transaction():
        cursor = connection.execute(
            "DELETE FROM alerting_fast_failure_events WHERE finished_at < %s",
            (cutoff,),
        )
        return int(cursor.rowcount)


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("required environment variable is missing: DATABASE_URL")

    import psycopg

    with psycopg.connect(database_url) as connection:
        pruned = prune_fast_failure_events(
            connection, now=datetime.now(timezone.utc)
        )
    print(f"pruned {pruned} fast failure events past {RETENTION.days} days")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
