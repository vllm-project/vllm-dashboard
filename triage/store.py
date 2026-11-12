"""Postgres adapter for every triage table (schema: 0038_triage.sql).

Extends the alerting store so triage consumers share its execution claims
and notification outbox (alert_path='triage'). The extractor host uses only
the extraction methods, under a restricted database role (see
deploy/triage-extractor/README.md).
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from alerting.ports import NotificationIntent
from alerting.postgres import PostgresAlertStore

from triage.extract import ExtractionTask, LLMResult
from triage.model import Item, Maintainer, Score
from triage.prepass import BODY_LIMIT, COMMENTS_LIMIT, MAX_FILES


@dataclass(frozen=True)
class StoredItemState:
    content_hash: str
    comment_count: int
    gh_updated_at: datetime
    files: list[dict[str, Any]]
    comments_excerpt: str
    prepass: dict[str, Any]


@dataclass(frozen=True)
class ScoringRow:
    item_key: str
    number: int
    kind: str
    title: str
    state: str
    draft: bool
    reactions: int
    comment_count: int
    prepass: dict[str, Any]
    files: list[str]
    extraction_id: int | None
    facets: dict[str, Any] | None


@dataclass(frozen=True)
class RoutingRow:
    item_key: str
    kind: str
    title: str
    html_url: str
    score: int
    band: str
    facets: dict[str, Any]
    prepass: dict[str, Any]
    files: list[str]
    excluded: frozenset[str]


@dataclass(frozen=True)
class NewAssignment:
    maintainer: str
    role: str
    reason: dict[str, Any]
    notification: NotificationIntent | None


@dataclass(frozen=True)
class DigestEntry:
    assignment_id: int
    item_key: str
    title: str
    html_url: str
    score: int
    band: str
    summary: str
    matched: list[str]


class PostgresTriageStore(PostgresAlertStore):
    def __init__(self, connection_factory: Callable[[], Any] | str) -> None:
        if isinstance(connection_factory, str):
            url = connection_factory
            import psycopg

            def factory() -> Any:
                return psycopg.connect(url, autocommit=True, prepare_threshold=None)

            connection_factory = factory
        super().__init__(connection_factory)

    # --- cursors ---------------------------------------------------------------

    def cursor(self, name: str) -> datetime | None:
        with self._connection_factory() as c:
            row = c.execute("SELECT value FROM triage_cursors WHERE name = %s", (name,)).fetchone()
        return row[0] if row else None

    def set_cursor(self, name: str, value: datetime) -> None:
        with self._connection_factory() as c:
            c.execute(
                """INSERT INTO triage_cursors (name, value) VALUES (%s, %s)
                   ON CONFLICT (name) DO UPDATE SET value = GREATEST(triage_cursors.value, EXCLUDED.value),
                   updated_at = now()""",
                (name, value),
            )

    # --- ingest ----------------------------------------------------------------

    def item_state(self, item_key: str) -> StoredItemState | None:
        with self._connection_factory() as c:
            row = c.execute(
                """SELECT content_hash, comment_count, gh_updated_at, files, comments_excerpt, prepass
                   FROM triage_items WHERE item_key = %s""",
                (item_key,),
            ).fetchone()
        return StoredItemState(row[0], row[1], row[2], list(row[3]), row[4], dict(row[5])) if row else None

    def upsert_item(
        self,
        item: Item,
        *,
        prepass: dict[str, Any],
        priority: int,
        content_hash: str,
        in_scope: bool,
        comments_excerpt: str,
    ) -> None:
        files = [
            {"path": f.path, "additions": f.additions, "deletions": f.deletions}
            for f in item.files[:MAX_FILES]
        ]
        with self._connection_factory() as c:
            c.execute(
                """
                INSERT INTO triage_items (
                    item_key, repo, number, kind, title, body_excerpt, comments_excerpt,
                    author, author_association, state, draft, html_url, labels, files,
                    reactions, comment_count, gh_created_at, gh_updated_at, gh_closed_at,
                    prepass, prepass_priority, content_hash, in_scope, extraction_status
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s,%s,
                          %s::jsonb,%s,%s,%s, CASE WHEN %s THEN 'pending' ELSE 'skipped' END)
                ON CONFLICT (item_key) DO UPDATE SET
                    title = EXCLUDED.title,
                    body_excerpt = EXCLUDED.body_excerpt,
                    comments_excerpt = EXCLUDED.comments_excerpt,
                    author_association = EXCLUDED.author_association,
                    state = EXCLUDED.state,
                    draft = EXCLUDED.draft,
                    labels = EXCLUDED.labels,
                    files = EXCLUDED.files,
                    reactions = EXCLUDED.reactions,
                    comment_count = EXCLUDED.comment_count,
                    gh_updated_at = EXCLUDED.gh_updated_at,
                    gh_closed_at = EXCLUDED.gh_closed_at,
                    prepass = EXCLUDED.prepass,
                    prepass_priority = EXCLUDED.prepass_priority,
                    in_scope = EXCLUDED.in_scope,
                    content_hash = EXCLUDED.content_hash,
                    -- New text re-queues extraction; unchanged text keeps its status.
                    extraction_status = CASE
                        WHEN NOT EXCLUDED.in_scope THEN 'skipped'
                        WHEN triage_items.content_hash <> EXCLUDED.content_hash
                             OR triage_items.extraction_status = 'skipped' THEN 'pending'
                        ELSE triage_items.extraction_status END,
                    extraction_attempts = CASE
                        WHEN triage_items.content_hash <> EXCLUDED.content_hash THEN 0
                        ELSE triage_items.extraction_attempts END
                """,
                (
                    item.key, item.repo, item.number, item.kind, item.title,
                    item.body[:BODY_LIMIT], comments_excerpt[:COMMENTS_LIMIT],
                    item.author, item.author_association, item.state, item.draft,
                    item.html_url, json.dumps(item.labels), json.dumps(files),
                    item.reactions, item.comment_count, item.created_at, item.updated_at,
                    item.closed_at, json.dumps(prepass), priority, content_hash, in_scope,
                    in_scope,
                ),
            )

    # --- extraction (extractor host) -----------------------------------------

    def lease_extraction_batch(
        self, *, limit: int, now: datetime, lease_until: datetime, max_attempts: int
    ) -> list[ExtractionTask]:
        with self._connection_factory() as c:
            with c.transaction():
                rows = c.execute(
                    """
                    UPDATE triage_items SET extraction_status = 'running',
                        extraction_lease_until = %s,
                        extraction_attempts = extraction_attempts + 1
                    WHERE item_key IN (
                        SELECT item_key FROM triage_items
                        WHERE in_scope
                          AND extraction_attempts < %s
                          AND (extraction_status IN ('pending', 'failed')
                               OR (extraction_status = 'running' AND extraction_lease_until < %s))
                        ORDER BY prepass_priority DESC, gh_created_at DESC
                        LIMIT %s
                        FOR UPDATE SKIP LOCKED)
                    RETURNING item_key, kind, title, body_excerpt, comments_excerpt,
                              author_association, state, labels, files, prepass, content_hash
                    """,
                    (lease_until, max_attempts, now, limit),
                ).fetchall()
        return [
            ExtractionTask(
                item_key=r[0], kind=r[1], title=r[2], body=r[3], comments=r[4],
                author_association=r[5], state=r[6], labels=list(r[7]), files=list(r[8]),
                prepass=dict(r[9]), content_hash=r[10],
            )
            for r in rows
        ]

    def save_extraction(
        self, task: ExtractionTask, *, facets: dict[str, Any], result: LLMResult,
        prompt_version: str, now: datetime,
    ) -> None:
        with self._connection_factory() as c:
            with c.transaction():
                c.execute(
                    """INSERT INTO triage_extractions (item_key, content_hash, prompt_version, model,
                           facets, input_tokens, output_tokens, duration_ms, created_at)
                       VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s)
                       ON CONFLICT (item_key, content_hash, prompt_version) DO UPDATE SET
                           facets = EXCLUDED.facets, model = EXCLUDED.model, created_at = EXCLUDED.created_at""",
                    (task.item_key, task.content_hash, prompt_version, result.model, json.dumps(facets),
                     result.input_tokens, result.output_tokens, result.duration_ms, now),
                )
                # If the item changed while we read it, leave it pending for another pass.
                c.execute(
                    """UPDATE triage_items SET
                           extraction_status = CASE WHEN content_hash = %s THEN 'done' ELSE 'pending' END,
                           extraction_lease_until = NULL, extraction_error = NULL
                       WHERE item_key = %s""",
                    (task.content_hash, task.item_key),
                )

    def mark_extraction_failed(self, item_key: str, *, error: str, now: datetime) -> None:
        with self._connection_factory() as c:
            c.execute(
                """UPDATE triage_items SET extraction_status = 'failed', extraction_lease_until = NULL,
                       extraction_error = %s WHERE item_key = %s""",
                (error[:1000], item_key),
            )

    def release_extraction(self, item_key: str) -> None:
        with self._connection_factory() as c:
            c.execute(
                """UPDATE triage_items SET extraction_status = 'pending', extraction_lease_until = NULL,
                       extraction_attempts = GREATEST(0, extraction_attempts - 1)
                   WHERE item_key = %s AND extraction_status = 'running'""",
                (item_key,),
            )

    def extraction_usage_since(self, since: datetime) -> tuple[int, int]:
        with self._connection_factory() as c:
            row = c.execute(
                """SELECT count(*), COALESCE(sum(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)), 0)
                   FROM triage_extractions WHERE created_at >= %s""",
                (since,),
            ).fetchone()
        return int(row[0]), int(row[1])

    # --- scoring -------------------------------------------------------------

    def scoring_candidates(self, *, scoring_version: str, limit: int) -> list[ScoringRow]:
        """In-scope items whose score is missing or stale (new extraction, new
        GitHub activity, or a new scoring config version)."""
        with self._connection_factory() as c:
            rows = c.execute(
                """
                SELECT i.item_key, i.number, i.kind, i.title, i.state, i.draft, i.reactions,
                       i.comment_count, i.prepass, i.files, e.id, e.facets
                FROM triage_items i
                LEFT JOIN LATERAL (
                    SELECT id, facets, created_at FROM triage_extractions x
                    WHERE x.item_key = i.item_key ORDER BY created_at DESC LIMIT 1
                ) e ON true
                LEFT JOIN triage_scores s ON s.item_key = i.item_key
                WHERE i.in_scope
                  AND (s.item_key IS NULL
                       OR s.scoring_version <> %s
                       OR e.created_at > s.scored_at
                       OR i.updated_at > s.scored_at)
                ORDER BY (i.kind = 'issue') DESC, i.gh_updated_at DESC
                LIMIT %s
                """,
                (scoring_version, limit),
            ).fetchall()
        return [
            ScoringRow(
                item_key=r[0], number=r[1], kind=r[2], title=r[3], state=r[4], draft=r[5],
                reactions=r[6], comment_count=r[7], prepass=dict(r[8]),
                files=[f["path"] for f in r[9]], extraction_id=r[10],
                facets=dict(r[11]) if r[11] is not None else None,
            )
            for r in rows
        ]

    def issue_scores(self, repo: str, numbers: Iterable[int]) -> dict[int, int]:
        keys = [f"{repo}#{n}" for n in set(numbers)]
        if not keys:
            return {}
        with self._connection_factory() as c:
            rows = c.execute(
                """SELECT i.number, s.score FROM triage_scores s JOIN triage_items i USING (item_key)
                   WHERE s.item_key = ANY(%s) AND i.kind = 'issue' AND i.state = 'open'""",
                (keys,),
            ).fetchall()
        return {int(n): int(s) for n, s in rows}

    def save_scores(self, scores: list[tuple[str, int | None, Score]], *, now: datetime) -> None:
        if not scores:
            return
        with self._connection_factory() as c:
            with c.transaction():
                with c.cursor() as cur:
                    cur.executemany(
                        """INSERT INTO triage_scores (item_key, extraction_id, score, band, breakdown,
                               scoring_version, scored_at)
                           VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s)
                           ON CONFLICT (item_key) DO UPDATE SET extraction_id = EXCLUDED.extraction_id,
                               score = EXCLUDED.score, band = EXCLUDED.band, breakdown = EXCLUDED.breakdown,
                               scoring_version = EXCLUDED.scoring_version, scored_at = EXCLUDED.scored_at""",
                        [
                            (key, ext, s.score, s.band, json.dumps([f.as_json() for f in s.breakdown]),
                             s.version, now)
                            for key, ext, s in scores
                        ],
                    )

    # --- routing -------------------------------------------------------------

    def active_maintainers(self) -> list[Maintainer]:
        with self._connection_factory() as c:
            rows = c.execute(
                """SELECT github_login, slack_user_id, active, rules, min_score, capacity_per_week,
                          away, notify_mode FROM triage_maintainers WHERE active"""
            ).fetchall()
        return [
            Maintainer(github_login=r[0], slack_user_id=r[1], active=r[2], rules=dict(r[3]),
                       min_score=r[4], capacity_per_week=r[5], away=list(r[6]), notify_mode=r[7])
            for r in rows
        ]

    def maintainer_load(self, *, since: datetime) -> dict[str, int]:
        with self._connection_factory() as c:
            rows = c.execute(
                """SELECT maintainer, count(*) FROM triage_assignments
                   WHERE assigned_at >= %s AND role = 'primary' GROUP BY maintainer""",
                (since,),
            ).fetchall()
        return {r[0]: int(r[1]) for r in rows}

    def routing_candidates(self, *, limit: int) -> list[RoutingRow]:
        """Open, extracted items in page/route band with no open primary owner
        and no drop/slop decision."""
        with self._connection_factory() as c:
            rows = c.execute(
                """
                SELECT i.item_key, i.kind, i.title, i.html_url, s.score, s.band, e.facets, i.prepass,
                       i.files, i.comments_excerpt,
                       COALESCE((SELECT array_agg(DISTINCT a.actor) FROM triage_actions a
                                 WHERE a.item_key = i.item_key AND a.action = 'not_mine'), '{}')
                FROM triage_items i
                JOIN triage_scores s ON s.item_key = i.item_key
                JOIN triage_extractions e ON e.id = s.extraction_id
                WHERE i.in_scope AND i.state = 'open' AND s.band IN ('page', 'route')
                  AND NOT EXISTS (SELECT 1 FROM triage_assignments a WHERE a.item_key = i.item_key
                                  AND a.role = 'primary' AND a.status IN ('open', 'acked', 'done'))
                  AND NOT EXISTS (SELECT 1 FROM triage_actions a WHERE a.item_key = i.item_key
                                  AND a.action IN ('drop', 'slop'))
                ORDER BY s.score DESC
                LIMIT %s
                """,
                (limit,),
            ).fetchall()
        return [
            RoutingRow(
                item_key=r[0], kind=r[1], title=r[2], html_url=r[3], score=r[4], band=r[5],
                facets=dict(r[6]), prepass=_with_commenters(dict(r[7]), r[9]),
                files=[f["path"] for f in r[8]], excluded=frozenset(r[10]),
            )
            for r in rows
        ]

    def commit_assignments(
        self, item_key: str, score: int, assignments: list[NewAssignment], *, now: datetime
    ) -> None:
        with self._connection_factory() as c:
            with c.transaction():
                for a in assignments:
                    row = c.execute(
                        """INSERT INTO triage_assignments (item_key, maintainer, role, reason,
                               score_at_assign, assigned_at, notified_at)
                           VALUES (%s,%s,%s,%s::jsonb,%s,%s,%s)
                           ON CONFLICT DO NOTHING RETURNING id""",
                        (item_key, a.maintainer, a.role, json.dumps(a.reason), score, now,
                         now if a.notification else None),
                    ).fetchone()
                    if row and a.notification:
                        self._enqueue(c, a.notification, next_attempt_at=now)

    # --- digests -------------------------------------------------------------

    def unnotified_assignments(self, maintainer: str) -> list[DigestEntry]:
        with self._connection_factory() as c:
            rows = c.execute(
                """SELECT a.id, i.item_key, i.title, i.html_url, s.score, s.band,
                          COALESCE(e.facets->>'summary', ''), a.reason
                   FROM triage_assignments a
                   JOIN triage_items i USING (item_key)
                   JOIN triage_scores s USING (item_key)
                   LEFT JOIN triage_extractions e ON e.id = s.extraction_id
                   WHERE a.maintainer = %s AND a.status = 'open' AND a.notified_at IS NULL
                   ORDER BY s.score DESC""",
                (maintainer,),
            ).fetchall()
        return [
            DigestEntry(r[0], r[1], r[2], r[3], r[4], r[5], r[6], list((r[7] or {}).get("matched", [])))
            for r in rows
        ]

    def top_new_items(self, *, since: datetime, limit: int) -> list[tuple[DigestEntry, list[str]]]:
        with self._connection_factory() as c:
            rows = c.execute(
                """SELECT i.item_key, i.title, i.html_url, s.score, s.band,
                          COALESCE(e.facets->>'summary', ''),
                          COALESCE((SELECT array_agg(a.maintainer ORDER BY a.role DESC)
                                    FROM triage_assignments a
                                    WHERE a.item_key = i.item_key AND a.status IN ('open','acked')), '{}')
                   FROM triage_items i JOIN triage_scores s USING (item_key)
                   LEFT JOIN triage_extractions e ON e.id = s.extraction_id
                   WHERE i.first_seen_at >= %s AND i.state = 'open' AND s.band IN ('page', 'route')
                   ORDER BY s.score DESC LIMIT %s""",
                (since, limit),
            ).fetchall()
        return [(DigestEntry(0, r[0], r[1], r[2], r[3], r[4], r[5], []), list(r[6])) for r in rows]

    def commit_digest(
        self, notification: NotificationIntent, assignment_ids: list[int], *, now: datetime
    ) -> None:
        with self._connection_factory() as c:
            with c.transaction():
                self._enqueue(c, notification, next_attempt_at=now)
                if assignment_ids:
                    c.execute(
                        "UPDATE triage_assignments SET notified_at = %s WHERE id = ANY(%s)",
                        (now, assignment_ids),
                    )

    # --- maintainers (synced from triage/config/maintainers/*.yaml) --------

    def sync_maintainers(self, maintainers: list[Maintainer], *, owner: str = "repo") -> tuple[int, int]:
        """Make the database match the file: upsert every listed maintainer,
        deactivate file-owned rows that are no longer listed. Rows created by
        the dashboard for unlisted people (updated_by = their login) are left
        alone. Returns (upserted, deactivated)."""
        logins = [m.github_login for m in maintainers]
        with self._connection_factory() as c:
            with c.transaction():
                for m in maintainers:
                    c.execute(
                        """INSERT INTO triage_maintainers (github_login, slack_user_id, active, rules,
                               min_score, capacity_per_week, away, notify_mode, updated_by)
                           VALUES (%s,%s,%s,%s::jsonb,%s,%s,%s::jsonb,%s,%s)
                           ON CONFLICT (github_login) DO UPDATE SET
                               slack_user_id = EXCLUDED.slack_user_id, active = EXCLUDED.active,
                               rules = EXCLUDED.rules, min_score = EXCLUDED.min_score,
                               capacity_per_week = EXCLUDED.capacity_per_week, away = EXCLUDED.away,
                               notify_mode = EXCLUDED.notify_mode, updated_by = EXCLUDED.updated_by
                           WHERE (triage_maintainers.slack_user_id, triage_maintainers.active,
                                  triage_maintainers.rules, triage_maintainers.min_score,
                                  triage_maintainers.capacity_per_week, triage_maintainers.away,
                                  triage_maintainers.notify_mode, triage_maintainers.updated_by)
                             IS DISTINCT FROM
                                 (EXCLUDED.slack_user_id, EXCLUDED.active, EXCLUDED.rules,
                                  EXCLUDED.min_score, EXCLUDED.capacity_per_week, EXCLUDED.away,
                                  EXCLUDED.notify_mode, EXCLUDED.updated_by)""",
                        (m.github_login, m.slack_user_id, m.active, json.dumps(m.rules), m.min_score,
                         m.capacity_per_week, json.dumps(m.away), m.notify_mode, owner),
                    )
                deactivated = c.execute(
                    """UPDATE triage_maintainers SET active = false
                       WHERE updated_by = %s AND active AND NOT (github_login = ANY(%s))""",
                    (owner, logins),
                ).rowcount
        return len(maintainers), int(deactivated or 0)


def _with_commenters(prepass: dict[str, Any], comments_excerpt: str) -> dict[str, Any]:
    """Items ingested before commenters were recorded: read them from the
    stored comment text."""
    if "commenters" not in prepass:
        from triage.prepass import commenters

        prepass = {**prepass, "commenters": commenters(comments_excerpt or "")}
    return prepass


def week_ago(now: datetime) -> datetime:
    return now - timedelta(days=7)
