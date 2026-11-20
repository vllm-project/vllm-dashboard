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
from dataclasses import field as dataclass_field
from datetime import datetime, timedelta
from typing import Any

from alerting.ports import NotificationIntent
from alerting.postgres import PostgresAlertStore

from triage.ci import MAIN_RECENT_DAYS, MainJobs
from triage.diff import DIFF_LIMIT
from triage.extract import ExtractionTask, LLMResult
from triage.facets import routing_facets_fingerprint
from triage.groups import Member
from triage.relevance import (
    FEEDBACK_LIMIT,
    FEEDBACK_WINDOW,
    Judgment,
    MaintainerProfile,
    RelevanceTask,
    invalidation_hash,
    path_prefixes,
    profile_hash,
)
from triage.model import Item, Maintainer, Score
from triage.prepass import BODY_LIMIT, COMMENTS_LIMIT, MAX_FILES, fixes_issues


def _fix_numbers(pr: str, facets: str) -> str:
    """SQL: the issue numbers (text) PR row `pr` fixes: prepass.fixes_issues
    (closing keywords and GitHub closing references) plus Claude's
    facets.pr.fixes_issues. See triage/groups.py."""
    def arr(expr: str) -> str:
        return f"(CASE WHEN jsonb_typeof({expr}) = 'array' THEN {expr} ELSE '[]'::jsonb END)"
    mine = arr(pr + ".prepass->'fixes_issues'")
    claude = arr(facets + "->'pr'->'fixes_issues'")
    return (f"(SELECT DISTINCT n.num FROM jsonb_array_elements_text({mine} || {claude}) AS n(num) "
            "WHERE n.num ~ '^[0-9]{1,9}$')")


def _fixes_of(item: str, facets: str) -> str:
    """SQL: text[] of the issue keys PR row `item` fixes (empty for issues)."""
    return (f"COALESCE((SELECT array_agg(t.item_key ORDER BY t.number) FROM {_fix_numbers(item, facets)} f "
            f"JOIN triage_items t ON t.item_key = {item}.repo || '#' || f.num AND t.kind = 'issue' "
            f"WHERE {item}.kind = 'pr'), '{{}}')")


def _fixed_by_merged(item: str) -> str:
    """SQL: true when a merged PR fixes issue row `item`."""
    return (f"EXISTS (SELECT 1 FROM triage_items p LEFT JOIN LATERAL ("
            f"SELECT x.facets FROM triage_extractions x WHERE x.item_key = p.item_key "
            f"ORDER BY x.created_at DESC, x.id DESC LIMIT 1) pe ON true "
            f"WHERE {item}.kind = 'issue' AND p.repo = {item}.repo AND p.kind = 'pr' AND p.state = 'merged' "
            f"AND {item}.number::text IN {_fix_numbers('p', 'pe.facets')})")


# The item's triage_pr_ci row as JSON (NULL when none), for item queries
# aliased `i`. Keys as triage.ci.CiSummary.as_json().
_CI_JSON = """(SELECT to_jsonb(c) - 'item_key' - 'checked_at' - 'changed_at'
           FROM triage_pr_ci c WHERE c.item_key = i.item_key)"""
# How often an open PR's CI is re-checked, by band (P0/P1 more often).
CI_REFRESH = {"page": timedelta(minutes=10), "route": timedelta(minutes=10), "watch": timedelta(minutes=60)}
# Main CI's two-minute poller scans through about now; older than this, its
# job states are too stale to say a job "is failing on main".
MAIN_CI_MAX_LAG = timedelta(hours=1)


@dataclass(frozen=True)
class StoredItemState:
    content_hash: str
    comment_count: int
    gh_updated_at: datetime
    files: list[dict[str, Any]]
    comments_excerpt: str
    prepass: dict[str, Any]
    # The PR's stored CI summary (triage_pr_ci, see triage/ci.py), if any.
    ci: dict[str, Any] | None = None
    diff_excerpt: str = ""
    diff_head_sha: str | None = None


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
    # {login: {"relevance": "high", "evidence_prs": [...], "reason": "..."}},
    # only judgements that match the item's current text.
    relevance: dict[str, dict[str, Any]] = dataclass_field(default_factory=dict)
    created_at: datetime | None = None
    # When the item became routable: the later of entering the page/route
    # band and its first extraction. Routing waits for relevance judgements
    # for a grace period counted from here. None: unknown, no wait.
    waiting_since: datetime | None = None
    author: str = ""


@dataclass(frozen=True)
class NewAssignment:
    maintainer: str
    role: str
    reason: dict[str, Any]
    notification: NotificationIntent | None
    # Notified along with another item (a group's page DM): don't put it in
    # the next digest.
    notified: bool = False


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
    # Claude's one-line "why you" in the maintainer's language ("" for English).
    why_local: str = ""
    # Set on "still waiting" reminders (waiting_assignments) only.
    assigned_at: datetime | None = None
    kind: str = ""
    # For a PR: the issue keys it fixes (triage/groups.py), so a digest can
    # show it under its issue.
    fixes: tuple[str, ...] = ()
    # PRs: the head commit's CI summary (triage_pr_ci row), if known.
    ci: dict[str, Any] | None = None


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
                f"""SELECT content_hash, comment_count, gh_updated_at, files, comments_excerpt, prepass,
                          {_CI_JSON}, diff_excerpt, diff_head_sha
                   FROM triage_items i WHERE item_key = %s""",
                (item_key,),
            ).fetchone()
        return (
            StoredItemState(row[0], row[1], row[2], list(row[3]), row[4], dict(row[5]), row[6], row[7] or "", row[8])
            if row
            else None
        )

    def upsert_item(
        self,
        item: Item,
        *,
        prepass: dict[str, Any],
        priority: int,
        content_hash: str,
        in_scope: bool,
        comments_excerpt: str,
        now: datetime | None = None,
        reextract_cooldown: timedelta = timedelta(0),
        diff_excerpt: str = "",
        diff_head_sha: str | None = None,
    ) -> None:
        files = [
            {"path": f.path, "additions": f.additions, "deletions": f.deletions}
            for f in item.files[:MAX_FILES]
        ]
        cutoff = now - reextract_cooldown if (now is not None and reextract_cooldown > timedelta(0)) else None
        with self._connection_factory() as c:
            # When an already-extracted item has only comment changes (core_hash
            # matches) and its latest extraction is still within the cooldown
            # window, defer re-extraction and keep the stored content_hash so
            # existing extractions and relevance judgements stay aligned.
            defer_reextract = False
            if cutoff is not None and in_scope and prepass.get("core_hash"):
                prev = c.execute(
                    """SELECT i.extraction_status, i.content_hash, i.prepass->>'core_hash',
                              (SELECT max(e.created_at) FROM triage_extractions e WHERE e.item_key = i.item_key)
                       FROM triage_items i WHERE i.item_key = %s""",
                    (item.key,),
                ).fetchone()
                if (
                    prev is not None
                    and prev[0] == "done"
                    and prev[1] != content_hash
                    and prev[2] == prepass["core_hash"]
                    and prev[3] is not None
                    and prev[3] > cutoff
                ):
                    defer_reextract = True
                    content_hash = str(prev[1])
            c.execute(
                """
                INSERT INTO triage_items (
                    item_key, repo, number, kind, title, body_excerpt, comments_excerpt,
                    diff_excerpt, diff_head_sha,
                    author, author_association, state, draft, html_url, labels, files,
                    reactions, comment_count, gh_created_at, gh_updated_at, gh_closed_at,
                    prepass, prepass_priority, content_hash, in_scope, extraction_status
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s,%s,
                          %s::jsonb,%s,%s,%s, CASE WHEN %s THEN 'pending' ELSE 'skipped' END)
                ON CONFLICT (item_key) DO UPDATE SET
                    title = EXCLUDED.title,
                    body_excerpt = EXCLUDED.body_excerpt,
                    comments_excerpt = EXCLUDED.comments_excerpt,
                    diff_excerpt = EXCLUDED.diff_excerpt,
                    diff_head_sha = EXCLUDED.diff_head_sha,
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
                    -- New text re-queues extraction; unchanged (or cooldown-deferred) text keeps its status.
                    extraction_status = CASE
                        WHEN NOT EXCLUDED.in_scope THEN 'skipped'
                        WHEN %s THEN triage_items.extraction_status
                        WHEN triage_items.content_hash <> EXCLUDED.content_hash
                             OR triage_items.extraction_status = 'skipped' THEN 'pending'
                        ELSE triage_items.extraction_status END,
                    extraction_attempts = CASE
                        WHEN %s THEN triage_items.extraction_attempts
                        WHEN triage_items.content_hash <> EXCLUDED.content_hash THEN 0
                        ELSE triage_items.extraction_attempts END
                """,
                (
                    item.key, item.repo, item.number, item.kind, item.title,
                    item.body[:BODY_LIMIT], comments_excerpt[:COMMENTS_LIMIT],
                    diff_excerpt[:DIFF_LIMIT], diff_head_sha,
                    item.author, item.author_association, item.state, item.draft,
                    item.html_url, json.dumps(item.labels), json.dumps(files),
                    item.reactions, item.comment_count, item.created_at, item.updated_at,
                    item.closed_at, json.dumps(prepass), priority, content_hash, in_scope,
                    in_scope, defer_reextract, defer_reextract,
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
                              author_association, state, labels, files, prepass, content_hash,
                              diff_excerpt
                    """,
                    (lease_until, max_attempts, now, limit),
                ).fetchall()
        return [
            ExtractionTask(
                item_key=r[0], kind=r[1], title=r[2], body=r[3], comments=r[4],
                author_association=r[5], state=r[6], labels=list(r[7]), files=list(r[8]),
                prepass=dict(r[9]), content_hash=r[10], diff_excerpt=r[11] or "",
            )
            for r in rows
        ]

    def save_extraction(
        self, task: ExtractionTask, *, facets: dict[str, Any], result: LLMResult,
        prompt_version: str, now: datetime,
    ) -> None:
        with self._connection_factory() as c:
            with c.transaction():
                prev = c.execute(
                    """SELECT content_hash, facets FROM triage_extractions
                       WHERE item_key = %s ORDER BY created_at DESC, id DESC LIMIT 1""",
                    (task.item_key,),
                ).fetchone()
                c.execute(
                    """INSERT INTO triage_extractions (item_key, content_hash, prompt_version, model,
                           facets, input_tokens, output_tokens, duration_ms, created_at)
                       VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s)
                       ON CONFLICT (item_key, content_hash, prompt_version) DO UPDATE SET
                           facets = EXCLUDED.facets, model = EXCLUDED.model, created_at = EXCLUDED.created_at""",
                    (task.item_key, task.content_hash, prompt_version, result.model, json.dumps(facets),
                     result.input_tokens, result.output_tokens, result.duration_ms, now),
                )
                # Semantic facet-diff gate: if re-extraction produced the same
                # routing-relevant facets (areas, models, hardware, serving,
                # type, severity, fixes_issues), carry forward existing
                # relevance judgements to the new content_hash so Opus isn't
                # re-called for text/comment churn.
                if (
                    prev is not None
                    and prev[0] != task.content_hash
                    and isinstance(prev[1], dict)
                    and routing_facets_fingerprint(prev[1]) == routing_facets_fingerprint(facets)
                ):
                    c.execute(
                        """UPDATE triage_relevance SET content_hash = %s
                           WHERE item_key = %s AND content_hash = %s""",
                        (task.content_hash, task.item_key, prev[0]),
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

    # --- scope window --------------------------------------------------------

    def expire_out_of_window(self, cutoff: datetime) -> tuple[int, int]:
        """Take items opened before `cutoff` out of triage. Returns
        (items expired, unacted router assignments removed)."""
        with self._connection_factory() as c:
            with c.transaction():
                keys = [r[0] for r in c.execute(
                    """UPDATE triage_items
                       SET in_scope = false, extraction_status = 'skipped', extraction_lease_until = NULL,
                           prepass = prepass || '{"scope_reason": "too_old"}'::jsonb
                       WHERE in_scope AND gh_created_at < %s
                       RETURNING item_key""",
                    (cutoff,),
                ).fetchall()]
                removed = 0
                if keys:
                    removed = c.execute(
                        """DELETE FROM triage_assignments a
                           WHERE a.item_key = ANY(%s) AND a.status = 'open' AND a.assigned_by = 'router'
                             AND NOT EXISTS (SELECT 1 FROM triage_actions x WHERE x.item_key = a.item_key)""",
                        (keys,),
                    ).rowcount or 0
        return len(keys), int(removed)

    # --- following GitHub -------------------------------------------------------

    def follow_github(self, *, now: datetime) -> tuple[int, int, int]:
        """Bring open assignments in line with what happened on GitHub.
        Returns (closed, reopened, acked).

          * item closed or merged: its open/acked assignments become `done`
            with reason.closed_by = "github" (and the status they had);
          * such an item reopened (and still in the window): those rows go
            back to the status they had, unless the role was filled since;
          * the assigned maintainer commented after the assignment
            (prepass.commented_at): open -> acked, reason.acked_by =
            "github_comment".

        No triage_actions rows: those record what people did on the
        dashboard or in Slack."""
        with self._connection_factory() as c:
            with c.transaction():
                closed = c.execute(
                    """UPDATE triage_assignments a
                       SET status = 'done', closed_at = %(now)s, updated_at = %(now)s,
                           reason = a.reason || jsonb_build_object(
                               'closed_by', 'github', 'closed_from', a.status, 'item_state', i.state)
                       FROM triage_items i
                       WHERE i.item_key = a.item_key AND a.status IN ('open', 'acked')
                         AND i.state IN ('closed', 'merged')""",
                    {"now": now},
                ).rowcount
                reopened = c.execute(
                    """WITH pick AS (
                           SELECT DISTINCT ON (a.item_key, a.role) a.id
                           FROM triage_assignments a JOIN triage_items i USING (item_key)
                           WHERE a.status = 'done' AND a.reason->>'closed_by' = 'github'
                             AND i.state = 'open' AND i.in_scope
                             AND NOT EXISTS (SELECT 1 FROM triage_assignments b
                                             WHERE b.item_key = a.item_key AND b.role = a.role
                                               AND b.status IN ('open', 'acked'))
                           ORDER BY a.item_key, a.role, a.closed_at DESC, a.id DESC)
                       UPDATE triage_assignments a
                       SET status = COALESCE(a.reason->>'closed_from', 'open'), closed_at = NULL,
                           updated_at = %(now)s,
                           reason = a.reason - 'closed_by' - 'closed_from' - 'item_state'
                       FROM pick WHERE a.id = pick.id""",
                    {"now": now},
                ).rowcount
                acked = c.execute(
                    """UPDATE triage_assignments a
                       SET status = 'acked', updated_at = %(now)s,
                           reason = a.reason || '{"acked_by": "github_comment"}'::jsonb
                       FROM triage_items i
                       WHERE i.item_key = a.item_key AND a.status = 'open' AND i.state = 'open'
                         AND (i.prepass->'commented_at'->>lower(a.maintainer))::timestamptz > a.assigned_at""",
                    {"now": now},
                ).rowcount
        return int(closed or 0), int(reopened or 0), int(acked or 0)

    # --- scoring -------------------------------------------------------------

    def scoring_candidates(self, *, scoring_version: str, limit: int) -> list[ScoringRow]:
        """In-scope items whose score is missing or stale (new extraction, new
        GitHub activity, or a new scoring config version). A PR is also stale
        when an issue it links or fixes was scored after it: part of a PR's
        score comes from that issue's score, which may have changed."""
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
                       OR i.updated_at > s.scored_at
                       OR (i.kind = 'pr' AND EXISTS (
                           SELECT 1
                           FROM jsonb_array_elements_text(
                                    COALESCE(i.prepass->'linked_issues', '[]'::jsonb)
                                    || COALESCE(e.facets->'pr'->'fixes_issues', '[]'::jsonb)) AS n(num)
                           JOIN triage_scores ls
                             ON ls.item_key = split_part(i.item_key, '#', 1) || '#' || n.num
                           WHERE ls.scored_at > s.scored_at)))
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
                        # routable_since: when the item last entered the page/route
                        # band; kept while it stays in either, cleared when it leaves.
                        """INSERT INTO triage_scores (item_key, extraction_id, score, band, breakdown,
                               scoring_version, scored_at, routable_since)
                           VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s)
                           ON CONFLICT (item_key) DO UPDATE SET extraction_id = EXCLUDED.extraction_id,
                               score = EXCLUDED.score, band = EXCLUDED.band, breakdown = EXCLUDED.breakdown,
                               scoring_version = EXCLUDED.scoring_version, scored_at = EXCLUDED.scored_at,
                               routable_since = CASE
                                   WHEN EXCLUDED.routable_since IS NULL THEN NULL
                                   WHEN triage_scores.band IN ('page', 'route')
                                       THEN COALESCE(triage_scores.routable_since, EXCLUDED.routable_since)
                                   ELSE EXCLUDED.routable_since END""",
                        [
                            (key, ext, s.score, s.band, json.dumps([f.as_json() for f in s.breakdown]),
                             s.version, now, now if s.band in ("page", "route") else None)
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
        """Primary assignments this week that the person kept (open, acked,
        done, dropped); ones they passed on or reassigned away don't count,
        nor ones closed on GitHub before they acked them, nor ones that
        followed their issue/fix-PR group (reason.grouped_with): a group takes
        one slot."""
        with self._connection_factory() as c:
            rows = c.execute(
                """SELECT maintainer, count(*) FROM triage_assignments
                   WHERE assigned_at >= %s AND role = 'primary'
                     AND status NOT IN ('not_mine', 'reassigned')
                     AND NOT (status = 'done' AND reason->>'closed_by' = 'github'
                              AND reason->>'closed_from' = 'open')
                     AND NOT (reason ? 'grouped_with')
                   GROUP BY maintainer""",
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
                                 WHERE a.item_key = i.item_key AND a.action = 'not_mine'), '{}'),
                       COALESCE((SELECT jsonb_object_agg(r.maintainer, jsonb_build_object(
                                     'relevance', r.relevance, 'evidence_prs', r.evidence_prs,
                                     'reason', r.reason, 'reason_local', r.reason_local))
                                 FROM triage_relevance r
                                 WHERE r.item_key = i.item_key AND r.content_hash = i.content_hash),
                                '{}'::jsonb),
                       i.gh_created_at,
                       GREATEST(s.routable_since,
                                (SELECT min(x.created_at) FROM triage_extractions x WHERE x.item_key = i.item_key)),
                       COALESCE(i.author, '')
                FROM triage_items i
                JOIN triage_scores s ON s.item_key = i.item_key
                JOIN triage_extractions e ON e.id = s.extraction_id
                WHERE i.in_scope AND i.state = 'open' AND s.band IN ('page', 'route')
                  AND NOT EXISTS (SELECT 1 FROM triage_assignments a WHERE a.item_key = i.item_key
                                  AND a.role = 'primary' AND a.status IN ('open', 'acked', 'done'))
                  AND NOT EXISTS (SELECT 1 FROM triage_actions a WHERE a.item_key = i.item_key
                                  AND a.action IN ('drop', 'slop'))
                  -- routing.waiting_on_author: PRs waiting on their author don't take a slot.
                  AND NOT (COALESCE(i.prepass->>'waiting_on', '') = 'author' AND s.band <> 'page')
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
                relevance=dict(r[11]), created_at=r[12], waiting_since=r[13], author=str(r[14] or ""),
            )
            for r in rows
        ]

    def open_router_assignments(self) -> list[tuple[int, str, str, RoutingRow]]:
        """Open (un-acked) router-created assignments on open items, with their
        current item/relevance context so the router can revoke stale ones."""
        with self._connection_factory() as c:
            rows = c.execute(
                """
                SELECT a.id, a.maintainer, a.role,
                       i.item_key, i.kind, i.title, i.html_url,
                       COALESCE(s.score, a.score_at_assign), COALESCE(s.band, 'route'),
                       COALESCE(e.facets, '{}'::jsonb), i.prepass, i.files, i.comments_excerpt,
                       COALESCE((SELECT jsonb_object_agg(r.maintainer, jsonb_build_object(
                                     'relevance', r.relevance, 'evidence_prs', r.evidence_prs,
                                     'reason', r.reason, 'reason_local', r.reason_local))
                                 FROM triage_relevance r
                                 WHERE r.item_key = i.item_key AND r.content_hash = i.content_hash),
                                '{}'::jsonb),
                       i.gh_created_at, COALESCE(i.author, '')
                FROM triage_assignments a
                JOIN triage_items i ON i.item_key = a.item_key
                LEFT JOIN triage_scores s ON s.item_key = i.item_key
                LEFT JOIN triage_extractions e ON e.id = s.extraction_id
                WHERE a.status = 'open' AND a.assigned_by = 'router' AND i.state = 'open'
                ORDER BY a.id
                """
            ).fetchall()
        return [
            (
                int(r[0]),
                str(r[1]),
                str(r[2]),
                RoutingRow(
                    item_key=r[3], kind=r[4], title=r[5], html_url=r[6], score=int(r[7]), band=str(r[8]),
                    facets=dict(r[9]), prepass=_with_commenters(dict(r[10]), r[12]),
                    files=[f["path"] for f in r[11]], excluded=frozenset(),
                    relevance=dict(r[13]), created_at=r[14], waiting_since=None, author=str(r[15] or ""),
                ),
            )
            for r in rows
        ]

    def revoke_assignments(self, revocations: list[tuple[int, str]], *, now: datetime) -> int:
        """Close stale open router assignments as `'reassigned'` (freeing the
        unique open slot and capacity) while preserving audit history."""
        if not revocations:
            return 0
        count = 0
        with self._connection_factory() as c:
            with c.transaction():
                for assignment_id, why in revocations:
                    patch = json.dumps({"revoked_by": "router", "revoked_reason": why})
                    count += int(
                        c.execute(
                            """UPDATE triage_assignments
                               SET status = 'reassigned', closed_at = %s,
                                   reason = reason || %s::jsonb
                               WHERE id = %s AND status = 'open' AND assigned_by = 'router'""",
                            (now, patch, assignment_id),
                        ).rowcount
                        or 0
                    )
        return count

    def immediate_notifications_since(self, cutoffs: dict[str, datetime]) -> dict[str, int]:
        """How many immediate Slack DMs each maintainer already received since
        their local day start (`cutoffs[login]`)."""
        if not cutoffs:
            return {}
        out: dict[str, int] = {}
        with self._connection_factory() as c:
            for login, since in cutoffs.items():
                row = c.execute(
                    """SELECT count(*) FROM triage_assignments
                       WHERE maintainer = %s AND notified_at >= %s
                         AND reason->>'notified_via' = 'immediate'""",
                    (login, since),
                ).fetchone()
                out[login] = int(row[0]) if row else 0
        return out

    # --- issue + fix PR groups (triage/groups.py) ---------------------------

    def fix_links(self, *, open_only: bool = False) -> list[tuple[str, str]]:
        """(pr_key, issue_key) for every PR that fixes an issue, or only
        those where one of the two is open with `open_only`."""
        with self._connection_factory() as c:
            rows = c.execute(
                f"""SELECT p.item_key, i.item_key
                    FROM triage_items p
                    LEFT JOIN LATERAL (
                        SELECT x.facets FROM triage_extractions x WHERE x.item_key = p.item_key
                        ORDER BY x.created_at DESC, x.id DESC LIMIT 1) e ON true
                    CROSS JOIN LATERAL {_fix_numbers('p', 'e.facets')} f
                    JOIN triage_items i ON i.item_key = p.repo || '#' || f.num AND i.kind = 'issue'
                    WHERE p.kind = 'pr' AND (NOT %s OR p.state = 'open' OR i.state = 'open')
                    ORDER BY p.item_key, i.item_key""",
                (open_only,),
            ).fetchall()
        return [(r[0], r[1]) for r in rows]

    def group_members(self, keys: Iterable[str]) -> dict[str, Member]:
        """Number, kind, state, score, band and open/acked primary owner of each item."""
        keys = sorted(set(keys))
        if not keys:
            return {}
        with self._connection_factory() as c:
            rows = c.execute(
                """SELECT i.item_key, i.number, i.kind, i.state, s.score, s.band,
                          (SELECT a.maintainer FROM triage_assignments a
                           WHERE a.item_key = i.item_key AND a.role = 'primary'
                             AND a.status IN ('open', 'acked')
                           ORDER BY a.assigned_at DESC, a.id DESC LIMIT 1)
                   FROM triage_items i LEFT JOIN triage_scores s USING (item_key)
                   WHERE i.item_key = ANY(%s)""",
                (keys,),
            ).fetchall()
        return {r[0]: Member(r[0], int(r[1]), r[2], r[3], r[4], r[5], r[6]) for r in rows}

    def backfill_fixes_issues(self, *, limit: int = 1000) -> int:
        """PRs stored before prepass.fixes_issues existed: read it from the
        stored title and body (closing keywords only; the ingest also adds
        GitHub's closing references the next time it sees the PR)."""
        with self._connection_factory() as c:
            rows = c.execute(
                """SELECT item_key, title, body_excerpt FROM triage_items
                   WHERE kind = 'pr' AND NOT (prepass ? 'fixes_issues')
                   ORDER BY gh_created_at DESC LIMIT %s""",
                (limit,),
            ).fetchall()
            if rows:
                with c.transaction():
                    with c.cursor() as cur:
                        cur.executemany(
                            """UPDATE triage_items SET prepass = prepass || jsonb_build_object('fixes_issues', %s::jsonb)
                               WHERE item_key = %s AND NOT (prepass ? 'fixes_issues')""",
                            [(json.dumps(fixes_issues(f"{r[1]}\n{r[2]}")), r[0]) for r in rows],
                        )
        return len(rows)

    def waiting_prs(self, repo: str, *, limit: int) -> list[tuple[str, int, dict[str, Any]]]:
        """(item_key, number, prepass) of open P1 PRs the router holds back
        because they wait on their author and nobody owns yet, highest score
        first: the ones whose status the ingest re-reads."""
        with self._connection_factory() as c:
            rows = c.execute(
                """
                SELECT i.item_key, i.number, i.prepass
                FROM triage_items i JOIN triage_scores s ON s.item_key = i.item_key
                WHERE i.repo = %s AND i.kind = 'pr' AND i.in_scope AND i.state = 'open'
                  AND s.band = 'route' AND i.prepass->>'waiting_on' = 'author'
                  AND NOT EXISTS (SELECT 1 FROM triage_assignments a WHERE a.item_key = i.item_key
                                  AND a.role = 'primary' AND a.status IN ('open', 'acked', 'done'))
                ORDER BY s.score DESC
                LIMIT %s
                """,
                (repo, limit),
            ).fetchall()
        return [(r[0], int(r[1]), dict(r[2])) for r in rows]

    # --- PR CI status (triage/ci.py) ------------------------------------------

    def ci_due(self, repo: str, *, now: datetime, limit: int) -> list[tuple[str, int, dict[str, Any]]]:
        """(item_key, number, prepass) of open in-scope P0-P2 PRs whose CI
        is unknown or older than CI_REFRESH for their band; never checked
        first, then P0, P1, P2, highest score first."""
        with self._connection_factory() as c:
            rows = c.execute(
                """
                SELECT i.item_key, i.number, i.prepass
                FROM triage_items i JOIN triage_scores s ON s.item_key = i.item_key
                LEFT JOIN triage_pr_ci c ON c.item_key = i.item_key
                WHERE i.repo = %s AND i.kind = 'pr' AND i.in_scope AND i.state = 'open'
                  AND s.band IN ('page', 'route', 'watch')
                  AND (c.item_key IS NULL OR c.checked_at <= %s - CASE s.band
                       WHEN 'watch' THEN %s::interval ELSE %s::interval END)
                ORDER BY (c.item_key IS NULL) DESC,
                         CASE s.band WHEN 'page' THEN 0 WHEN 'route' THEN 1 ELSE 2 END,
                         s.score DESC
                LIMIT %s
                """,
                (repo, now, CI_REFRESH["watch"], CI_REFRESH["route"], limit),
            ).fetchall()
        return [(r[0], int(r[1]), dict(r[2])) for r in rows]

    def pr_ci(self, item_keys: Iterable[str]) -> dict[str, dict[str, Any]]:
        keys = list(item_keys)
        if not keys:
            return {}
        with self._connection_factory() as c:
            rows = c.execute(
                f"SELECT i.item_key, {_CI_JSON} FROM triage_items i WHERE i.item_key = ANY(%s)", (keys,)
            ).fetchall()
        return {r[0]: r[1] for r in rows if r[1] is not None}

    def save_pr_ci(self, item_key: str, ci: dict[str, Any], *, now: datetime) -> None:
        """Upsert the PR's CI summary; changed_at moves only when it changed."""
        columns = (
            "head_sha", "state", "build_number", "build_url", "build_state", "jobs_total", "jobs_passed",
            "jobs_running", "jobs_failed", "jobs_failed_on_main", "jobs_failed_recent_on_main",
            "jobs_failed_pr_only", "main_known",
        )
        values = [ci.get(k) for k in columns]
        with self._connection_factory() as c:
            c.execute(
                f"""
                INSERT INTO triage_pr_ci (item_key, {", ".join(columns)}, failed_jobs, checked_at, changed_at)
                VALUES (%s, {", ".join(["%s"] * len(columns))}, %s::jsonb, %s, %s)
                ON CONFLICT (item_key) DO UPDATE SET
                    {", ".join(f"{k} = EXCLUDED.{k}" for k in columns)},
                    failed_jobs = EXCLUDED.failed_jobs,
                    checked_at = EXCLUDED.checked_at,
                    changed_at = CASE WHEN
                        ({", ".join(f"triage_pr_ci.{k}" for k in columns)}, triage_pr_ci.failed_jobs)
                        IS DISTINCT FROM
                        ({", ".join(f"EXCLUDED.{k}" for k in columns)}, EXCLUDED.failed_jobs)
                        THEN EXCLUDED.changed_at ELSE triage_pr_ci.changed_at END
                """,
                (item_key, *values, json.dumps(ci.get("failed_jobs") or []), now, now),
            )

    def main_ci_jobs(self, *, now: datetime) -> MainJobs | None:
        """Main CI job keys failing right now (latest main outcome a failure,
        or an open Main CI alert; alerting/main_ci.py), and those that failed
        on main in the last MAIN_RECENT_DAYS. None when those tables can't be
        read, or Main CI hasn't scanned for over MAIN_CI_MAX_LAG: then nobody
        can say what fails on main."""
        from psycopg import errors

        try:
            with self._connection_factory() as c:
                scanned = c.execute(
                    "SELECT max(scanned_through) FROM alerting_main_ci_scan_cursors"
                ).fetchone()
                if not scanned or scanned[0] is None or scanned[0] < now - MAIN_CI_MAX_LAG:
                    return None
                rows = c.execute(
                    """SELECT job_key, true FROM alerting_main_ci_job_states WHERE latest_job_state <> 'passed'
                       UNION
                       SELECT job_key, status = 'open' FROM alerting_main_ci_job_alerts
                       WHERE status = 'open' OR last_failed_at >= %s""",
                    (now - timedelta(days=MAIN_RECENT_DAYS),),
                ).fetchall()
        except (errors.UndefinedTable, errors.InsufficientPrivilege):
            return None  # no Main CI tables here, or no grant: main is unknown
        return MainJobs(failing=frozenset(r[0] for r in rows if r[1]), recent=frozenset(r[0] for r in rows))

    def update_prepass(self, item_key: str, fields: dict[str, Any]) -> None:
        """Merge `fields` into an item's prepass (content hash untouched)."""
        with self._connection_factory() as c:
            c.execute(
                "UPDATE triage_items SET prepass = prepass || %s::jsonb WHERE item_key = %s",
                (json.dumps(fields), item_key),
            )

    def commit_assignments(
        self, item_key: str, score: int, assignments: list[NewAssignment], *, now: datetime
    ) -> None:
        self.commit_routes([(item_key, score, assignments)], now=now)

    def commit_routes(
        self, routes: list[tuple[str, int, list[NewAssignment]]], *, now: datetime
    ) -> None:
        """Assignments for one or more items (an item and the group members
        that follow it) in one transaction."""
        with self._connection_factory() as c:
            with c.transaction():
                for item_key, score, assignments in routes:
                    for a in assignments:
                        row = c.execute(
                            """INSERT INTO triage_assignments (item_key, maintainer, role, reason,
                                   score_at_assign, assigned_at, notified_at)
                               VALUES (%s,%s,%s,%s::jsonb,%s,%s,%s)
                               ON CONFLICT DO NOTHING RETURNING id""",
                            (item_key, a.maintainer, a.role, json.dumps(a.reason), score, now,
                             now if a.notification or a.notified else None),
                        ).fetchone()
                        if row and a.role == "primary":
                            c.execute(
                                "UPDATE triage_scores SET unowned_reason = NULL WHERE item_key = %s",
                                (item_key,),
                            )
                        if row and a.notification:
                            self._enqueue(c, a.notification, next_attempt_at=now)

    def save_unowned_reasons(self, reasons: dict[str, dict[str, Any] | None]) -> None:
        """Persist router-computed `unowned_reason` on `triage_scores`."""
        if not reasons:
            return
        with self._connection_factory() as c:
            with c.transaction():
                with c.cursor() as cur:
                    cur.executemany(
                        "UPDATE triage_scores SET unowned_reason = %s::jsonb WHERE item_key = %s",
                        [(json.dumps(val) if val is not None else None, key) for key, val in reasons.items()],
                    )

    # --- structured run telemetry (migration 0047) ---------------------------

    def record_run(
        self,
        *,
        consumer: str,
        started_at: datetime,
        finished_at: datetime,
        status: str,
        summary: dict[str, Any],
        warnings: list[str] | None = None,
    ) -> None:
        """Record one consumer run's summary and non-fatal warnings in `triage_runs`.

        Tolerates missing `triage_runs` table during rolling deploys.
        """
        from psycopg import errors

        try:
            with self._connection_factory() as c:
                c.execute(
                    """INSERT INTO triage_runs (consumer, started_at, finished_at, status, summary, warnings)
                       VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb)""",
                    (consumer, started_at, finished_at, status, json.dumps(summary), json.dumps(list(warnings or []))),
                )
        except errors.UndefinedTable:
            return

    # --- webhook queue (migration 0047) --------------------------------------

    def enqueue_webhook_item(
        self, repo: str, number: int, kind: str, event: str, *, now: datetime | None = None
    ) -> None:
        with self._connection_factory() as c:
            c.execute(
                """INSERT INTO triage_webhook_queue (repo, number, kind, event, received_at)
                   VALUES (%s, %s, %s, %s, COALESCE(%s, now()))
                   ON CONFLICT (repo, number) DO UPDATE SET
                       kind = EXCLUDED.kind,
                       event = EXCLUDED.event,
                       received_at = EXCLUDED.received_at""",
                (repo, number, kind, event, now),
            )

    def claim_webhook_queue(self, repo: str, *, limit: int = 100) -> list[int]:
        """Return up to `limit` queued item numbers for `repo`, oldest first."""
        from psycopg import errors

        try:
            with self._connection_factory() as c:
                rows = c.execute(
                    """UPDATE triage_webhook_queue
                       SET attempts = attempts + 1
                       WHERE (repo, number) IN (
                           SELECT repo, number FROM triage_webhook_queue
                           WHERE repo = %s
                           ORDER BY received_at ASC
                           LIMIT %s
                           FOR UPDATE SKIP LOCKED
                       )
                       RETURNING number""",
                    (repo, limit),
                ).fetchall()
        except errors.UndefinedTable:
            return []
        return sorted({int(r[0]) for r in rows})

    def ack_webhook_queue(self, repo: str, numbers: Iterable[int]) -> None:
        nums = sorted({int(n) for n in numbers})
        if not nums:
            return
        with self._connection_factory() as c:
            c.execute(
                "DELETE FROM triage_webhook_queue WHERE repo = %s AND number = ANY(%s)",
                (repo, nums),
            )

    # --- digests -------------------------------------------------------------

    def unnotified_assignments(self, maintainer: str) -> list[DigestEntry]:
        with self._connection_factory() as c:
            rows = c.execute(
                f"""SELECT a.id, i.item_key, i.title, i.html_url, s.score, s.band,
                          COALESCE(e.facets->>'summary', ''), a.reason, COALESCE(r.reason_local, ''),
                          i.kind, {_fixes_of('i', 'e.facets')}, {_CI_JSON}
                   FROM triage_assignments a
                   JOIN triage_items i USING (item_key)
                   JOIN triage_scores s USING (item_key)
                   LEFT JOIN triage_extractions e ON e.id = s.extraction_id
                   LEFT JOIN triage_relevance r ON r.item_key = a.item_key AND r.maintainer = a.maintainer
                   WHERE a.maintainer = %s AND a.status = 'open' AND a.notified_at IS NULL
                     AND i.state = 'open'
                   ORDER BY s.score DESC""",
                (maintainer,),
            ).fetchall()
        return [
            DigestEntry(r[0], r[1], r[2], r[3], r[4], r[5], r[6], list((r[7] or {}).get("matched", [])), r[8],
                        kind=r[9], fixes=tuple(r[10]), ci=r[11])
            for r in rows
        ]

    def waiting_assignments(
        self, maintainer: str, *, assigned_before: datetime, limit: int
    ) -> tuple[list[DigestEntry], int]:
        """Reminders: the maintainer's open assignments already sent once
        (notified_at set) and assigned before `assigned_before`, oldest
        first, at most `limit`, plus how many there are in all. Skips items
        that are closed, dropped or slop, or that someone else has already
        taken (acked or done), and issues a merged PR fixes (they wait for
        GitHub to close them, not for the maintainer)."""
        with self._connection_factory() as c:
            rows = c.execute(
                f"""SELECT a.id, i.item_key, i.title, i.html_url, s.score, s.band,
                          COALESCE(e.facets->>'summary', ''), a.reason, COALESCE(r.reason_local, ''),
                          a.assigned_at, count(*) OVER (), i.kind, {_fixes_of('i', 'e.facets')}, {_CI_JSON}
                   FROM triage_assignments a
                   JOIN triage_items i USING (item_key)
                   JOIN triage_scores s USING (item_key)
                   LEFT JOIN triage_extractions e ON e.id = s.extraction_id
                   LEFT JOIN triage_relevance r ON r.item_key = a.item_key AND r.maintainer = a.maintainer
                   WHERE a.maintainer = %s AND a.status = 'open' AND a.notified_at IS NOT NULL
                     AND a.assigned_at <= %s AND i.state = 'open'
                     AND NOT EXISTS (SELECT 1 FROM triage_assignments o WHERE o.item_key = a.item_key
                                     AND o.id <> a.id AND o.status IN ('acked', 'done'))
                     AND NOT EXISTS (SELECT 1 FROM triage_actions x WHERE x.item_key = a.item_key
                                     AND x.action IN ('drop', 'slop'))
                     AND NOT {_fixed_by_merged('i')}
                   ORDER BY a.assigned_at, a.id
                   LIMIT %s""",
                (maintainer, assigned_before, limit),
            ).fetchall()
        entries = [
            DigestEntry(r[0], r[1], r[2], r[3], r[4], r[5], r[6], list((r[7] or {}).get("matched", [])), r[8],
                        assigned_at=r[9], kind=r[11], fixes=tuple(r[12]), ci=r[13])
            for r in rows
        ]
        return entries, int(rows[0][10]) if rows else 0

    def top_new_items(self, *, since: datetime, limit: int) -> list[tuple[DigestEntry, list[str]]]:
        with self._connection_factory() as c:
            rows = c.execute(
                f"""SELECT i.item_key, i.title, i.html_url, s.score, s.band,
                          COALESCE(e.facets->>'summary', ''), i.kind, {_fixes_of('i', 'e.facets')},
                          COALESCE((SELECT array_agg(a.maintainer ORDER BY a.role DESC)
                                    FROM triage_assignments a
                                    WHERE a.item_key = i.item_key AND a.status IN ('open','acked')), '{{}}'),
                          {_CI_JSON}
                   FROM triage_items i JOIN triage_scores s USING (item_key)
                   LEFT JOIN triage_extractions e ON e.id = s.extraction_id
                   WHERE i.first_seen_at >= %s AND i.state = 'open' AND s.band IN ('page', 'route')
                   ORDER BY s.score DESC LIMIT %s""",
                (since, limit),
            ).fetchall()
        return [(DigestEntry(0, r[0], r[1], r[2], r[3], r[4], r[5], [], kind=r[6], fixes=tuple(r[7]), ci=r[9]),
                 list(r[8]))
                for r in rows]

    def suppression_since(self, since: datetime, *, threshold: int) -> list[tuple[str, int, int]]:
        """(actor, drops, slops) for people who hid >= threshold items since `since`."""
        with self._connection_factory() as c:
            rows = c.execute(
                """SELECT actor, count(*) FILTER (WHERE action = 'drop'), count(*) FILTER (WHERE action = 'slop')
                   FROM triage_actions WHERE action IN ('drop', 'slop') AND created_at > %s
                   GROUP BY actor HAVING count(*) >= %s ORDER BY count(*) DESC""",
                (since, threshold),
            ).fetchall()
        return [(r[0], int(r[1]), int(r[2])) for r in rows]

    def commit_digest(
        self, notification: NotificationIntent, assignment_ids: list[int], *, now: datetime
    ) -> bool:
        """Queue a digest and mark `assignment_ids` notified, once per
        delivery_id. If that digest is already in the outbox (the hourly
        timer fired twice in the same hour, or a rerun) nothing changes and
        this returns False: the outbox would drop the duplicate anyway, and
        marking items notified without sending them would lose them."""
        with self._connection_factory() as c:
            with c.transaction():
                c.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (notification.delivery_id,))
                if c.execute(
                    "SELECT 1 FROM alerting_notification_outbox WHERE delivery_id = %s",
                    (notification.delivery_id,),
                ).fetchone():
                    return False
                self._enqueue(c, notification, next_attempt_at=now)
                if assignment_ids:
                    c.execute(
                        "UPDATE triage_assignments SET notified_at = %s WHERE id = ANY(%s)",
                        (now, assignment_ids),
                    )
        return True

    # --- profiles and relevance --------------------------------------------

    def profile_ages(self) -> dict[str, datetime | None]:
        """Active maintainers and when their profile was last built."""
        with self._connection_factory() as c:
            rows = c.execute(
                """SELECT m.github_login, p.built_at FROM triage_maintainers m
                   LEFT JOIN triage_maintainer_profiles p USING (github_login) WHERE m.active"""
            ).fetchall()
        return {r[0]: r[1] for r in rows}

    def sync_needs_relevance(self, *, active_maintainers: Iterable[str]) -> int:
        """Keep `triage_scores.needs_relevance` in step with routing eligibility.

        True iff the item is open, in scope, page/route band, has no open/acked/done
        primary owner, has no drop/slop action, is not waiting on its author
        (for non-page band), and is not assigned on GitHub exclusively to people
        outside `active_maintainers`.

        Maintained by `triage-route` so `relevance_queue` (running under the
        restricted `triage_extractor` role) skips owned/suppressed items without
        needing read access to `triage_assignments` or `triage_actions`.
        """
        logins = sorted({m.lower() for m in active_maintainers})
        with self._connection_factory() as c:
            updated = c.execute(
                """
                WITH target AS (
                    SELECT s.item_key,
                           (
                               i.in_scope
                               AND i.state = 'open'
                               AND s.band IN ('page', 'route')
                               AND NOT EXISTS (
                                   SELECT 1 FROM triage_assignments a
                                   WHERE a.item_key = s.item_key
                                     AND a.role = 'primary'
                                     AND a.status IN ('open', 'acked', 'done')
                               )
                               AND NOT EXISTS (
                                   SELECT 1 FROM triage_actions a
                                   WHERE a.item_key = s.item_key
                                     AND a.action IN ('drop', 'slop')
                               )
                               AND NOT (COALESCE(i.prepass->>'waiting_on', '') = 'author' AND s.band <> 'page')
                               -- COALESCE: items ingested before gh_assignees existed have
                               -- no such key; jsonb_typeof(NULL) = 'array' is NULL, which
                               -- would make `want` NULL and violate NOT NULL.
                               AND NOT COALESCE((
                                   jsonb_typeof(i.prepass->'gh_assignees') = 'array'
                                   AND jsonb_array_length(i.prepass->'gh_assignees') > 0
                                   AND NOT EXISTS (
                                       SELECT 1
                                       FROM jsonb_array_elements_text(i.prepass->'gh_assignees') AS g(login)
                                       WHERE lower(g.login) = ANY(%s)
                                   )
                               ), false)
                           ) AS want
                    FROM triage_scores s
                    JOIN triage_items i ON i.item_key = s.item_key
                )
                UPDATE triage_scores s
                SET needs_relevance = target.want
                FROM target
                WHERE s.item_key = target.item_key
                  AND s.needs_relevance IS DISTINCT FROM target.want
                """,
                (logins,),
            ).rowcount
        return int(updated or 0)

    def save_profile(self, login: str, prs: list[dict[str, Any]], *, now: datetime) -> None:
        """Store a maintainer's rebuilt profile, with a snapshot of what they
        recently did with items routed to them (see maintainer_feedback) and
        directory prefixes touched by their authored PRs."""
        with self._connection_factory() as c:
            row = c.execute(
                """SELECT COALESCE(rules->>'natural_language', ''), COALESCE(rules->>'language', 'en')
                   FROM triage_maintainers WHERE github_login = %s""",
                (login,),
            ).fetchone()
            notes, language = (row[0], row[1]) if row else ("", "en")
            feedback = self._maintainer_feedback(c, login, now=now)
            authored_paths = self._authored_paths(c, login)
            c.execute(
                """INSERT INTO triage_maintainer_profiles (github_login, prs, profile_hash, built_at,
                       feedback, authored_paths)
                   VALUES (%s, %s::jsonb, %s, %s, %s::jsonb, %s::jsonb)
                   ON CONFLICT (github_login) DO UPDATE SET prs = EXCLUDED.prs,
                       profile_hash = EXCLUDED.profile_hash, built_at = EXCLUDED.built_at,
                       feedback = EXCLUDED.feedback, authored_paths = EXCLUDED.authored_paths""",
                (login, json.dumps(prs), profile_hash(prs, notes, language, feedback), now,
                 json.dumps(feedback), json.dumps(authored_paths)),
            )

    @staticmethod
    def _authored_paths(c: Any, login: str, *, limit: int = 30) -> dict[str, int]:
        """Top directory prefixes touched by PRs authored by `login` in `triage_items`."""
        rows = c.execute(
            """SELECT files FROM triage_items
               WHERE kind = 'pr' AND lower(author) = lower(%s)
                 AND jsonb_typeof(files) = 'array' AND jsonb_array_length(files) > 0
               ORDER BY gh_created_at DESC LIMIT 200""",
            (login,),
        ).fetchall()
        counts: dict[str, int] = {}
        for (files,) in rows:
            seen_in_pr: set[str] = set()
            for entry in files or []:
                path = entry.get("path") if isinstance(entry, dict) else None
                if isinstance(path, str) and path:
                    seen_in_pr.update(path_prefixes(path))
            for prefix in seen_in_pr:
                counts[prefix] = counts.get(prefix, 0) + 1
        top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
        return dict(top)

    def maintainer_feedback(self, login: str, *, now: datetime) -> dict[str, list[dict[str, Any]]]:
        with self._connection_factory() as c:
            return self._maintainer_feedback(c, login, now=now)

    @staticmethod
    def _maintainer_feedback(c: Any, login: str, *, now: datetime) -> dict[str, list[dict[str, Any]]]:
        """Items this maintainer said "not mine" to (declined) and items
        they acked or finished (took) in the last FEEDBACK_WINDOW, newest
        first, at most FEEDBACK_LIMIT each. Needs triage_actions and
        triage_assignments, so only the worker builds it; the relevance job
        reads the snapshot from triage_maintainer_profiles.feedback."""
        since = now - FEEDBACK_WINDOW
        declined = c.execute(
            """SELECT a.item_key, i.title, max(a.created_at) AS at
               FROM triage_actions a JOIN triage_items i USING (item_key)
               WHERE a.action = 'not_mine' AND lower(a.actor) = lower(%s) AND a.created_at >= %s
               GROUP BY a.item_key, i.title ORDER BY at DESC, a.item_key LIMIT %s""",
            (login, since, FEEDBACK_LIMIT),
        ).fetchall()
        took = c.execute(
            """SELECT a.item_key, i.title, max(COALESCE(a.closed_at, a.updated_at)) AS at
               FROM triage_assignments a JOIN triage_items i USING (item_key)
               WHERE a.maintainer = %s AND a.status IN ('acked', 'done')
                 AND COALESCE(a.closed_at, a.updated_at) >= %s
               GROUP BY a.item_key, i.title ORDER BY at DESC, a.item_key LIMIT %s""",
            (login, since, FEEDBACK_LIMIT),
        ).fetchall()
        return {
            kind: [{"item_key": r[0], "title": r[1], "at": r[2].isoformat()} for r in rows]
            for kind, rows in (("declined", declined), ("took", took))
        }

    def maintainer_profiles(self) -> list[MaintainerProfile]:
        """Active maintainers' profiles. `policy_hash` covers prompt version,
        notes and language so daily PR/feedback refreshes update context for
        new items without invalidating existing judgements."""
        with self._connection_factory() as c:
            rows = c.execute(
                """SELECT m.github_login, p.prs, COALESCE(m.rules->>'natural_language', ''),
                          COALESCE(m.rules->>'language', 'en'), p.feedback, p.authored_paths, m.rules
                   FROM triage_maintainers m JOIN triage_maintainer_profiles p USING (github_login)
                   WHERE m.active ORDER BY m.github_login"""
            ).fetchall()
        return [
            MaintainerProfile(
                r[0],
                list(r[1]),
                r[2],
                profile_hash(list(r[1]), r[2], r[3], dict(r[4])),
                r[3],
                dict(r[4]),
                policy_hash=invalidation_hash(r[2], r[3]),
                authored_paths={str(k): int(v) for k, v in (r[5] or {}).items()},
                rules=dict(r[6] or {}),
            )
            for r in rows
        ]

    def relevance_queue(self, *, limit: int, min_score: int) -> list[RelevanceTask]:
        """Open, extracted, routable items (`s.needs_relevance`) scoring >=
        min_score with at least one active maintainer whose judgement is
        missing or whose policy (`notes`, `language`, `PROMPT_VERSION`) changed."""
        profiles = {p.login: p.effective_policy_hash for p in self.maintainer_profiles()}
        if not profiles:
            return []
        with self._connection_factory() as c:
            rows = c.execute(
                """
                SELECT i.item_key, i.kind, i.title, e.facets, i.content_hash, i.files, i.prepass,
                       COALESCE(i.author, ''),
                       COALESCE((SELECT jsonb_object_agg(r.maintainer, r.profile_hash)
                                 FROM triage_relevance r
                                 WHERE r.item_key = i.item_key AND r.content_hash = i.content_hash),
                                '{}'::jsonb)
                FROM triage_items i
                JOIN triage_scores s USING (item_key)
                JOIN triage_extractions e ON e.id = s.extraction_id
                WHERE i.in_scope AND i.state = 'open' AND s.score >= %s
                  AND s.needs_relevance
                  AND e.content_hash = i.content_hash
                ORDER BY s.score DESC, i.gh_created_at DESC
                """,
                (min_score,),
            ).fetchall()
        tasks: list[RelevanceTask] = []
        for key, kind, title, facets, chash, files, prepass, author, judged in rows:
            author_lower = str(author or "").lower()
            todo = [
                login for login, h in profiles.items()
                if judged.get(login) != h and not (kind == "pr" and author_lower and login.lower() == author_lower)
            ]
            if todo:
                paths = [f["path"] for f in (files or []) if isinstance(f, dict) and f.get("path")]
                tasks.append(RelevanceTask(key, kind, title, dict(facets), chash, todo, files=paths,
                                           prepass=dict(prepass or {}), author=str(author or "")))
                if len(tasks) >= limit:
                    break
        return tasks

    def save_relevance(
        self, task: RelevanceTask, judgments: list[Judgment], *, profiles: dict[str, MaintainerProfile],
        model: str, now: datetime,
    ) -> None:
        with self._connection_factory() as c:
            with c.transaction():
                for j in judgments:
                    c.execute(
                        """INSERT INTO triage_relevance (item_key, maintainer, relevance, evidence_prs, reason,
                               reason_local, content_hash, profile_hash, model, created_at)
                           VALUES (%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (item_key, maintainer) DO UPDATE SET
                               relevance = EXCLUDED.relevance, evidence_prs = EXCLUDED.evidence_prs,
                               reason = EXCLUDED.reason, reason_local = EXCLUDED.reason_local,
                               content_hash = EXCLUDED.content_hash,
                               profile_hash = EXCLUDED.profile_hash, model = EXCLUDED.model,
                               created_at = EXCLUDED.created_at""",
                        (task.item_key, j.maintainer, j.relevance, json.dumps(j.evidence_prs), j.reason,
                         j.reason_local, task.content_hash, profiles[j.maintainer].effective_policy_hash, model, now),
                    )

    # --- maintainers (synced from triage/config/maintainers/*.yaml) --------

    def sync_maintainers(
        self,
        maintainers: list[Maintainer],
        *,
        owner: str = "repo",
        keep_logins: Iterable[str] = (),
    ) -> tuple[int, int]:
        """Make the database match the file: upsert every listed maintainer,
        deactivate file-owned rows that are no longer listed (except logins in
        `keep_logins`, whose files had syntax errors and keep their last good
        rules). Rows created by the dashboard for unlisted people
        (`updated_by = their login`) are left alone."""
        logins = [m.github_login for m in maintainers]
        keep = sorted({*(m.lower() for m in logins), *(k.lower() for k in keep_logins)})
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
                       WHERE updated_by = %s AND active AND NOT (lower(github_login) = ANY(%s))""",
                    (owner, keep),
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
