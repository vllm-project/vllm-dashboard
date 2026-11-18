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
    def __init__(self, authors: dict[int, str]) -> None:
        self.authors = authors
        self.lookups: list[int] = []

    def pull_author(self, repo: str, number: int) -> str | None:
        self.lookups.append(number)
        return self.authors.get(number)

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
