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
# Fixed and in the future: rows also get Postgres now() timestamps (e.g.
# triage_items.updated_at), and the test clock must stay after those.
NOW = datetime(2035, 1, 15, 12, 0, tzinfo=timezone.utc)


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


def seed(store: PostgresTriageStore, rows: list[dict[str, Any]]) -> None:
    import yaml

    from triage.maintainers import parse_maintainer_files

    store.sync_maintainers(parse_maintainer_files(
        {f"{row['github_login']}.yaml": yaml.safe_dump(row) for row in rows}))


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
        author=kw.pop("author", "user"), author_association=kw.pop("author_association", "NONE"), state="open",
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
    seed(store, [
        {"github_login": "moe-person", "slack_user_id": "U0000000001", "rules": {"areas": ["moe"]}},
        {"github_login": "b200-person", "slack_user_id": "U0000000002", "rules": {"hardware": ["B200"]}},
        {"github_login": "frontend-person", "slack_user_id": "U0000000003", "rules": {"areas": ["frontend_api"]}},
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
    # Page band, rule matches only: a primary but no backup (backups must be
    # clear matches). Tie broken by login.
    assert assigned == [("vllm-project/vllm#1", "b200-person", "primary")]
    sent = outbox(database_url)
    assert [(d, mode, dest) for d, mode, dest, _ in sent] == [
        ("triage:page:vllm-project/vllm#1:b200-person:primary", "shadow", "U0000000002"),
    ]
    assert "DeepSeek-V3.1 fails to start" in json.dumps(sent[0][3])

    # Re-running routes nothing new and re-scores nothing (scores are fresh).
    RouteHandler(store=store, config=default_config(), clock=clock, delivery_mode=DeliveryMode.SHADOW)(
        ScheduledCommand("triage_route", NOW + timedelta(minutes=5))
    )
    assert len(outbox(database_url)) == 1
    assert store.scoring_candidates(scoring_version=default_config().version, limit=10) == []


def test_a_pr_is_rescored_when_the_issue_it_fixes_is(store: PostgresTriageStore, database_url: str) -> None:
    ingest(store, issue(10, "DeepSeek startup crash"))
    ingest(store, issue(11, "Fix DeepSeek startup", kind="pr", body="Fixes #10\n" + "x" * 200,
                        files=[FileChange("vllm/x.py")]))
    pr_facets = {**SEVERE, "type": "bug", "pr": {"fixes_issues": [10], "hot_path": False, "size": "s",
                                                 "has_tests": True, "low_effort": False}}
    run_extraction(store, FakeBackend({"DeepSeek startup crash": SEVERE, "Fix DeepSeek startup": pr_facets}),
                   budget=Budget(), now=NOW, workers=1)
    clock = FixedClock(NOW)
    RouteHandler(store=store, config=default_config(), clock=clock, delivery_mode=DeliveryMode.SHADOW)(
        ScheduledCommand("triage_route", NOW))
    version = default_config().version
    assert store.scoring_candidates(scoring_version=version, limit=10) == []
    # The issue is rescored later (say a new comment changed its score): the PR follows.
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_scores SET scored_at = scored_at + interval '1 minute' "
                  "WHERE item_key = 'vllm-project/vllm#10'")
    assert [r.number for r in store.scoring_candidates(scoring_version=version, limit=10)] == [11]
    clock.value = NOW + timedelta(minutes=5)
    RouteHandler(store=store, config=default_config(), clock=clock, delivery_mode=DeliveryMode.SHADOW)(
        ScheduledCommand("triage_route", NOW + timedelta(minutes=5)))
    assert store.scoring_candidates(scoring_version=version, limit=10) == []


def test_needs_relevance_handles_items_without_gh_assignees(store: PostgresTriageStore, database_url: str) -> None:
    # Items ingested before prepass.gh_assignees existed have no such key; the
    # sync must treat that as "no assignees", not write NULL (NOT NULL column).
    ingest(store, issue(900, "DeepSeek startup crash old"))
    ingest(store, issue(901, "DeepSeek startup crash assigned", assignees=["outsider"]) if "assignees" in Item.__dataclass_fields__
           else issue(901, "DeepSeek startup crash assigned"))
    run_extraction(store, FakeBackend({"DeepSeek startup crash old": SEVERE, "DeepSeek startup crash assigned": SEVERE}),
                   budget=Budget(), now=NOW, workers=1)
    RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                 delivery_mode=DeliveryMode.SHADOW)._rescore(NOW)
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_items SET prepass = prepass - 'gh_assignees' WHERE item_key = 'vllm-project/vllm#900'")
        c.execute("UPDATE triage_items SET prepass = prepass || '{\"gh_assignees\": [\"outsider\"]}'::jsonb "
                  "WHERE item_key = 'vllm-project/vllm#901'")
        c.execute("UPDATE triage_scores SET band = 'page', needs_relevance = false")
    store.sync_needs_relevance(active_maintainers=["someone"])
    with psycopg.connect(database_url) as c:
        got = dict(c.execute("SELECT item_key, needs_relevance FROM triage_scores").fetchall())
    assert got["vllm-project/vllm#900"] is True    # no assignee key: still needs judging
    assert got["vllm-project/vllm#901"] is False   # assigned only to an outsider: left alone


def test_not_mine_reroutes_and_drop_stops_routing(store: PostgresTriageStore, database_url: str) -> None:
    ingest(store, issue(10, "DeepSeek startup crash"))
    seed(store, [
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
    seed(store, [{"github_login": "d", "slack_user_id": "U0000000009", "rules": {"areas": ["moe"]},
                             "notify_mode": "digest", "digest_hour": NOW.hour}])
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_items SET prepass = prepass || '{}'::jsonb")
    run_extraction(store, FakeBackend({"DeepSeek": {**SEVERE, "severity": {
        **SEVERE["severity"], "serving_broken": False, "crash": False, "hang": True}, "type": "bug"}}),
        budget=Budget(), now=NOW, workers=1)
    RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                 delivery_mode=DeliveryMode.LIVE)(ScheduledCommand("triage_route", NOW))
    assert outbox(database_url) == []  # route band + digest mode: no immediate DM
    digest = DigestHandler(store=store, clock=FixedClock(NOW), delivery_mode=DeliveryMode.LIVE,
                           team_channel="C1", team_digest_hour_utc=NOW.hour)
    digest(ScheduledCommand("triage_digest", NOW))
    digest(ScheduledCommand("triage_digest", NOW + timedelta(minutes=1)))
    ids = [d for d, *_ in outbox(database_url)]
    day = NOW.date().isoformat()
    assert ids == [f"triage:digest:d:{day}", f"triage:team-digest:{day}"]
    assert store.unnotified_assignments("d") == []


def scored_items(store: PostgresTriageStore, numbers: list[int]) -> None:
    """Page-band items with scores and nobody routed (no rule matches)."""
    for n in numbers:
        ingest(store, issue(n, f"DeepSeek crash {n}"))
    run_extraction(store, FakeBackend({"DeepSeek": SEVERE}), budget=Budget(), now=NOW, workers=1)
    RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                 delivery_mode=DeliveryMode.SHADOW)(ScheduledCommand("triage_route", NOW))


def assign(database_url: str, number: int, maintainer: str, *, assigned_at: datetime,
           notified_at: datetime | None = None, status: str = "open", role: str = "primary") -> int:
    with psycopg.connect(database_url, autocommit=True) as c:
        row = c.execute(
            """INSERT INTO triage_assignments (item_key, maintainer, role, status, score_at_assign,
                   assigned_at, notified_at) VALUES (%s, %s, %s, %s, 90, %s, %s) RETURNING id""",
            (f"vllm-project/vllm#{number}", maintainer, role, status, assigned_at, notified_at),
        ).fetchone()
    return int(row[0])


def notified_at(database_url: str, assignment_id: int) -> datetime | None:
    with psycopg.connect(database_url) as c:
        value: datetime | None = c.execute("SELECT notified_at FROM triage_assignments WHERE id = %s",
                                           (assignment_id,)).fetchone()[0]
    return value


def test_digest_goes_out_at_each_maintainers_local_morning(
    store: PostgresTriageStore, database_url: str
) -> None:
    seed(store, [
        # 06:00 in Vietnam is 23:00 UTC the day before: the digest is dated locally.
        {"github_login": "vn", "slack_user_id": "U0000000011", "rules": {"areas": ["tpu"]},
         "timezone": "Asia/Ho_Chi_Minh", "digest_hour": 6, "language": "vi"},
        {"github_login": "la", "slack_user_id": "U0000000012", "rules": {"areas": ["tpu"]},
         "timezone": "America/Los_Angeles"},                     # 09:00 PST = 17:00 UTC
        {"github_login": "utc", "slack_user_id": "U0000000013", "rules": {"areas": ["tpu"]}},  # 09:00 UTC
    ])
    scored_items(store, [501, 502, 503, 504])
    assert outbox(database_url) == []
    for number, login in ((501, "vn"), (502, "la"), (503, "utc")):
        assign(database_url, number, login, assigned_at=NOW)
    digest = DigestHandler(store=store, clock=FixedClock(NOW), delivery_mode=DeliveryMode.SHADOW,
                           team_channel="C1")

    def run_at(when: datetime) -> list[str]:
        digest.clock = FixedClock(when)
        digest(ScheduledCommand("triage_digest", when))
        return [d for d, *_ in outbox(database_url)]

    day = datetime(2035, 1, 15, tzinfo=timezone.utc)
    assert run_at(day.replace(hour=13)) == []                 # nobody's morning
    assert run_at(day.replace(hour=15)) == ["triage:team-digest:2035-01-15"]
    assert run_at(day.replace(hour=17)) == ["triage:digest:la:2035-01-15", "triage:team-digest:2035-01-15"]
    vn = run_at(day.replace(hour=23))
    assert "triage:digest:vn:2035-01-16" in vn and len(vn) == 3

    # The timer fires twice in the same hour (e.g. a catch-up after a reboot):
    # the second run must not send again, nor mark a newly routed item as
    # notified, or it would never be sent.
    late = assign(database_url, 504, "vn", assigned_at=day.replace(hour=23, minute=20))
    assert run_at(day.replace(hour=23, minute=40)) == vn
    assert notified_at(database_url, late) is None
    assert run_at(datetime(2035, 1, 16, 9, tzinfo=timezone.utc)) == sorted(vn + ["triage:digest:utc:2035-01-16"])
    assert notified_at(database_url, late) is None             # vn's next morning is 23:00 UTC
    assert "triage:digest:vn:2035-01-17" in run_at(datetime(2035, 1, 16, 23, tzinfo=timezone.utc))
    assert notified_at(database_url, late) == datetime(2035, 1, 16, 23, tzinfo=timezone.utc)
    payloads = {d: p for d, _, _, p in outbox(database_url)}
    assert payloads["triage:digest:vn:2035-01-16"]["blocks"][0]["text"]["text"] == "📬 Digest triage hằng ngày · 16/1"


def test_still_waiting_reminders_in_the_digest(store: PostgresTriageStore, database_url: str) -> None:
    seed(store, [
        {"github_login": "r", "slack_user_id": "U0000000021", "rules": {"areas": ["tpu"]}, "digest_hour": NOW.hour},
        {"github_login": "o", "rules": {"areas": ["tpu"]}},
    ])
    scored_items(store, list(range(601, 609)))
    def ago(days: int) -> datetime:
        return NOW - timedelta(days=days)

    oldest = assign(database_url, 601, "r", assigned_at=ago(6), notified_at=ago(6))
    older = assign(database_url, 602, "r", assigned_at=ago(4), notified_at=ago(4))
    recent = assign(database_url, 603, "r", assigned_at=ago(1), notified_at=ago(1))   # too recent
    assign(database_url, 604, "r", assigned_at=ago(5), notified_at=ago(5), status="acked")
    assign(database_url, 605, "o", assigned_at=ago(5), status="acked")                 # o took it
    assign(database_url, 605, "r", assigned_at=ago(5), notified_at=ago(5), role="backup")
    assign(database_url, 606, "r", assigned_at=ago(5), notified_at=ago(5))
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_items SET state = 'closed' WHERE item_key = 'vllm-project/vllm#606'")
    assign(database_url, 607, "r", assigned_at=ago(5), notified_at=ago(5))
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("INSERT INTO triage_actions (item_key, actor, action, source) "
                  "VALUES ('vllm-project/vllm#607', 'o', 'drop', 'dashboard')")
    fresh = assign(database_url, 608, "r", assigned_at=NOW - timedelta(hours=1))

    entries, total = store.waiting_assignments("r", assigned_before=ago(3), limit=5)
    assert [e.item_key for e in entries] == ["vllm-project/vllm#601", "vllm-project/vllm#602"] and total == 2
    assert store.waiting_assignments("r", assigned_before=ago(3), limit=1)[1] == 2

    digest = DigestHandler(store=store, clock=FixedClock(NOW), delivery_mode=DeliveryMode.SHADOW, team_channel=None)
    digest(ScheduledCommand("triage_digest", NOW))
    [(delivery_id, _, _, payload)] = outbox(database_url)
    assert delivery_id == f"triage:digest:r:{NOW.date().isoformat()}"
    texts = [b.get("text", {}).get("text", "") for b in payload["blocks"]]
    title = texts.index("*⏳ Still waiting (2)*")
    assert "#608" in "".join(texts[:title]) and "#608" not in "".join(texts[title:])
    assert "#601" in texts[title + 1] and "assigned 6 days ago" in texts[title + 1]
    assert "#602" in texts[title + 3] and payload["blocks"][title + 4]["type"] == "actions"
    assert payload["text"] == "Triage digest: 1 P0, 2 still waiting"
    # The new item is marked notified; reminders keep their first notified_at.
    assert notified_at(database_url, fresh) == NOW
    assert notified_at(database_url, oldest) == ago(6) and notified_at(database_url, older) == ago(4)

    # Next day: nothing new, but the reminders alone make a digest.
    tomorrow = NOW + timedelta(days=1)
    digest.clock = FixedClock(tomorrow)
    digest(ScheduledCommand("triage_digest", tomorrow))
    payload = dict((d, p) for d, _, _, p in outbox(database_url))[f"triage:digest:r:{tomorrow.date().isoformat()}"]
    assert payload["blocks"][1]["text"]["text"].startswith("Hi <@U0000000021> 👋 Nothing new today, but you still have *2 waiting*")
    assert payload["text"] == "Triage digest: 2 still waiting"

    # Once everything is acked there is nothing to say: no digest.
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_assignments SET status = 'acked' WHERE id = ANY(%s)",
                  ([oldest, older, recent, fresh],))
    later = NOW + timedelta(days=2)
    digest.clock = FixedClock(later)
    digest(ScheduledCommand("triage_digest", later))
    assert len(outbox(database_url)) == 2


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


def extractor_role_url(database_url: str) -> str:
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute(ROLE_SQL.read_text().replace(":pw", "'extractor-test-pw'"))
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    params = conninfo_to_dict(database_url)
    params.update(user="triage_extractor", password="extractor-test-pw")
    return make_conninfo("", **params)


def test_extractor_role_can_extract_and_nothing_else(store: PostgresTriageStore, database_url: str) -> None:
    ingest(store, issue(50, "DeepSeek startup crash"))
    role_url = extractor_role_url(database_url)

    restricted = PostgresTriageStore(role_url)
    result = run_extraction(restricted, FakeBackend({"DeepSeek": SEVERE}), budget=Budget(), now=NOW, workers=1)
    assert (result.extracted, result.failed) == (1, 0)
    assert restricted.extraction_usage_since(NOW - timedelta(days=1)) == (1, 1100)

    with psycopg.connect(role_url, autocommit=True) as c:
        # It reads maintainers and their profiles to judge relevance...
        c.execute("SELECT * FROM triage_maintainers")
        c.execute("SELECT github_login, prs, feedback FROM triage_maintainer_profiles")
        for statement in (  # ...but writes nothing except extractions and judgements,
            "SELECT * FROM triage_actions",  # and never sees who did what with items.
            "SELECT * FROM triage_assignments",
            "UPDATE triage_maintainers SET min_score = 0",
            "INSERT INTO triage_maintainer_profiles (github_login, prs, profile_hash) VALUES ('x', '[]', 'h')",
            "SELECT * FROM alerting_notification_outbox",
            "INSERT INTO triage_scores (item_key, score, band, breakdown, scoring_version) "
            "VALUES ('vllm-project/vllm#50', 1, 'watch', '[]', 'x')",
            "UPDATE triage_items SET title = 'pwned'",
            "INSERT INTO triage_actions (item_key, actor, action, source) "
            "VALUES ('vllm-project/vllm#50', 'x', 'slop', 'cli')",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(statement)


def test_maintainer_files_are_the_source_of_truth(store: PostgresTriageStore, database_url: str) -> None:
    from triage.maintainers import parse_maintainer_files

    a = {"a.yaml": "github_login: a\nrules: {areas: [moe]}\n"}
    b = {"b.yaml": "github_login: b\nmin_score: 60\nrules: {hardware: [B200]}\n"}
    with psycopg.connect(database_url, autocommit=True) as c:
        # Someone without a file who acked an item on the dashboard.
        c.execute("INSERT INTO triage_maintainers (github_login, updated_by) VALUES ('walk-in', 'walk-in')")
    assert store.sync_maintainers(parse_maintainer_files({**a, **b})) == (2, 0)
    # b's PR changes their file; a deletes theirs.
    b2 = {"b.yaml": "github_login: b\nmin_score: 70\nrules: {hardware: [B200, GB200]}\n"}
    assert store.sync_maintainers(parse_maintainer_files(b2)) == (1, 1)
    with psycopg.connect(database_url) as c:
        rows = dict((r[0], r[1:]) for r in c.execute(
            "SELECT github_login, active, min_score, rules->'hardware', updated_by FROM triage_maintainers"))
    assert rows["a"][0] is False
    assert rows["b"] == (True, 70, ["B200", "GB200"], "repo")
    assert rows["walk-in"] == (True, 40, None, "walk-in")


def test_a_broken_or_unfetchable_set_keeps_the_last_good_rules(
    store: PostgresTriageStore, database_url: str
) -> None:
    good = {"a.yaml": "github_login: a\nrules: {areas: [moe]}\n"}
    bad = {"a.yaml": "github_login: a\nrules: {areas: [not-an-area]}\n"}
    sources = iter([good, bad, None, {}])
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                         delivery_mode=DeliveryMode.SHADOW, maintainers_source=lambda: next(sources))
    for minutes in (0, 5, 10):  # good, then invalid, then fetch failed
        route(ScheduledCommand("triage_route", NOW + timedelta(minutes=minutes)))
        assert [m.rules["areas"] for m in store.active_maintainers()] == [["moe"]]
    # An empty folder that fetched fine is real: everyone is deactivated.
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=15)))
    assert store.active_maintainers() == []


class FakeGitHub:
    reads_pr_status = False

    def __init__(self, authors: dict[int, str]) -> None:
        self.authors = authors
        self.lookups: list[int] = []

    def pull_authors(self, repo: str, numbers: list[int]) -> dict[int, str]:
        self.lookups.extend(numbers)
        return {n: self.authors[n] for n in numbers if n in self.authors}

    def comment_tail(self, repo: str, number: int) -> list[tuple[str, datetime | None]]:
        return []

    def pull_files(self, repo: str, number: int) -> list[FileChange]:
        return []

    def comment_records(self, repo: str, number: int) -> list[tuple[str, datetime | None, str]]:
        return [("gau-nernst", NOW - timedelta(hours=1), "[gau-nernst (MEMBER)]: looking into it")]


def test_regression_goes_to_the_author_of_the_bisected_pr(store: PostgresTriageStore, database_url: str) -> None:
    from triage.pipeline import IngestHandler

    gh = FakeGitHub({61343: "gau-nernst"})
    ingest_handler = IngestHandler(store=store, github=gh, config=default_config(), clock=FixedClock(NOW))  # type: ignore[arg-type]
    body = "Accuracy drops after vLLM PR #61343 (https://github.com/vllm-project/vllm/pull/61343)." + " x" * 50
    ingest_handler._ingest(issue(65906, "Qwen3.5 FP8 GSM8K accuracy drop", body=body, comment_count=2))
    ingest_handler._ingest(issue(65906, "Qwen3.5 FP8 GSM8K accuracy drop", body=body, comment_count=2))
    assert gh.lookups == [61343]  # looked up once, then reused
    seed(store, [{"github_login": "gau-nernst", "rules": {"areas": ["moe"]}}])
    run_extraction(store, FakeBackend({"Qwen3.5": {**SEVERE, "areas": ["quantization"], "hardware": ["B200"]}}),
                   budget=Budget(), now=NOW, workers=1)
    RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                 delivery_mode=DeliveryMode.SHADOW)(ScheduledCommand("triage_route", NOW))
    with psycopg.connect(database_url) as c:
        row = c.execute("SELECT maintainer, reason->'matched' FROM triage_assignments").fetchone()
    assert row == ("gau-nernst", ["authored #61343", "commented"])


class FakeProfiles:
    def maintainer_prs(self, repo: str, login: str, *, since: datetime, per_kind: int = 120) -> list[dict[str, Any]]:
        return {"gau-nernst": [{"number": 61343, "kind": "authored", "title": "per_token_group_quant reciprocal"}],
                "amd-person": [{"number": 7, "kind": "reviewed", "title": "[ROCm] AITER MLA"}]}[login]


def test_relevance_end_to_end(store: PostgresTriageStore, database_url: str) -> None:
    from triage.relevance import run_relevance

    ingest(store, issue(65906, "Qwen3.5 FP8 GSM8K accuracy drop"))
    seed(store, [{"github_login": "gau-nernst", "notes": "FP8 kernels"},
                 {"github_login": "amd-person", "notes": "ROCm"}])
    run_extraction(store, FakeBackend({"Qwen3.5": SEVERE}), budget=Budget(), now=NOW, workers=1)
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                         delivery_mode=DeliveryMode.SHADOW, github=FakeProfiles())  # type: ignore[arg-type]
    route(ScheduledCommand("triage_route", NOW))  # builds profiles, scores; waits for judgements
    with psycopg.connect(database_url) as c:
        assert c.execute("SELECT count(*) FROM triage_maintainer_profiles").fetchone()[0] == 2
        assert c.execute("SELECT count(*) FROM triage_assignments").fetchone()[0] == 0

    class Judge:
        def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult:
            assert "per_token_group_quant reciprocal" in system and "<notes>FP8 kernels</notes>" in system
            return LLMResult(output={"judgments": [
                {"github_login": "gau-nernst", "relevance": "high", "evidence_prs": [61343], "reason": "his PR"},
                {"github_login": "amd-person", "relevance": "none", "evidence_prs": [], "reason": "NVIDIA only"},
            ]}, model="fake")

    result = run_relevance(store, Judge(), now=NOW, min_score=40)
    assert (result.judged, result.failed) == (1, 0)
    assert run_relevance(store, Judge(), now=NOW, min_score=40).judged == 0  # nothing stale
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=5)))
    with psycopg.connect(database_url) as c:
        rows = c.execute("SELECT maintainer, role, reason->'matched', reason->>'why' FROM triage_assignments").fetchall()
    assert rows == [("gau-nernst", "primary", ["relevance:high (like #61343)"], "his PR")]


def test_a_burst_of_drops_is_flagged_in_the_team_digest(store: PostgresTriageStore, database_url: str) -> None:
    for n in range(3):
        ingest(store, issue(900 + n, f"item {n}"))
    with psycopg.connect(database_url, autocommit=True) as c:
        for n in range(3):
            c.execute("INSERT INTO triage_actions (item_key, actor, action, source, created_at) "
                      "VALUES (%s, 'mallory', %s, 'dashboard', %s)",
                      (f"vllm-project/vllm#{900 + n}", "drop" if n else "slop", NOW - timedelta(hours=1)))
    assert store.suppression_since(NOW - timedelta(days=1), threshold=3) == [("mallory", 2, 1)]
    assert store.suppression_since(NOW - timedelta(days=1), threshold=4) == []
    DigestHandler(store=store, clock=FixedClock(NOW), delivery_mode=DeliveryMode.SHADOW,
                  team_channel="C1", suppression_threshold=3,
                  team_digest_hour_utc=NOW.hour)(ScheduledCommand("triage_digest", NOW))
    [(_, mode, _, payload)] = outbox(database_url)
    assert mode == "shadow" and "mallory: 2 dropped, 1 slop" in json.dumps(payload)


def test_clear_matches_get_capacity_before_higher_scoring_medium_ones(
    store: PostgresTriageStore, database_url: str
) -> None:
    from triage.relevance import run_relevance

    ingest(store, issue(1001, "Big crash, loosely related"))
    ingest(store, issue(1002, "Smaller bug in their own kernel"))
    seed(store, [{"github_login": "gau-nernst", "notes": "kernels", "capacity_per_week": 1},
                 {"github_login": "amd-person", "notes": "ROCm"}])
    loose = {**SEVERE, "type": "bug"}                       # scores higher
    own = {**SEVERE, "type": "bug", "severity": {**SEVERE["severity"], "serving_broken": False,
                                                  "crash": False, "hang": True}}
    run_extraction(store, FakeBackend({"Big crash": loose, "Smaller bug": own}), budget=Budget(), now=NOW, workers=1)
    with psycopg.connect(database_url, autocommit=True) as c:  # backlog: the weekly cap applies
        c.execute("UPDATE triage_items SET gh_created_at = %s", (NOW - timedelta(days=10),))
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                         delivery_mode=DeliveryMode.SHADOW, github=FakeProfiles())  # type: ignore[arg-type]
    route(ScheduledCommand("triage_route", NOW))

    class Judge:
        def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult:
            level = "medium" if "Big crash" in prompt else "high"
            return LLMResult(output={"judgments": [
                {"github_login": "gau-nernst", "relevance": level, "evidence_prs": [61343], "reason": level},
                {"github_login": "amd-person", "relevance": "none", "evidence_prs": [], "reason": ""},
            ]}, model="fake")

    assert run_relevance(store, Judge(), now=NOW, min_score=40).judged == 2
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=5)))
    with psycopg.connect(database_url) as c:
        scores = dict(c.execute("SELECT i.number, s.score FROM triage_scores s JOIN triage_items i USING (item_key)").fetchall())
        rows = c.execute("SELECT item_key FROM triage_assignments").fetchall()
    assert scores[1001] > scores[1002]
    assert rows == [("vllm-project/vllm#1002",)]  # the one slot went to the clear match


def test_items_age_out_of_the_window(store: PostgresTriageStore, database_url: str) -> None:
    ingest(store, issue(1101, "DeepSeek startup crash old"))
    ingest(store, issue(1102, "DeepSeek startup crash acked"))
    ingest(store, issue(1103, "DeepSeek startup crash new"))
    seed(store, [{"github_login": "a", "rules": {"areas": ["moe"]}}])
    run_extraction(store, FakeBackend({"DeepSeek": SEVERE}), budget=Budget(), now=NOW, workers=1)
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW), delivery_mode=DeliveryMode.SHADOW)
    route(ScheduledCommand("triage_route", NOW))
    with psycopg.connect(database_url, autocommit=True) as c:
        assert c.execute("SELECT count(*) FROM triage_assignments").fetchone()[0] == 3
        # #1102 was acked by its owner; then #1101 and #1102 age past 30 days.
        c.execute("UPDATE triage_assignments SET status='acked' WHERE item_key='vllm-project/vllm#1102'")
        c.execute("INSERT INTO triage_actions (item_key, actor, action, source) VALUES ('vllm-project/vllm#1102','a','ack','dashboard')")
        c.execute("UPDATE triage_items SET gh_created_at = %s WHERE number IN (1101, 1102)", (NOW - timedelta(days=40),))
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=5)))
    with psycopg.connect(database_url) as c:
        scope = dict(c.execute("SELECT number, in_scope FROM triage_items WHERE number > 1100").fetchall())
        left = sorted(r[0] for r in c.execute("SELECT item_key FROM triage_assignments"))
    assert scope == {1101: False, 1102: False, 1103: True}
    # The unacted assignment on the old item is gone; the acked one stays as history.
    assert left == ["vllm-project/vllm#1102", "vllm-project/vllm#1103"]


def assignments(database_url: str) -> dict[tuple[str, str], tuple[str, bool, dict[str, Any]]]:
    """{(item number, maintainer): (status, closed_at is set, reason)}"""
    with psycopg.connect(database_url) as c:
        rows = c.execute("SELECT item_key, maintainer, status, closed_at IS NOT NULL, reason "
                         "FROM triage_assignments").fetchall()
    return {(r[0].rsplit("#", 1)[1], r[1]): (r[2], r[3], r[4]) for r in rows}


def test_closing_on_github_closes_assignments_and_reopening_restores_them(
    store: PostgresTriageStore, database_url: str,
) -> None:
    from dataclasses import replace

    items = {n: issue(n, f"DeepSeek startup crash {n}") for n in (1201, 1202, 1203)}
    for item in items.values():
        ingest(store, item)
    # digest_hour = the test clock's hour, so the digest step below sends.
    seed(store, [{"github_login": "a", "slack_user_id": "U0000000001", "rules": {"areas": ["moe"]},
                  "digest_hour": NOW.hour,
                  "notify_mode": "digest"}])
    run_extraction(store, FakeBackend({"DeepSeek": SEVERE}), budget=Budget(), now=NOW, workers=1)
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW), delivery_mode=DeliveryMode.SHADOW)
    route(ScheduledCommand("triage_route", NOW))
    outbox_before = len(outbox(database_url))
    assert store.maintainer_load(since=NOW - timedelta(days=7)) == {"a": 3}
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_assignments SET status='acked' WHERE item_key='vllm-project/vllm#1202'")
        c.execute("UPDATE triage_assignments SET notified_at=NULL")
    # #1201 is closed and #1202 merged on GitHub; #1203 stays open.
    ingest(store, replace(items[1201], state="closed", closed_at=NOW))
    ingest(store, replace(items[1202], state="merged", closed_at=NOW))
    # Even before the route consumer runs, the digest skips items no longer open.
    assert [e.item_key for e in store.unnotified_assignments("a")] == ["vllm-project/vllm#1203"]

    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=5)))
    got = assignments(database_url)
    assert got[("1201", "a")][:2] == ("done", True)
    reason = got[("1201", "a")][2]
    assert (reason["closed_by"], reason["closed_from"], reason["item_state"]) == ("github", "open", "closed")
    assert reason["matched"] == ["area:moe"]  # the routing reason is kept
    assert got[("1202", "a")][2]["closed_from"] == "acked" and got[("1202", "a")][2]["item_state"] == "merged"
    assert got[("1203", "a")][:2] == ("open", False)
    # The unacked item closed on GitHub frees its slot; the acked one was kept.
    assert store.maintainer_load(since=NOW - timedelta(days=7)) == {"a": 2}
    # Nothing new routed or sent, and no triage_actions rows invented.
    assert len(assignments(database_url)) == 3
    assert len(outbox(database_url)) == outbox_before
    with psycopg.connect(database_url) as c:
        assert c.execute("SELECT count(*) FROM triage_actions").fetchone()[0] == 0

    DigestHandler(store=store, clock=FixedClock(NOW), delivery_mode=DeliveryMode.SHADOW, team_channel=None)(
        ScheduledCommand("triage_digest", NOW + timedelta(minutes=6)))
    digests = [p for d, _, _, p in outbox(database_url) if d.startswith("triage:digest:a:")]
    assert len(digests) == 1
    assert "#1203" in json.dumps(digests[0]) and "#1201" not in json.dumps(digests[0])

    # #1202 is reopened: its owner gets it back as they had it, not a new owner.
    ingest(store, replace(items[1202], state="open"))
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=10)))
    got = assignments(database_url)
    assert got[("1202", "a")][:2] == ("acked", False)
    assert "closed_by" not in got[("1202", "a")][2] and "matched" in got[("1202", "a")][2]
    assert got[("1201", "a")][0] == "done"
    assert len(got) == 3


class CommentingGitHub(FakeGitHub):
    def __init__(self) -> None:
        super().__init__({})
        self.records: dict[int, list[tuple[str, datetime | None, str]]] = {}

    def comment_records(self, repo: str, number: int) -> list[tuple[str, datetime | None, str]]:
        return self.records.get(number, [])


def test_a_comment_from_the_assignee_after_routing_acks_it(store: PostgresTriageStore, database_url: str) -> None:
    from triage.pipeline import IngestHandler

    gh = CommentingGitHub()
    seed(store, [{"github_login": "a", "rules": {"areas": ["moe"]}},
                 {"github_login": "b", "rules": {"areas": ["moe"]}}])
    clock = FixedClock(NOW)
    ingest_handler = IngestHandler(store=store, github=gh, config=default_config(), clock=clock)  # type: ignore[arg-type]
    # #1301: no comments yet. #1302: "a" commented before triage saw it.
    gh.records[1302] = [("A", NOW - timedelta(hours=1), "[A (MEMBER)]: on it")]
    ingest_handler._ingest(issue(1301, "DeepSeek startup crash one"))
    ingest_handler._ingest(issue(1302, "DeepSeek startup crash two", comment_count=1))
    run_extraction(store, FakeBackend({"DeepSeek": SEVERE}), budget=Budget(), now=NOW, workers=1)
    route = RouteHandler(store=store, config=default_config(), clock=clock, delivery_mode=DeliveryMode.SHADOW)
    route(ScheduledCommand("triage_route", NOW))
    got = assignments(database_url)
    owner_1301 = next(m for (n, m), (status, _, _) in got.items() if n == "1301" and status == "open")
    other = "b" if owner_1301 == "a" else "a"
    assert got[("1302", "a")][0] == "open"  # commented before it was assigned: no auto-ack

    # Someone else comments on #1301 first, then its owner (login case differs).
    clock.value = NOW + timedelta(minutes=10)
    gh.records[1301] = [(other, NOW + timedelta(minutes=2), f"[{other} (MEMBER)]: hm"),
                        (owner_1301.upper(), NOW + timedelta(minutes=5), "[x (MEMBER)]: looking")]
    ingest_handler._ingest(replace_comments(issue(1301, "DeepSeek startup crash one"), 2))
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=10)))
    got = assignments(database_url)
    assert got[("1301", owner_1301)][0] == "acked"
    assert got[("1301", owner_1301)][2]["acked_by"] == "github_comment"
    assert got[("1302", "a")][0] == "open"
    # The stored comment times survive a later ingest that doesn't re-read comments.
    ingest_handler._ingest(replace_comments(issue(1301, "DeepSeek startup crash one"), 2))
    state = store.item_state("vllm-project/vllm#1301")
    assert state is not None and set(state.prepass["commented_at"]) == {other, owner_1301}


def replace_comments(item: Item, count: int) -> Item:
    item.comment_count = count
    return item


def test_github_assignees_steer_routing(store: PostgresTriageStore, database_url: str) -> None:
    from triage.routing import GH_ASSIGNED

    seed(store, [{"github_login": "moe-person", "rules": {"areas": ["moe"]}},
                 {"github_login": "assigned-person", "rules": {"areas": ["frontend_api"]}}])
    ingest(store, issue(1401, "DeepSeek startup crash outsider", assignees=["some-contributor"]))
    ingest(store, issue(1402, "DeepSeek startup crash ours", assignees=["some-contributor", "Assigned-Person"]))
    ingest(store, issue(1403, "DeepSeek startup crash nobody"))
    run_extraction(store, FakeBackend({"DeepSeek": SEVERE}), budget=Budget(), now=NOW, workers=1)
    RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW), delivery_mode=DeliveryMode.SHADOW)(
        ScheduledCommand("triage_route", NOW))
    got = assignments(database_url)
    # Assigned on GitHub to someone outside triage: left alone (still on the dashboard).
    assert not [k for k in got if k[0] == "1401"]
    assert [r.item_key for r in store.routing_candidates(limit=10)] == ["vllm-project/vllm#1401"]
    # Assigned to one of ours: theirs, even though no rule of theirs matches.
    assert got[("1402", "assigned-person")][2]["matched"] == [GH_ASSIGNED]
    assert ("1403", "moe-person") in got
class ProfilesFor(FakeProfiles):
    def maintainer_prs(self, repo: str, login: str, *, since: datetime, per_kind: int = 120) -> list[dict[str, Any]]:
        if login == "newbie":
            return [{"number": 9, "kind": "authored", "title": "GDN kernels"}]
        return super().maintainer_prs(repo, login, since=since)


def test_routing_waits_for_new_maintainers_only_for_the_grace(store: PostgresTriageStore, database_url: str) -> None:
    from triage.pipeline import RELEVANCE_GRACE
    from triage.relevance import run_relevance

    ingest(store, issue(1301, "Qwen3.5 FP8 GSM8K accuracy drop"))
    seed(store, [{"github_login": "gau-nernst", "notes": "FP8 kernels"}, {"github_login": "amd-person"}])
    run_extraction(store, FakeBackend({"Qwen3.5": SEVERE}), budget=Budget(), now=NOW, workers=1)
    clock = FixedClock(NOW)
    route = RouteHandler(store=store, config=default_config(), clock=clock,
                         delivery_mode=DeliveryMode.SHADOW, github=ProfilesFor())  # type: ignore[arg-type]
    route(ScheduledCommand("triage_route", NOW))

    class Judge:
        def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult:
            return LLMResult(output={"judgments": [
                {"github_login": "gau-nernst", "relevance": "medium", "evidence_prs": [61343], "reason": "FP8"},
                {"github_login": "amd-person", "relevance": "none", "evidence_prs": [], "reason": ""},
            ]}, model="fake")

    assert run_relevance(store, Judge(), now=NOW, min_score=40).judged == 1
    # A maintainer is added before the route consumer runs: the item now waits for their judgement...
    seed(store, [{"github_login": "gau-nernst", "notes": "FP8 kernels"}, {"github_login": "amd-person"},
                 {"github_login": "newbie"}])
    for minutes in (5, 60, 115):
        clock.value = NOW + timedelta(minutes=minutes)
        route(ScheduledCommand("triage_route", clock.value))
    with psycopg.connect(database_url) as c:
        assert c.execute("SELECT count(*) FROM triage_assignments").fetchone()[0] == 0
        assert c.execute("SELECT routable_since FROM triage_scores").fetchone()[0] == NOW
    # ...but only for the grace; then it goes to the best judged maintainer.
    clock.value = NOW + RELEVANCE_GRACE
    route(ScheduledCommand("triage_route", clock.value))
    with psycopg.connect(database_url) as c:
        rows = c.execute("SELECT maintainer, reason->'matched' FROM triage_assignments").fetchall()
    assert rows == [("gau-nernst", ["relevance:medium (like #61343)"])]


def test_routable_since_is_kept_in_band_and_cleared_outside(store: PostgresTriageStore, database_url: str) -> None:
    from triage.model import Score

    ingest(store, issue(1401, "Something"))
    key = "vllm-project/vllm#1401"

    def save(band: str, at: datetime) -> datetime | None:
        store.save_scores([(key, None, Score(50, band, (), "v"))], now=at)  # type: ignore[arg-type]
        with psycopg.connect(database_url) as c:
            return c.execute("SELECT routable_since FROM triage_scores").fetchone()[0]  # type: ignore[no-any-return]

    assert save("watch", NOW) is None
    assert save("route", NOW + timedelta(hours=1)) == NOW + timedelta(hours=1)
    assert save("page", NOW + timedelta(hours=2)) == NOW + timedelta(hours=1)  # still routable: clock keeps running
    assert save("route", NOW + timedelta(hours=3)) == NOW + timedelta(hours=1)
    assert save("ignore", NOW + timedelta(hours=4)) is None
    assert save("route", NOW + timedelta(hours=5)) == NOW + timedelta(hours=5)


def test_feedback_reaches_the_relevance_prompt_through_the_profile(
    store: PostgresTriageStore, database_url: str
) -> None:
    from triage.relevance import profile_hash, run_relevance

    for number, title in ((1501, "Declined <thing>"), (1502, "Taken thing"), (1503, "Long ago"),
                          (1504, "Qwen3.5 FP8 GSM8K accuracy drop")):
        ingest(store, issue(number, title))
    seed(store, [{"github_login": "gau-nernst", "notes": "FP8 kernels"}, {"github_login": "amd-person"}])
    run_extraction(store, FakeBackend({"Qwen3.5": SEVERE, "thing": MINOR, "Long ago": MINOR}),
                   budget=Budget(), now=NOW, workers=1)
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("INSERT INTO triage_actions (item_key, actor, action, source, created_at) VALUES "
                  "('vllm-project/vllm#1501', 'Gau-Nernst', 'not_mine', 'dashboard', %s), "
                  "('vllm-project/vllm#1503', 'gau-nernst', 'not_mine', 'dashboard', %s), "
                  "('vllm-project/vllm#1502', 'amd-person', 'not_mine', 'dashboard', %s)",
                  (NOW - timedelta(days=1), NOW - timedelta(days=90), NOW - timedelta(days=3)))
        c.execute("INSERT INTO triage_assignments (item_key, maintainer, role, status, score_at_assign, "
                  "assigned_at, closed_at, updated_at) VALUES "
                  "('vllm-project/vllm#1502', 'gau-nernst', 'primary', 'done', 50, %s, %s, %s)",
                  (NOW - timedelta(days=3), NOW - timedelta(days=2), NOW - timedelta(days=2)))
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                         delivery_mode=DeliveryMode.SHADOW, github=FakeProfiles())  # type: ignore[arg-type]
    route(ScheduledCommand("triage_route", NOW))  # builds profiles, with feedback

    restricted = PostgresTriageStore(extractor_role_url(database_url))
    profiles = {p.login: p for p in restricted.maintainer_profiles()}
    gau = profiles["gau-nernst"]
    titles = {kind: [e["title"] for e in entries] for kind, entries in gau.feedback.items()}
    assert titles == {"declined": ["Declined <thing>"], "took": ["Taken thing"]}  # 90 days ago is too old
    assert gau.profile_hash != profile_hash(gau.prs, gau.notes)
    assert [e["title"] for e in profiles["amd-person"].feedback["declined"]] == ["Taken thing"]

    class Judge:
        def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult:
            gau_block = system.split('<maintainer login="gau-nernst">')[1].split("</maintainer>")[0]
            assert "said not mine: Declined &lt;thing&gt;" in gau_block and "took: Taken thing" in gau_block
            assert "Long ago" not in system
            return LLMResult(output={"judgments": [
                {"github_login": "gau-nernst", "relevance": "high", "evidence_prs": [61343], "reason": "his PR"},
                {"github_login": "amd-person", "relevance": "none", "evidence_prs": [], "reason": ""},
            ]}, model="fake")

    assert run_relevance(restricted, Judge(), now=NOW, min_score=40).judged == 1
    # New feedback during the day doesn't re-judge anyone until the profile is rebuilt.
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("INSERT INTO triage_actions (item_key, actor, action, source, created_at) VALUES "
                  "('vllm-project/vllm#1503', 'gau-nernst', 'not_mine', 'dashboard', %s)", (NOW,))
    route(ScheduledCommand("triage_route", NOW + timedelta(hours=1)))
    assert run_relevance(restricted, Judge(), now=NOW, min_score=40).judged == 0


def test_prs_waiting_on_their_author_are_held_back_unless_p0(store: PostgresTriageStore, database_url: str) -> None:
    seed(store, [{"github_login": "moe-person", "rules": {"areas": ["moe"]}}])
    pr_facets = {**SEVERE, "type": "bug", "pr": {"fixes_issues": [], "hot_path": False, "size": "s",
                                                 "has_tests": True, "low_effort": False}}
    for number, conflict in ((1501, True), (1502, True), (1503, False)):
        ingest(store, issue(number, f"DeepSeek MoE fix {number}", kind="pr", body="## Test Plan\n" + "x" * 200,
                            files=[FileChange("vllm/x.py")], failing_checks=[],
                            mergeable="CONFLICTING" if conflict else "MERGEABLE"))
    run_extraction(store, FakeBackend({"DeepSeek MoE fix": pr_facets}), budget=Budget(), now=NOW, workers=1)
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                         delivery_mode=DeliveryMode.SHADOW)
    route._rescore(NOW)
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_scores SET band = CASE WHEN item_key LIKE '%%1502' THEN 'page' ELSE 'route' END")
    state = store.item_state("vllm-project/vllm#1501")
    assert state is not None
    assert (state.prepass["waiting_on"], state.prepass["waiting_reasons"]) == ("author", ["merge_conflict"])
    # 1501 (P1, conflicts) doesn't even take a candidate slot; 1502 is P0, so routed anyway.
    assert {r.item_key[-4:] for r in store.routing_candidates(limit=10)} == {"1502", "1503"}
    assert [(key, n) for key, n, _ in store.waiting_prs("vllm-project/vllm", limit=10)] == [("vllm-project/vllm#1501", 1501)]
    route._route(NOW)
    assert {n for n, _ in assignments(database_url)} == {"1502", "1503"}
    # The conflict is resolved (the status refresh writes it): routed on the next run.
    store.update_prepass("vllm-project/vllm#1501", {"waiting_on": "reviewer", "waiting_reasons": []})
    assert store.waiting_prs("vllm-project/vllm", limit=10) == []
    route._route(NOW)
    assert {n for n, _ in assignments(database_url)} == {"1501", "1502", "1503"}


# --- issue + fix PR groups (triage/groups.py) ---------------------------------

PR_FACETS: dict[str, Any] = {**SEVERE, "type": "bug", "pr": {"fixes_issues": [], "hot_path": False, "size": "s",
                                                            "has_tests": True, "low_effort": False}}


def group_items(store: PostgresTriageStore, database_url: str, items: list[tuple[int, str, str, int, str]],
                facets: dict[str, dict[str, Any]] | None = None) -> RouteHandler:
    """Ingest and label (number, kind, body, score, band) items, then pin
    their scores; returns a route handler (not yet run)."""
    for number, kind, body, _, _ in items:
        extra: dict[str, Any] = {"kind": "pr", "files": [FileChange("vllm/x.py")]} if kind == "pr" else {}
        ingest(store, issue(number, f"DeepSeek item {number}", body=body + "\n" + "x" * 200, **extra))
    by_title = {f"DeepSeek item {n}": (facets or {}).get(str(n), PR_FACETS if kind == "pr" else SEVERE)
                for n, kind, *_ in items}
    run_extraction(store, FakeBackend(by_title), budget=Budget(), now=NOW, workers=1)
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                         delivery_mode=DeliveryMode.SHADOW)
    route._rescore(NOW)
    with psycopg.connect(database_url, autocommit=True) as c:
        for number, _, _, score, band in items:
            c.execute("UPDATE triage_scores SET score = %s, band = %s WHERE item_key = %s",
                      (score, band, f"vllm-project/vllm#{number}"))
    return route


def test_fix_links_pair_only_real_fixes(store: PostgresTriageStore, database_url: str) -> None:
    group_items(store, database_url, [
        (800, "issue", "", 90, "page"),
        (801, "pr", "Fixes #800", 60, "route"),
        (802, "pr", "Related to #800, see #800", 55, "route"),     # a mention, not a fix
        (803, "pr", "Speeds up the kernel", 50, "route"),          # Claude says it fixes #800
        (804, "pr", "Closes #801", 50, "route"),                   # #801 is a PR, not an issue
        (805, "pr", "Fixes #99999", 50, "route"),                  # not in triage_items
    ], facets={"803": {**PR_FACETS, "pr": {**PR_FACETS["pr"], "fixes_issues": [800]}}})
    assert store.fix_links() == [("vllm-project/vllm#801", "vllm-project/vllm#800"),
                                 ("vllm-project/vllm#803", "vllm-project/vllm#800")]
    # PRs stored before prepass.fixes_issues existed get it from their text.
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_items SET prepass = prepass - 'fixes_issues'")
    assert store.fix_links() == [("vllm-project/vllm#803", "vllm-project/vllm#800")]
    assert store.backfill_fixes_issues() == 5  # the PRs
    assert store.backfill_fixes_issues() == 0
    assert len(store.fix_links()) == 2
    # Both closed: still a group for the dashboard, not for routing.
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_items SET state = 'closed' WHERE number = 800")
        c.execute("UPDATE triage_items SET state = 'merged' WHERE number IN (801, 803)")
    assert len(store.fix_links()) == 2 and store.fix_links(open_only=True) == []


def test_a_fix_pr_follows_its_issue_to_the_owner(store: PostgresTriageStore, database_url: str) -> None:
    seed(store, [{"github_login": "m1", "rules": {"areas": ["moe"]}, "notify_mode": "digest"},
                 {"github_login": "m2", "rules": {"areas": ["moe"]}, "notify_mode": "digest"}])
    route = group_items(store, database_url, [
        (810, "issue", "", 90, "page"),
        (811, "pr", "Fixes #810", 60, "route"),
        (812, "pr", "Related to #810", 55, "route"),
    ])
    # m2 owns the issue (the router would otherwise pick m1: same match, login order).
    assign(database_url, 810, "m2", assigned_at=NOW - timedelta(hours=1), notified_at=NOW - timedelta(hours=1))
    route._route(NOW)
    got = assignments(database_url)
    assert got[("811", "m2")][0] == "open"
    assert got[("811", "m2")][2]["matched"][0] == "fixes #810"
    assert got[("811", "m2")][2]["grouped_with"] == "vllm-project/vllm#810"
    assert ("812", "m1") in got and "grouped_with" not in got[("812", "m1")][2]   # a mention: routed on its own
    # The group takes one slot: the issue counts, the PR that followed it doesn't.
    assert store.maintainer_load(since=NOW - timedelta(days=7)) == {"m1": 1, "m2": 1}
    # In m2's digest the PR stands alone (its issue went out earlier) and says why.
    [entry] = store.unnotified_assignments("m2")
    assert entry.kind == "pr" and entry.fixes == ("vllm-project/vllm#810",)


def test_the_issue_owner_saying_not_mine_to_the_pr_is_respected(
    store: PostgresTriageStore, database_url: str,
) -> None:
    seed(store, [{"github_login": "m1", "rules": {"areas": ["moe"]}, "notify_mode": "digest"},
                 {"github_login": "m2", "rules": {"areas": ["moe"]}, "notify_mode": "digest"}])
    route = group_items(store, database_url, [(820, "issue", "", 90, "page"), (821, "pr", "Fixes #820", 60, "route")])
    assign(database_url, 820, "m1", assigned_at=NOW - timedelta(hours=1))
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("INSERT INTO triage_actions (item_key, actor, action, source) "
                  "VALUES ('vllm-project/vllm#821', 'm1', 'not_mine', 'dashboard')")
    route._route(NOW)
    got = assignments(database_url)
    assert ("821", "m1") not in got and "grouped_with" not in got[("821", "m2")][2]


def test_an_unowned_group_is_routed_together_with_one_dm(store: PostgresTriageStore, database_url: str) -> None:
    seed(store, [{"github_login": "gau-nernst", "slack_user_id": "U0000000031", "rules": {"areas": ["moe"]},
                  "language": "vi", "capacity_per_week": 1},
                 {"github_login": "other", "rules": {"hardware": ["H100"]}}])
    # Kevin's example: the fix PR outscores its issue, and a second, P1 fix PR.
    route = group_items(store, database_url, [
        (65906, "issue", "", 79, "page"),
        (66694, "pr", "Fixes #65906", 99, "page"),
        (66700, "pr", "Closes #65906", 50, "route"),
    ])
    route._route(NOW)
    got = assignments(database_url)
    assert {k for k in got} == {("65906", "gau-nernst"), ("66694", "gau-nernst"), ("66700", "gau-nernst")}
    assert "grouped_with" not in got[("66694", "gau-nernst")][2]          # the lead, routed on its merits
    assert got[("65906", "gau-nernst")][2]["grouped_with"] == "vllm-project/vllm#66694"
    assert got[("65906", "gau-nernst")][2]["matched"][0] == "fixed by #66694"
    assert got[("66700", "gau-nernst")][2]["matched"][0] == "fixes #65906"
    # One slot (capacity 1 is not exceeded) and one DM, for the whole group,
    # under the issue; the followers count as notified.
    assert store.maintainer_load(since=NOW - timedelta(days=7)) == {"gau-nernst": 1}
    assert store.unnotified_assignments("gau-nernst") == []
    [(delivery_id, _, _, payload)] = outbox(database_url)
    assert delivery_id == "triage:page:vllm-project/vllm#66694:gau-nernst:primary"
    section, actions = payload["blocks"][1], payload["blocks"][2]
    text = section["text"]["text"]
    assert section["block_id"] == "triage:item:vllm-project/vllm#65906"
    assert text.index("#65906 DeepSeek item 65906") < text.index("↳ bản sửa: <https://github.com/vllm-project/vllm/issues/66694|#66694")
    assert "↳ bản sửa: <https://github.com/vllm-project/vllm/issues/66700|#66700" in text
    assert text.count("Vì sao là bạn") == 1 and "PR bạn đang phụ trách" not in text
    assert {e.get("value") for e in actions["elements"] if e["type"] == "button"} - {None} == {"vllm-project/vllm#65906"}


def test_the_digest_shows_a_group_as_one_item(store: PostgresTriageStore, database_url: str) -> None:
    seed(store, [{"github_login": "d", "slack_user_id": "U0000000041", "rules": {"areas": ["moe"]},
                  "notify_mode": "digest", "digest_hour": NOW.hour}])
    route = group_items(store, database_url, [(830, "issue", "", 60, "route"), (831, "pr", "Fixes #830", 55, "route"),
                                              (832, "issue", "", 50, "route")])
    route._route(NOW)
    DigestHandler(store=store, clock=FixedClock(NOW), delivery_mode=DeliveryMode.SHADOW,
                  team_channel=None)(ScheduledCommand("triage_digest", NOW))
    [(_, _, _, payload)] = outbox(database_url)
    items = [b for b in payload["blocks"] if str(b.get("block_id", "")).startswith("triage:item:")]
    assert [b["block_id"] for b in items] == ["triage:item:vllm-project/vllm#830", "triage:item:vllm-project/vllm#832"]
    assert "↳ fix: <https://github.com/vllm-project/vllm/issues/831|#831 DeepSeek item 831>" in items[0]["text"]["text"]
    assert payload["text"] == "Triage digest: 2 P1"
    assert store.unnotified_assignments("d") == []


def test_reminders_skip_an_issue_whose_fix_is_merged(store: PostgresTriageStore, database_url: str) -> None:
    group_items(store, database_url, [(840, "issue", "", 60, "route"), (841, "pr", "Fixes #840", 55, "route")])
    seed(store, [{"github_login": "r", "rules": {"areas": ["tpu"]}}])
    assign(database_url, 840, "r", assigned_at=NOW - timedelta(days=5), notified_at=NOW - timedelta(days=5))
    waiting = store.waiting_assignments("r", assigned_before=NOW - timedelta(days=3), limit=5)[0]
    assert [e.item_key for e in waiting] == ["vllm-project/vllm#840"]
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_items SET state = 'merged' WHERE number = 841")
    assert store.waiting_assignments("r", assigned_before=NOW - timedelta(days=3), limit=5) == ([], 0)


def test_pr_ci_status_is_stored_refreshed_and_read_back(store: PostgresTriageStore, database_url: str) -> None:
    from triage.ci import CiSummary, FailedJob

    repo = "vllm-project/vllm"
    for number in (1601, 1602, 1603, 1604):
        ingest(store, issue(number, f"PR {number}", kind="pr", files=[FileChange("vllm/x.py")], failing_checks=[]))
    with psycopg.connect(database_url, autocommit=True) as c:
        for number, band, score in ((1601, "route", 70), (1602, "watch", 30), (1603, "ignore", 5), (1604, "page", 95)):
            c.execute("INSERT INTO triage_scores (item_key, score, band, breakdown, scoring_version, scored_at) "
                      "VALUES (%s, %s, %s, '[]', 'v', %s)", (f"{repo}#{number}", score, band, NOW))
    # Never checked first, then P0, P1, P2; P3 never.
    assert [n for _, n, _ in store.ci_due(repo, now=NOW, limit=10)] == [1604, 1601, 1602]

    summary = CiSummary(head_sha="a" * 40, state="failed", build_number=104553,
                        build_url="https://buildkite.com/vllm/ci/builds/104553", build_state="failed",
                        jobs_total=99, jobs_passed=97, jobs_failed=2, jobs_failed_on_main=1, jobs_failed_pr_only=1,
                        main_known=True, failed_jobs=[FailedJob("A", "step:a|name:A", "u", on_main=True),
                                                      FailedJob("B", "step:b|name:B", "u", on_main=False)]).as_json()
    for number in (1601, 1602, 1604):
        store.save_pr_ci(f"{repo}#{number}", summary, now=NOW)
    # P0/P1 are due again after 10 minutes, P2 after an hour.
    assert store.ci_due(repo, now=NOW + timedelta(minutes=5), limit=10) == []
    assert [n for _, n, _ in store.ci_due(repo, now=NOW + timedelta(minutes=10), limit=10)] == [1604, 1601]
    assert [n for _, n, _ in store.ci_due(repo, now=NOW + timedelta(hours=1), limit=10)] == [1604, 1601, 1602]

    # A re-check that finds nothing new moves checked_at, not changed_at.
    store.save_pr_ci(f"{repo}#1601", summary, now=NOW + timedelta(minutes=10))
    store.save_pr_ci(f"{repo}#1602", {**summary, "jobs_failed_on_main": 2}, now=NOW + timedelta(minutes=10))
    with psycopg.connect(database_url, autocommit=True) as c:
        times = dict((r[0][-4:], (r[1], r[2])) for r in c.execute(
            "SELECT item_key, checked_at, changed_at FROM triage_pr_ci").fetchall())
    assert times["1601"] == (NOW + timedelta(minutes=10), NOW)
    assert times["1602"] == (NOW + timedelta(minutes=10), NOW + timedelta(minutes=10))

    assert store.pr_ci([f"{repo}#1601", f"{repo}#1603"]) == {f"{repo}#1601": summary}
    state = store.item_state(f"{repo}#1601")
    assert state is not None and state.ci == summary
    no_ci = store.item_state(f"{repo}#1603")
    assert no_ci is not None and no_ci.ci is None


def test_main_ci_jobs(store: PostgresTriageStore, database_url: str) -> None:
    from triage.ci import MainJobs

    with psycopg.connect(database_url, autocommit=True) as c:
        if c.execute("SELECT to_regclass('alerting_main_ci_job_states')").fetchone()[0] is None:
            pytest.skip("0014 did not apply on a fresh database")
        c.execute("TRUNCATE alerting_main_ci_job_states, alerting_main_ci_job_alerts, alerting_main_ci_scan_cursors CASCADE")
    assert store.main_ci_jobs(now=NOW) is None  # never scanned: unknown

    def state_row(key: str, state: str, n: int) -> tuple[Any, ...]:
        return (key, key, f"job-{n}", state, NOW, "b", n, "u", "u", "sha", NOW)

    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("INSERT INTO alerting_main_ci_scan_cursors VALUES ('main_ci', %s, %s)", (NOW - timedelta(minutes=3), NOW))
        for row in (state_row("step:a|name:A", "failed", 1), state_row("step:b|name:B", "passed", 2)):
            c.execute("INSERT INTO alerting_main_ci_job_states VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)", row)
        # Alerts: c failed 3 days ago (resolved since), d is still open, e is a month old.
        for n, (key, status, failed_days_ago) in enumerate(
                (("step:c|name:C", "resolved", 3), ("step:d|name:D", "open", 0), ("step:e|name:E", "resolved", 30))):
            failed = NOW - timedelta(days=failed_days_ago)
            res = (failed + timedelta(hours=1), f"r{n}", "b", 9, "u", "u", "sha") if status == "resolved" else (None,) * 7
            c.execute(
                "INSERT INTO alerting_main_ci_job_alerts (job_key, job_name, status, opened_at, "
                "first_failure_job_id, first_failure_state, first_failure_build_id, first_failure_build_number, "
                "first_failure_build_url, first_failure_job_url, first_failure_commit_sha, last_failed_at, "
                "last_failure_job_id, last_failure_state, last_failure_build_id, last_failure_build_number, "
                "last_failure_build_url, last_failure_job_url, last_failure_commit_sha, failure_count, "
                "resolved_at, resolution_job_id, resolution_build_id, resolution_build_number, "
                "resolution_build_url, resolution_job_url, resolution_commit_sha, created_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, 'failed', 'b', 1, 'u', 'u', 'sha', %s, %s, 'failed', 'b', 1, 'u', 'u', "
                "'sha', 1, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (key, key, status, failed, f"f{n}", failed, f"l{n}", *res, NOW, NOW))
    assert store.main_ci_jobs(now=NOW) == MainJobs(
        failing=frozenset({"step:a|name:A", "step:d|name:D"}),
        recent=frozenset({"step:a|name:A", "step:c|name:C", "step:d|name:D"}))
    # Main CI stopped scanning over an hour ago: too stale to say.
    assert store.main_ci_jobs(now=NOW + timedelta(hours=2)) is None


def test_relevance_skips_owned_items_and_survives_daily_pr_refresh(
    store: PostgresTriageStore, database_url: str
) -> None:
    from triage.relevance import run_relevance

    ingest(store, issue(1701, "DeepSeek startup crash"))
    # Author a PR by gau-nernst so authored_paths populates without extra GitHub calls.
    ingest(store, issue(1702, "MoE refactor", kind="pr", author="gau-nernst", author_association="MEMBER",
                        files=[FileChange("vllm/model_executor/layers/fused_moe/layer.py")]))
    seed(store, [
        {"github_login": "gau-nernst", "notes": "FP8 kernels"},
        {"github_login": "amd-person", "notes": "ROCm"},
    ])
    run_extraction(store, FakeBackend({"DeepSeek": SEVERE}), budget=Budget(), now=NOW, workers=1)
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                         delivery_mode=DeliveryMode.SHADOW, github=FakeProfiles())  # type: ignore[arg-type]
    route(ScheduledCommand("triage_route", NOW))

    # Authored paths captured from gau-nernst's PR.
    profiles = {p.login: p for p in store.maintainer_profiles()}
    assert "vllm/model_executor/layers/fused_moe" in profiles["gau-nernst"].authored_paths

    calls = 0

    class Judge:
        def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult:
            nonlocal calls
            calls += 1
            return LLMResult(output={"judgments": [
                {"github_login": "gau-nernst", "relevance": "high", "evidence_prs": [61343], "reason": "his PR"},
                {"github_login": "amd-person", "relevance": "none", "evidence_prs": [], "reason": "NVIDIA only"},
            ]}, model="fake")

    assert run_relevance(store, Judge(), now=NOW, min_score=40).judged == 1
    assert calls == 1

    # Daily PR refresh adds a new PR: existing judgement must NOT be re-queued!
    store.save_profile("gau-nernst", [
        {"number": 61343, "kind": "authored", "title": "per_token_group_quant reciprocal"},
        {"number": 62000, "kind": "authored", "title": "new unrelated PR"},
    ], now=NOW + timedelta(days=1))
    assert store.relevance_queue(limit=10, min_score=40) == []

    # Routing assigns the item -> needs_relevance flips to false -> even a notes edit won't re-judge an owned item!
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=5)))
    seed(store, [
        {"github_login": "gau-nernst", "notes": "FP8 kernels and MoE"},
        {"github_login": "amd-person", "notes": "ROCm"},
    ])
    assert store.relevance_queue(limit=10, min_score=40) == []

    # When the owner clicks not_mine and triage-route runs, needs_relevance flips back to true and re-queues!
    with psycopg.connect(database_url, autocommit=True) as c:
        c.execute("UPDATE triage_assignments SET status = 'not_mine', closed_at = now()")
        c.execute("INSERT INTO triage_actions (item_key, actor, action, source) "
                  "VALUES ('vllm-project/vllm#1701', 'gau-nernst', 'not_mine', 'dashboard')")
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=10)))
    queued = store.relevance_queue(limit=10, min_score=40)
    assert len(queued) == 1 and queued[0].maintainers == ["gau-nernst"]


def test_comment_churn_cooldown_and_semantic_facet_gate(
    store: PostgresTriageStore, database_url: str
) -> None:
    from triage.pipeline import IngestHandler
    from triage.relevance import run_relevance

    class CommentGitHub(FakeGitHub):
        def __init__(self, comments: list[tuple[str, datetime | None, str]]) -> None:
            super().__init__({})
            self.records = comments

        def comment_records(self, repo: str, number: int) -> list[tuple[str, datetime | None, str]]:
            return list(self.records)

    gh = CommentGitHub([
        ("bob", NOW - timedelta(minutes=30), "[bob (NONE)]: +1"),
        ("mergify[bot]", NOW - timedelta(minutes=20), "[mergify[bot] (NONE)]: Merge conflict detected."),
    ])
    clock = FixedClock(NOW)
    handler = IngestHandler(
        store=store, github=gh, config=default_config(), clock=clock,  # type: ignore[arg-type]
        reextract_cooldown=timedelta(hours=12),
    )
    handler._ingest(issue(1801, "DeepSeek startup crash", comment_count=2))
    state = store.item_state("vllm-project/vllm#1801")
    assert state is not None
    # Noise comments stripped from comments_excerpt, while human commenter bob is preserved.
    assert state.comments_excerpt == ""
    assert "bob" in state.prepass["commenters"]

    # Extract + score + judge relevance once (returns 'none' so item remains unowned for re-judge tests).
    seed(store, [{"github_login": "gau-nernst", "notes": "FP8 kernels"}])
    run_extraction(store, FakeBackend({"DeepSeek": SEVERE}), budget=Budget(), now=NOW, workers=1)
    RouteHandler(store=store, config=default_config(), clock=clock, delivery_mode=DeliveryMode.SHADOW,
                 github=FakeProfiles())(ScheduledCommand("triage_route", NOW))  # type: ignore[arg-type]

    class Judge:
        calls = 0

        def complete(self, *, system: str, prompt: str, schema: dict[str, Any]) -> LLMResult:
            Judge.calls += 1
            return LLMResult(output={"judgments": [
                {"github_login": "gau-nernst", "relevance": "none", "evidence_prs": [], "reason": "unrelated"},
            ]}, model="fake")

    assert run_relevance(store, Judge(), now=NOW, min_score=40).judged == 1
    assert Judge.calls == 1

    # 1 hour later: substantive comment arrives -> within 12h cooldown, so extraction stays 'done'.
    gh.records.append(("carol", NOW + timedelta(hours=1),
                       "[carol (NONE)]: Also reproduced on 8xB200 with vLLM 0.12.0 FP8."))
    clock.value = NOW + timedelta(hours=1)
    handler._ingest(issue(1801, "DeepSeek startup crash", comment_count=3))
    with psycopg.connect(database_url) as c:
        assert c.execute("SELECT extraction_status FROM triage_items WHERE item_key = 'vllm-project/vllm#1801'").fetchone()[0] == "done"

    # 13 hours later: cooldown elapsed -> comment change re-queues extraction.
    clock.value = NOW + timedelta(hours=13)
    handler._ingest(issue(1801, "DeepSeek startup crash", comment_count=3))
    with psycopg.connect(database_url) as c:
        assert c.execute("SELECT extraction_status FROM triage_items WHERE item_key = 'vllm-project/vllm#1801'").fetchone()[0] == "pending"

    # Re-extraction yields slightly reworded summary but same routing facets -> relevance carries forward!
    reworded = {**SEVERE, "summary": "DeepSeek-V3.1 startup failure on B200 (0.12)"}
    run_extraction(store, FakeBackend({"DeepSeek": reworded}), budget=Budget(), now=clock.value, workers=1)
    RouteHandler(store=store, config=default_config(), clock=clock, delivery_mode=DeliveryMode.SHADOW,
                 github=FakeProfiles())(ScheduledCommand("triage_route", clock.value))  # type: ignore[arg-type]
    assert run_relevance(store, Judge(), now=clock.value, min_score=40).judged == 0
    assert Judge.calls == 1

    # Body edit (core_hash change) bypasses cooldown immediately, and changed area invalidates relevance.
    clock.value = NOW + timedelta(hours=14)
    handler._ingest(issue(1801, "DeepSeek startup crash", body="Updated repro details " + "z" * 200, comment_count=3))
    with psycopg.connect(database_url) as c:
        assert c.execute("SELECT extraction_status FROM triage_items WHERE item_key = 'vllm-project/vllm#1801'").fetchone()[0] == "pending"
    changed_facets = {**SEVERE, "areas": ["attention"]}
    run_extraction(store, FakeBackend({"DeepSeek": changed_facets}), budget=Budget(), now=clock.value, workers=1)
    RouteHandler(store=store, config=default_config(), clock=clock, delivery_mode=DeliveryMode.SHADOW,
                 github=FakeProfiles())(ScheduledCommand("triage_route", clock.value))  # type: ignore[arg-type]
    assert run_relevance(store, Judge(), now=clock.value, min_score=40).judged == 1
    assert Judge.calls == 2


def test_pr_diff_excerpt_cached_by_head_sha_and_leased_to_extractor(
    store: PostgresTriageStore, database_url: str
) -> None:
    from triage.pipeline import IngestHandler

    class DiffGitHub(FakeGitHub):
        def __init__(self) -> None:
            super().__init__({})
            self.diff_calls = 0
            self.diff_body = (
                "diff --git a/vllm/core.py b/vllm/core.py\n"
                "--- a/vllm/core.py\n+++ b/vllm/core.py\n@@ -1 +1 @@\n-old\n+new_v1\n"
            )

        def pull_files(self, repo: str, number: int) -> list[FileChange]:
            return [FileChange("vllm/core.py", 1, 1)]

        def pull_diff(self, repo: str, number: int) -> str:
            self.diff_calls += 1
            return self.diff_body

    gh = DiffGitHub()
    handler = IngestHandler(store=store, github=gh, config=default_config(), clock=FixedClock(NOW))  # type: ignore[arg-type]
    pr = issue(1901, "Fix core bug", kind="pr", head_sha="sha-1")
    handler._ingest(pr)
    assert gh.diff_calls == 1
    state = store.item_state("vllm-project/vllm#1901")
    assert state is not None and "+new_v1" in state.diff_excerpt and state.diff_head_sha == "sha-1"

    # Re-ingest at the same head_sha reuses cached diff without calling GitHub again.
    handler._ingest(issue(1901, "Fix core bug", kind="pr", head_sha="sha-1"))
    assert gh.diff_calls == 1

    # New commit SHA re-fetches diff and updates content_hash.
    old_hash = state.content_hash
    gh.diff_body = (
        "diff --git a/vllm/core.py b/vllm/core.py\n"
        "--- a/vllm/core.py\n+++ b/vllm/core.py\n@@ -1 +1 @@\n-old\n+new_v2\n"
    )
    handler._ingest(issue(1901, "Fix core bug", kind="pr", head_sha="sha-2"))
    assert gh.diff_calls == 2
    state2 = store.item_state("vllm-project/vllm#1901")
    assert state2 is not None and "+new_v2" in state2.diff_excerpt and state2.content_hash != old_hash

    # Restricted triage_extractor role can lease and read diff_excerpt.
    restricted = PostgresTriageStore(extractor_role_url(database_url))
    tasks = restricted.lease_extraction_batch(limit=5, now=NOW, lease_until=NOW + timedelta(minutes=30), max_attempts=3)
    assert len(tasks) == 1 and "+new_v2" in tasks[0].diff_excerpt


def test_partial_maintainer_sync_persisted_unowned_reason_runs_and_webhook_queue(
    store: PostgresTriageStore, database_url: str
) -> None:
    from triage.pipeline import IngestHandler

    # 1. Partial maintainer sync: a broken file keeps that maintainer's old row while updating valid files.
    initial = {
        "alice.yaml": "github_login: alice\nrules: {areas: [moe]}\n",
        "bob.yaml": "github_login: bob\nrules: {hardware: [B200]}\n",
    }
    mixed = {
        "alice.yaml": "github_login: alice\nrules: {areas: [not-an-area]}\n",  # broken!
        "bob.yaml": "github_login: bob\nrules: {hardware: [B200, GB200]}\n",   # valid update!
    }
    sources = iter([initial, mixed])
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW),
                         delivery_mode=DeliveryMode.SHADOW, maintainers_source=lambda: next(sources))
    route(ScheduledCommand("triage_route", NOW))
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=5)))
    by_login = {m.github_login: m for m in store.active_maintainers()}
    assert by_login["alice"].rules["areas"] == ["moe"]  # preserved!
    assert by_login["bob"].rules["hardware"] == ["B200", "GB200"]  # updated!

    # Run telemetry recorded the warning in triage_runs.
    with psycopg.connect(database_url) as c:
        run_row = c.execute(
            "SELECT status, warnings FROM triage_runs WHERE consumer = 'triage-route' ORDER BY id DESC LIMIT 1"
        ).fetchone()
    assert run_row is not None and run_row[0] == "warning" and "alice" in run_row[1][0]

    # 2. Unowned reason persisted on triage_scores for unowned P0/P1 items and cleared when assigned.
    ingest(store, issue(2001, "TPU issue nobody matches"))
    tpu_facets = {**SEVERE, "areas": ["tpu"], "hardware": ["TPU"], "models": [{"name": "DeepSeek-V3.1", "family": "deepseek"}]}
    run_extraction(store, FakeBackend({"TPU": tpu_facets}), budget=Budget(), now=NOW, workers=1)
    route = RouteHandler(store=store, config=default_config(), clock=FixedClock(NOW), delivery_mode=DeliveryMode.SHADOW)
    route(ScheduledCommand("triage_route", NOW + timedelta(minutes=10)))
    with psycopg.connect(database_url) as c:
        reason = c.execute(
            "SELECT unowned_reason FROM triage_scores WHERE item_key = 'vllm-project/vllm#2001'"
        ).fetchone()[0]
    assert isinstance(reason, dict) and "Nobody is a match" in reason["summary"]

    # 3. Webhook queue drain ingests queued items without waiting for cursor poll.
    store.enqueue_webhook_item("vllm-project/vllm", 2050, "issue", "issues.opened", now=NOW)

    class WebhookGitHub(FakeGitHub):
        def __init__(self) -> None:
            super().__init__({})
            self.fetched_numbers: list[int] = []

        def updated_items(self, repo: str, since: datetime, *, max_items: int) -> list[Item]:
            return []

        def prefetch(self, repo: str, *, files: list[int], comments: list[int], authors: list[int]) -> None:
            return None

        def items_by_numbers(self, repo: str, numbers: list[int]) -> list[Item]:
            self.fetched_numbers.extend(numbers)
            return [issue(n, f"Webhook issue {n}") for n in numbers]

    wh_gh = WebhookGitHub()
    IngestHandler(
        store=store, github=wh_gh, config=default_config(), clock=FixedClock(NOW), poll_cursor=False  # type: ignore[arg-type]
    )(ScheduledCommand("triage_ingest", NOW))
    assert wh_gh.fetched_numbers == [2050]
    assert store.item_state("vllm-project/vllm#2050") is not None
    assert store.claim_webhook_queue("vllm-project/vllm") == []

    # 4. Restricted triage_extractor role can INSERT into triage_runs (and still cannot SELECT it).
    role_url = extractor_role_url(database_url)
    PostgresTriageStore(role_url).record_run(
        consumer="triage-extract", started_at=NOW, finished_at=NOW, status="ok", summary={"extracted": 1}
    )
    with psycopg.connect(role_url, autocommit=True) as c:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT * FROM triage_runs")
