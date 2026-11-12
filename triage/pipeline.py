"""Command handlers for the triage consumers on the alerting worker.

  triage_ingest  every 5 min: GitHub -> triage_items (+ prepass)
  triage_route   every 5 min: re-score stale items, route page/route band
                 items to maintainers, DM page-band owners immediately
  triage_digest  daily: per-maintainer DM digest + team channel digest

Each handler is registered with alerting.runtime.AlertingRuntime, which
gives it idempotent claims and the Slack outbox. In shadow mode every
notification is rendered and stored but never delivered.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from alerting.commands import ScheduledCommand
from alerting.ports import Clock, DeliveryMode

from triage.config import TriageConfig
from triage.github import GitHubClient, item_from_raw
from triage.model import Item, Score
from triage.maintainers import MaintainersFileError, parse_maintainer_files
from triage.notify import maintainer_digest, page_dm, team_digest
from triage.prepass import (
    COMMENTS_LIMIT,
    compute_prepass,
    content_hash,
    in_scope,
    prepass_priority,
)
from triage.routing import RoutingContext, choose_owners
from triage.scoring import score_item
from triage.store import DigestEntry, NewAssignment, PostgresTriageStore, week_ago

log = logging.getLogger(__name__)
CURSOR_OVERLAP = timedelta(minutes=10)
FIRST_RUN_LOOKBACK = timedelta(days=2)


@dataclass
class IngestHandler:
    store: PostgresTriageStore
    github: GitHubClient
    config: TriageConfig
    clock: Clock
    repo: str = "vllm-project/vllm"
    max_items: int = 1000

    def __call__(self, command: ScheduledCommand) -> None:
        name = f"github:{self.repo}"
        now = self.clock.now()
        since = (self.store.cursor(name) or now - FIRST_RUN_LOOKBACK) - CURSOR_OVERLAP
        newest: datetime | None = None
        for raw in self.github.issues_updated_since(self.repo, since, max_items=self.max_items):
            item = item_from_raw(self.repo, raw)
            self._ingest(item)
            newest = item.updated_at if newest is None else max(newest, item.updated_at)
        if newest is not None:
            self.store.set_cursor(name, newest)

    def _ingest(self, item: Item) -> None:
        light = compute_prepass(item, self.config)
        scoped = in_scope(light["scope_reason"])
        stored = self.store.item_state(item.key)
        comments_excerpt = stored.comments_excerpt if stored else ""
        if scoped:
            if item.kind == "pr":
                item.files = self.github.pull_files(self.repo, item.number)
            if item.comment_count and (stored is None or stored.comment_count != item.comment_count):
                item.comments = self.github.comments(self.repo, item.number)
                comments_excerpt = "\n\n".join(item.comments)[:COMMENTS_LIMIT]
            elif comments_excerpt:
                item.comments = comments_excerpt.split("\n\n")
        prepass = compute_prepass(item, self.config) if scoped else light
        self.store.upsert_item(
            item,
            prepass=prepass,
            priority=prepass_priority(item, prepass),
            content_hash=content_hash(item),
            in_scope=scoped,
            comments_excerpt=comments_excerpt,
        )


@dataclass
class RouteHandler:
    store: PostgresTriageStore
    config: TriageConfig
    clock: Clock
    delivery_mode: DeliveryMode
    # Returns {"<login>.yaml": text} from main, or None when it could not be
    # fetched completely (the sync is then skipped). None here disables sync.
    maintainers_source: Callable[[], dict[str, str] | None] | None = None
    repo: str = "vllm-project/vllm"
    score_limit: int = 3000
    route_limit: int = 200

    def __call__(self, command: ScheduledCommand) -> None:
        now = self.clock.now()
        self._sync_maintainers()
        self._rescore(now)
        self._route(now)

    def _sync_maintainers(self) -> None:
        if self.maintainers_source is None:
            return
        files = self.maintainers_source()
        if files is None:
            log.warning("maintainer files could not be fetched; keeping current rules")
            return
        try:
            maintainers = parse_maintainer_files(files)
        except MaintainersFileError as exc:
            # Keep the last good rules; a broken merge must not unroute everyone.
            log.error("maintainer files rejected: %s", exc)
            return
        self.store.sync_maintainers(maintainers)

    def _rescore(self, now: datetime) -> None:
        rows = self.store.scoring_candidates(scoring_version=self.config.version, limit=self.score_limit)
        linked = {n for r in rows if r.kind == "pr" for n in self._fixes(r.prepass, r.facets)}
        issue_scores = self.store.issue_scores(self.repo, linked)
        results: list[tuple[str, int | None, Score]] = []
        for row in rows:  # issues come first, so PRs see fresh issue scores
            score = score_item(
                kind=row.kind, draft=row.draft, reactions=row.reactions,
                comment_count=row.comment_count, prepass=row.prepass, facets=row.facets,
                config=self.config, linked_issue_scores=issue_scores,
            )
            if row.kind == "issue" and row.state == "open":
                issue_scores[row.number] = score.score
            results.append((row.item_key, row.extraction_id, score))
        self.store.save_scores(results, now=now)

    @staticmethod
    def _fixes(prepass: dict[str, Any], facets: dict[str, Any] | None) -> set[int]:
        out = set(prepass.get("linked_issues") or [])
        if facets and facets.get("pr"):
            out |= set(facets["pr"].get("fixes_issues") or [])
        return out

    def _route(self, now: datetime) -> None:
        maintainers = self.store.active_maintainers()
        if not maintainers:
            return
        by_login = {m.github_login: m for m in maintainers}
        load = self.store.maintainer_load(since=week_ago(now))
        for row in self.store.routing_candidates(limit=self.route_limit):
            ctx = RoutingContext(
                item_key=row.item_key, kind=row.kind, title=row.title, score=row.score,
                band=row.band,  # type: ignore[arg-type]
                facets=row.facets, prepass=row.prepass, files=row.files,
            )
            owners = choose_owners(ctx, maintainers, load=load, excluded=set(row.excluded), today=now.date())
            if not owners:
                continue
            assignments: list[NewAssignment] = []
            for index, candidate in enumerate(owners):
                role = "primary" if index == 0 else "backup"
                maintainer = by_login[candidate.maintainer.github_login]
                notification = None
                wants_now = row.band == "page" or maintainer.notify_mode == "immediate"
                if wants_now and maintainer.notify_mode != "off" and maintainer.slack_user_id:
                    entry = DigestEntry(
                        0, row.item_key, row.title, row.html_url, row.score, row.band,
                        str(row.facets.get("summary") or ""), list(candidate.matched),
                    )
                    notification = page_dm(
                        assignment_key=f"{row.item_key}:{maintainer.github_login}:{role}",
                        maintainer_slack=maintainer.slack_user_id, entry=entry, role=role,
                        mode=self.delivery_mode,
                    )
                assignments.append(NewAssignment(
                    maintainer=maintainer.github_login, role=role,
                    reason={"matched": list(candidate.matched), "load": candidate.load,
                            "capacity": maintainer.capacity_per_week},
                    notification=notification,
                ))
                if role == "primary":
                    load[maintainer.github_login] = load.get(maintainer.github_login, 0) + 1
            self.store.commit_assignments(row.item_key, row.score, assignments, now=now)


@dataclass
class DigestHandler:
    store: PostgresTriageStore
    clock: Clock
    delivery_mode: DeliveryMode
    team_channel: str | None

    def __call__(self, command: ScheduledCommand) -> None:
        now = self.clock.now()
        for maintainer in self.store.active_maintainers():
            if maintainer.notify_mode == "off" or not maintainer.slack_user_id:
                continue
            entries = self.store.unnotified_assignments(maintainer.github_login)
            if not entries:
                continue
            self.store.commit_digest(
                maintainer_digest(
                    maintainer=maintainer.github_login, maintainer_slack=maintainer.slack_user_id,
                    entries=entries, day=now, mode=self.delivery_mode,
                ),
                [e.assignment_id for e in entries],
                now=now,
            )
        if self.team_channel:
            top = self.store.top_new_items(since=now - timedelta(days=1), limit=30)
            self.store.commit_digest(
                team_digest(channel=self.team_channel, entries=top, day=now, mode=self.delivery_mode),
                [],
                now=now,
            )
