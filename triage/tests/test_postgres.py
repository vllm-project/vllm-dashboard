"""End-to-end against a real (embedded) Postgres with every migration applied.

Skipped when `pgserver` is not installed (it ships a Postgres binary in a
wheel): `uv run --extra dev --with pgserver pytest`.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from alerting.commands import ScheduledCommand
from alerting.ports import DeliveryMode

from triage.config import default_config
from triage.extract import Budget, LLMResult, run_extraction
from triage.model import FileChange, Item
from triage.pipeline import DigestHandler, RouteHandler
from triage.prepass import compute_prepass, content_hash, in_scope, prepass_priority
from triage.store import PostgresTriageStore

pgserver = pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations" / "sql"
NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)


class FixedClock:
    def __init__(self, now: datetime) -> None:
        self.value = now

    def now(self) -> datetime:
        return self.value


@pytest.fixture(scope="module")
def database_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    server = pgserver.get_server(str(tmp_path_factory.mktemp("pg")), cleanup_mode="stop")
    url = server.get_uri()
    # Some historical migrations assume tables that pre-date the migration
    # ledger (see migrations/README.md), so a fresh database cannot replay
    # the whole chain. Apply each file on its own and require only the ones
    # triage depends on: the alerting outbox chain and 0038.
    failed: list[str] = []
    with psycopg.connect(url, autocommit=True) as c:
        for path in sorted(MIGRATIONS.glob("*.sql")):
            sql = path.read_text()
            try:
                if sql.lstrip().startswith("-- migrate: no-transaction"):
                    c.execute(sql)
                else:
                    with c.transaction():
                        c.execute(sql)
            except psycopg.Error:
                failed.append(path.name)
    needed = {"0001", "0002", "0013", "0036_selector_health", "0038"}
    assert not [f for f in failed if any(f.startswith(n) for n in needed)], failed
    yield url


@pytest.fixture()
def store(database_url: str) -> PostgresTriageStore:
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute(
            "TRUNCATE triage_actions, triage_assignments, triage_scores, triage_extractions, "
            "triage_items, triage_maintainers, triage_cursors CASCADE"
        )
        c.execute("DELETE FROM alerting_notification_outbox WHERE alert_path = 'triage'")
    return PostgresTriageStore(database_url)


def ingest(store: PostgresTriageStore, item: Item) -> None:
    config = default_config()
    prepass = compute_prepass(item, config)
    store.upsert_item(
        item, prepass=prepass, priority=prepass_priority(item, prepass),
        content_hash=content_hash(item), in_scope=in_scope(prepass["scope_reason"]),
        comments_excerpt="\n\n".join(item.comments),
    )


def issue(number: int, title: str, body: str = "x" * 200, **kw: Any) -> Item:
    return Item(
        repo="vllm-project/vllm", number=number, kind=kw.pop("kind", "issue"), title=title, body=body,
        author="user", author_association=kw.pop("author_association", "NONE"), state="open",
        html_url=f"https://github.com/vllm-project/vllm/issues/{number}",
        created_at=NOW - timedelta(hours=2), updated_at=NOW - timedelta(hours=1), **kw,
    )


SEVERE: dict[str, Any] = {
    "type": "regression", "summary": "DeepSeek-V3.1 fails to start on B200 after 0.12",
    "models": [{"name": "DeepSeek-V3.1", "family": "deepseek"}], "model_traits": ["moe"],
    "hardware": ["B200"], "serving": ["tp", "openai_api"], "areas": ["moe"],
    "severity": {"serving_broken": True, "crash": True, "wrong_output": False, "hang": False,
                 "perf_regression_pct": None, "memory_regression": False, "security": False},
    "default_config": True,
    "versions": {"good": "0.11.2", "bad": "0.12.0", "affects_main": True, "affects_latest_release": True},
    "has_repro": True, "pr": None, "slop_signals": [], "confidence": 0.9, "notes": "",
}
MINOR: dict[str, Any] = {**SEVERE, "type": "question", "summary": "How to set max_model_len", "models": [],
         "hardware": [], "areas": ["frontend_api"], "default_config": None,
         "severity": {k: (None if k == "perf_regression_pct" else False) for k in SEVERE["severity"]},
         "versions": {"good": None, "bad": None, "affects_main": None, "affects_latest_release": None},
         "has_repro": False}


class FakeBackend:
    def __init__(self, by_title: dict[str, dict[str, Any]]) -> None:
        self.by_title = by_title
        self.calls = 0

    def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult:
        self.calls += 1
        for title, facets in self.by_title.items():
            if title in prompt:
                return LLMResult(output=facets, model="fake", input_tokens=1000, output_tokens=100)
        raise AssertionError("unexpected prompt")


def outbox(database_url: str) -> list[tuple[str, str, str, dict[str, Any]]]:
    with psycopg.connect(database_url) as c:
        rows = c.execute(
            "SELECT delivery_id, delivery_mode, destination, payload FROM alerting_notification_outbox "
            "WHERE alert_path = 'triage' ORDER BY delivery_id"
        ).fetchall()
    return [(r[0], r[1], r[2], r[3]) for r in rows]


def test_full_pipeline_extract_score_route_notify(store: PostgresTriageStore, database_url: str) -> None:
    ingest(store, issue(1, "DeepSeek startup crash"))
    ingest(store, issue(2, "max_model_len question"))
    ingest(store, issue(3, "refactor", kind="pr", author_association="MEMBER",
                        files=[FileChange("vllm/x.py")]))  # out of scope: maintainer, unlinked
    store.seed_maintainers([
        {"github_login": "moe-person", "slack_user_id": "U1", "rules": {"areas": ["moe"]}},
        {"github_login": "b200-person", "slack_user_id": "U2", "rules": {"hardware": ["B200"]}},
        {"github_login": "frontend-person", "slack_user_id": "U3", "rules": {"areas": ["frontend_api"]}},
    ])

    backend = FakeBackend({"DeepSeek startup crash": SEVERE, "max_model_len question": MINOR})
    result = run_extraction(store, backend, budget=Budget(), now=NOW, workers=1)
    assert (result.extracted, result.failed, backend.calls) == (2, 0, 2)
    assert store.extraction_usage_since(NOW - timedelta(days=1)) == (2, 2200)

    clock = FixedClock(NOW)
    RouteHandler(store=store, config=default_config(), clock=clock, delivery_mode=DeliveryMode.SHADOW)(
        ScheduledCommand("triage_route", NOW)
    )
    with psycopg.connect(database_url) as c:
        scores = dict(c.execute("SELECT item_key, band FROM triage_scores").fetchall())
        assigned = c.execute(
            "SELECT item_key, maintainer, role FROM triage_assignments ORDER BY role DESC, maintainer"
        ).fetchall()
    assert scores["vllm-project/vllm#1"] == "page"
    assert scores["vllm-project/vllm#2"] in ("watch", "ignore")
    assert "vllm-project/vllm#3" not in scores
    # Page band: a primary and a backup, both matched one criterion; tie broken by login.
    assert assigned == [("vllm-project/vllm#1", "b200-person", "primary"),
                        ("vllm-project/vllm#1", "moe-person", "backup")]
    sent = outbox(database_url)
    assert [(d, mode, dest) for d, mode, dest, _ in sent] == [
        ("triage:page:vllm-project/vllm#1:b200-person:primary", "shadow", "U2"),
        ("triage:page:vllm-project/vllm#1:moe-person:backup", "shadow", "U1"),
    ]
    assert "DeepSeek-V3.1 fails to start" in json.dumps(sent[0][3])

    # Re-running routes nothing new and re-scores nothing (scores are fresh).
    RouteHandler(store=store, config=default_config(), clock=clock, delivery_mode=DeliveryMode.SHADOW)(
        ScheduledCommand("triage_route", NOW + timedelta(minutes=5))
    )
    assert len(outbox(database_url)) == 2
    assert store.scoring_candidates(scoring_version=default_config().version, limit=10) == []


def test_not_mine_reroutes_and_drop_stops_routing(store: PostgresTriageStore, database_url: str) -> None:
    ingest(store, issue(10, "DeepSeek startup crash"))
    store.seed_maintainers([
        {"github_login": "a", "rules": {"areas": ["moe"]}, "notify_mode": "digest"},
        {"github_login": "b", "rules": {"hardware": ["B200"], "areas": ["moe"]}, "notify_mode": "digest"},
    ])
    run_extraction(store, FakeBackend({"DeepSeek": SEVERE}), budget=Budget(), now=NOW, workers=1)
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                         delivery_mode=DeliveryMode.SHADOW)
    route(ScheduledCommand("triage_route", NOW))
    with psycopg.connect(database_url, autocommit=True) as c:
        primary = c.execute("SELECT id, maintainer FROM triage_assignments WHERE role='primary'").fetchone()
        assert primary[1] == "b"  # two matches beat one
        # What the dashboard does for "not mine" (docs/data-model.md):
        c.execute("UPDATE triage_assignments SET status='not_mine', closed_at=now() WHERE id=%s", (primary[0],))
        c.execute("UPDATE triage_assignments SET status='not_mine', closed_at=now() WHERE role='backup'")
        c.execute("INSERT INTO triage_actions (item_key, assignment_id, actor, action, source) "
                  "VALUES ('vllm-project/vllm#10', %s, 'b', 'not_mine', 'dashboard')", (primary[0],))
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=5)))
    with psycopg.connect(database_url, autocommit=True) as c:
        open_rows = c.execute(
            "SELECT maintainer, role FROM triage_assignments WHERE status='open'").fetchall()
        assert open_rows == [("a", "primary")]
        c.execute("UPDATE triage_assignments SET status='dropped', closed_at=now() WHERE status='open'")
        c.execute("INSERT INTO triage_actions (item_key, actor, action, source) "
                  "VALUES ('vllm-project/vllm#10', 'a', 'drop', 'dashboard')")
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=10)))
    with psycopg.connect(database_url) as c:
        assert c.execute("SELECT count(*) FROM triage_assignments WHERE status='open'").fetchone()[0] == 0
    # Digest-mode maintainers without Slack IDs get no DMs at all.
    assert outbox(database_url) == []


def test_digest_marks_notified_and_is_idempotent_per_day(store: PostgresTriageStore, database_url: str) -> None:
    ingest(store, issue(20, "DeepSeek startup crash"))
    store.seed_maintainers([{"github_login": "d", "slack_user_id": "U9", "rules": {"areas": ["moe"]},
                             "notify_mode": "digest"}])
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_items SET prepass = prepass || '{}'::jsonb")
    run_extraction(store, FakeBackend({"DeepSeek": {**SEVERE, "severity": {
        **SEVERE["severity"], "serving_broken": False, "crash": False, "hang": True}, "type": "bug"}}),
        budget=Budget(), now=NOW, workers=1)
    RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                 delivery_mode=DeliveryMode.LIVE)(ScheduledCommand("triage_route", NOW))
    assert outbox(database_url) == []  # route band + digest mode: no immediate DM
    digest = DigestHandler(store=store, clock=FixedClock(NOW), delivery_mode=DeliveryMode.LIVE,
                           team_channel="C1")
    digest(ScheduledCommand("triage_digest", NOW))
    digest(ScheduledCommand("triage_digest", NOW + timedelta(minutes=1)))
    ids = [d for d, *_ in outbox(database_url)]
    assert ids == ["triage:digest:d:2026-11-12", "triage:team-digest:2026-11-12"]
    assert store.unnotified_assignments("d") == []


def test_changed_text_requeues_extraction(store: PostgresTriageStore, database_url: str) -> None:
    ingest(store, issue(30, "DeepSeek startup crash"))
    run_extraction(store, FakeBackend({"DeepSeek": SEVERE}), budget=Budget(), now=NOW, workers=1)
    ingest(store, issue(30, "DeepSeek startup crash", body="y" * 300))
    with psycopg.connect(database_url) as c:
        assert c.execute("SELECT extraction_status FROM triage_items").fetchone()[0] == "pending"


def test_budget_stops_extraction(store: PostgresTriageStore) -> None:
    for n in range(5):
        ingest(store, issue(40 + n, f"DeepSeek crash {n}"))
    backend = FakeBackend({"DeepSeek": SEVERE})
    result = run_extraction(store, backend, budget=Budget(max_items_per_day=3), now=NOW, workers=1)
    assert result.extracted == 3
    again = run_extraction(store, backend, budget=Budget(max_items_per_day=3), now=NOW, workers=1)
    assert again.extracted == 0 and again.stopped_reason


ROLE_SQL = Path(__file__).resolve().parents[2] / "deploy" / "triage-extractor" / "extractor-role.sql"


def test_extractor_role_can_extract_and_nothing_else(store: PostgresTriageStore, database_url: str) -> None:
    ingest(store, issue(50, "DeepSeek startup crash"))
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute(ROLE_SQL.read_text().replace(":pw", "'extractor-test-pw'"))
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    params = conninfo_to_dict(database_url)
    params.update(user="triage_extractor", password="extractor-test-pw")
    role_url = make_conninfo("", **params)

    restricted = PostgresTriageStore(role_url)
    result = run_extraction(restricted, FakeBackend({"DeepSeek": SEVERE}), budget=Budget(), now=NOW, workers=1)
    assert (result.extracted, result.failed) == (1, 0)
    assert restricted.extraction_usage_since(NOW - timedelta(days=1)) == (1, 1100)

    with psycopg.connect(role_url, autocommit=True) as c:
        for statement in (
            "SELECT * FROM triage_maintainers",
            "SELECT * FROM alerting_notification_outbox",
            "INSERT INTO triage_scores (item_key, score, band, breakdown, scoring_version) "
            "VALUES ('vllm-project/vllm#50', 1, 'watch', '[]', 'x')",
            "UPDATE triage_items SET title = 'pwned'",
            "INSERT INTO triage_actions (item_key, actor, action, source) "
            "VALUES ('vllm-project/vllm#50', 'x', 'slop', 'cli')",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(statement)
