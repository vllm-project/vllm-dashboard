"""Read-only shadow export and rollback fencing for operators."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from typing import Any

from alerting.ports import AlertPath, NotificationIntentRecord
from alerting.postgres import PostgresAlertStore

_SLACK_DELIVERY_PATHS = (AlertPath.FAST_CI, AlertPath.FULL_CI)


def _database_url() -> str:
    value = os.environ.get("DATABASE_URL")
    if not value:
        raise RuntimeError("DATABASE_URL is required")
    return value


def _payload(record: NotificationIntentRecord) -> dict[str, Any]:
    return {
        "delivery_id": record.delivery_id,
        "alert_ref": record.alert_ref,
        "alert_path": record.alert_path.value,
        "delivery_mode": record.delivery_mode.value,
        "status": record.status.value,
        "created_at": record.created_at.isoformat() if record.created_at else None,
        "payload": record.payload,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Inspect shadow output or fence pending delivery during rollback"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export-shadow")
    export.add_argument(
        "--path",
        choices=[path.value for path in _SLACK_DELIVERY_PATHS],
        required=True,
    )
    export.add_argument("--limit", type=int, default=10)
    archive = commands.add_parser("archive-pending")
    archive.add_argument(
        "--path",
        choices=[path.value for path in _SLACK_DELIVERY_PATHS],
        required=True,
    )
    archive.add_argument("--confirm-path", required=True)
    return parser


def main(arguments: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(arguments)
    alert_path = AlertPath(args.path)
    if args.command == "archive-pending" and args.confirm_path != alert_path.value:
        print("confirmation does not match selected alert path", file=sys.stderr)
        return 2

    store = PostgresAlertStore.from_database_url(_database_url())
    if args.command == "export-shadow":
        if args.limit < 1:
            print("--limit must be positive", file=sys.stderr)
            return 2
        rows = store.shadow_outputs(alert_path=alert_path, limit=args.limit)
        print(json.dumps([_payload(row) for row in rows], indent=2, sort_keys=True))
        return 0

    archived = store.archive_pending_live(alert_path=alert_path)
    print(f"archived {archived} pending live records for {alert_path.value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
