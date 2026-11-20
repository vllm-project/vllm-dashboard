"""Command handlers for the triage consumers on the alerting worker.

  triage_ingest  every 5 min: GitHub -> triage_items (+ prepass)
  triage_route   every 5 min: re-score stale items, route page/route band
                 items to maintainers, DM page-band owners immediately
  triage_digest  hourly: per-maintainer DM digest at their local morning,
                 team channel digest once a day

Each handler is registered with alerting.runtime.AlertingRuntime, which
gives it idempotent claims and the Slack outbox. In shadow mode every
notification is rendered and stored but never delivered.
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from alerting.commands import ScheduledCommand
from alerting.ports import Clock, DeliveryMode

from triage.ci import BuildkiteBuildPort, next_summary
from triage.config import TriageConfig
from triage.diff import format_diff_excerpt
from triage.github import GitHubClient, GitHubError, IngestClient
from triage.groups import Member, group_reason, number_of, partner_map
from triage.model import Item, Score
from triage.maintainers import MaintainersFileError, parse_maintainer_files
from triage.notify import WAITING_AFTER_DAYS, WAITING_MAX_ITEMS, maintainer_digest, page_dm, team_digest
from triage.prepass import (
    COMMENTS_LIMIT,
    LOGIN,
    compute_prepass,
    content_hash,
    core_content_hash,
    filter_comment_records,
    in_scope,
    prepass_priority,
    whose_move,
)
from triage.relevance import profile_is_stale
from triage.routing import (
    Candidate,
    RoutingContext,
    assigned_elsewhere,
    can_follow,
    choose_owners,
    gh_assignees,
    group_owner,
    involvement,
    waiting_on_author,
)
from triage.scoring import score_item
from triage.model import Maintainer
from triage.store import DigestEntry, NewAssignment, PostgresTriageStore, RoutingRow, StoredItemState, week_ago

log = logging.getLogger(__name__)
CURSOR_OVERLAP = timedelta(minutes=10)
DEFAULT_REEXTRACT_COOLDOWN = timedelta(hours=12)
PROFILE_WINDOW = timedelta(days=180)
# Page-band items opened within this window may exceed a maintainer's weekly
# capacity; older (backlog) items are spread out under it.
FRESH_WINDOW = timedelta(days=3)
FIRST_RUN_LOOKBACK = timedelta(days=2)
# How long routing waits for every active maintainer's relevance judgement,
# counted from when the item became routable (entered the page/route band, or
# was first extracted, whichever is later). The relevance job runs every 10
# minutes, so a healthy item is fully judged well within this; it also covers
# re-judging the open queue after maintainers are added. After it, the item is
# routed among the maintainers who have been judged, so a broken or lagging
# relevance job delays routing by at most this much instead of stopping it.
RELEVANCE_GRACE = timedelta(hours=2)


_UNREAD: Any = object()


@dataclass
class _Groups:
    """Issue + fix PR links for one routing run (triage/groups.py)."""

    partners: dict[str, set[str]] = field(default_factory=dict)
    members: dict[str, Member] = field(default_factory=dict)
    # This run's routing candidates, by key.
    candidates: dict[str, RoutingRow] = field(default_factory=dict)

    def linked(self, key: str) -> list[Member]:
        return [self.members[k] for k in sorted(self.partners.get(key, ())) if k in self.members]

    def member(self, row: RoutingRow) -> Member:
        return self.members.get(row.item_key) or Member(
            row.item_key, number_of(row.item_key), row.kind, "open", row.score, row.band, None)

    def owned(self, keys: set[str], login: str) -> None:
        """Record owners given in this run, so later items in it see them."""
        for key in keys:
            if key in self.members:
                self.members[key] = replace(self.members[key], owner=login)


@dataclass
class IngestHandler:
    store: PostgresTriageStore
    github: IngestClient
    config: TriageConfig
    clock: Clock
    repo: str = "vllm-project/vllm"
    max_items: int = 1000
    # Items per GitHub prefetch (one GraphQL query for their files, comments
    # and named PRs' authors).
    batch_size: int = 25
    # PRs whose "waiting on the author" state is re-read each run.
    status_refresh_limit: int = 50
    # PR CI status (triage/ci.py): Buildkite client (None: off), open P0-P2
    # PRs whose GitHub status is re-read per run (store.CI_REFRESH sets how
    # often each is due), and Buildkite builds fetched per run at most.
    buildkite: BuildkiteBuildPort | None = None
    ci_refresh_limit: int = 150
    ci_build_fetch_limit: int = 15
    # Comment-only updates on an already-extracted item wait this long before
    # re-queueing extraction (0 disables cooldown).
    reextract_cooldown: timedelta = DEFAULT_REEXTRACT_COOLDOWN
    # Max PR unified diffs fetched via REST per ingest run (cached per head_sha).
    diff_fetch_limit: int = 40
    _diffs_fetched: int = field(default=0, init=False, repr=False)

    def __call__(self, command: ScheduledCommand) -> None:
        self._diffs_fetched = 0
        name = f"github:{self.repo}"
        now = self.clock.now()
        since = (self.store.cursor(name) or now - FIRST_RUN_LOOKBACK) - CURSOR_OVERLAP
        items = self.github.updated_items(self.repo, since, max_items=self.max_items)
        newest: datetime | None = None
        for start in range(0, len(items), self.batch_size):
            batch = items[start:start + self.batch_size]
            states = {item.key: self.store.item_state(item.key) for item in batch}
            self._prefetch(batch, states, now)
            for item in batch:
                self._ingest(item, states[item.key])
                newest = item.updated_at if newest is None else max(newest, item.updated_at)
        if newest is not None:
            self.store.set_cursor(name, newest)
        if self.github.reads_pr_status:
            try:
                self._refresh_pr_status(now)
            except GitHubError as exc:
                log.warning("triage: PR status not refreshed: %s", exc)
        log.info("triage ingest: %d items; GitHub calls so far %s, GraphQL points %s",
                 len(items), getattr(self.github, "calls", "?"), getattr(self.github, "cost", "-"))

    def _prefetch(self, batch: list[Item], states: dict[str, StoredItemState | None], now: datetime) -> None:
        """Tell the client what _ingest will ask for, so it can fetch it in one go."""
        files: list[int] = []
        comments: list[int] = []
        authors: set[int] = set()
        for item in batch:
            light = compute_prepass(item, self.config, now)
            if not in_scope(light["scope_reason"]):
                continue
            stored = states[item.key]
            if item.kind == "pr":
                files.append(item.number)
            if rereads_comments(item, stored):
                comments.append(item.number)
            known = (stored.prepass if stored else {}).get("referenced_pr_authors") or {}
            authors.update(n for n in light["referenced_prs"] if str(n) not in known)
        self.github.prefetch(self.repo, files=files, comments=comments, authors=sorted(authors))

    def _ingest(self, item: Item, stored: StoredItemState | None = _UNREAD) -> None:
        now = self.clock.now()
        light = compute_prepass(item, self.config, now)
        scoped = in_scope(light["scope_reason"])
        if stored is _UNREAD:
            stored = self.store.item_state(item.key)
        comments_excerpt = stored.comments_excerpt if stored else ""
        diff_excerpt = stored.diff_excerpt if stored else ""
        diff_head_sha = stored.diff_head_sha if stored else None
        # {login (lower case): latest comment time}; kept until comments are re-read.
        commented_at: dict[str, str] = dict((stored.prepass if stored else {}).get("commented_at") or {})
        commenters: list[str] | None = None
        if scoped:
            if item.kind == "pr":
                item.files = self.github.pull_files(self.repo, item.number)
                needs_diff = (
                    item.state == "open"
                    and (
                        (item.head_sha is not None and diff_head_sha != item.head_sha)
                        or (item.head_sha is None and not diff_excerpt)
                    )
                )
                if needs_diff and self._diffs_fetched < self.diff_fetch_limit and hasattr(self.github, "pull_diff"):
                    try:
                        raw_diff = self.github.pull_diff(self.repo, item.number)
                        self._diffs_fetched += 1
                        diff_excerpt = format_diff_excerpt(raw_diff)
                        diff_head_sha = item.head_sha
                    except GitHubError as exc:
                        log.warning("triage: diff for %s not fetched: %s", item.key, exc)
                item.diff_excerpt = diff_excerpt
            if rereads_comments(item, stored):
                records = self.github.comment_records(self.repo, item.number)
                substantive = filter_comment_records(records)
                comments_excerpt = "\n\n".join(text for _, _, text in substantive)[:COMMENTS_LIMIT]
                # Who wrote the first comments and, on long threads, the latest ones
                # (kept from all human comments so involvement/auto-ack still see short replies).
                seen = [(login, at) for login, at, _ in records] + self.github.comment_tail(self.repo, item.number)
                latest: dict[str, datetime] = {}
                for login, at in seen:
                    key = login.lower()
                    if at is not None and (key not in latest or at > latest[key]):
                        latest[key] = at
                commented_at = {login: at.isoformat() for login, at in latest.items()}
                commenters = list(dict.fromkeys(login for login, _ in seen if LOGIN.fullmatch(login)))
            elif stored is not None and "commenters" in stored.prepass:
                commenters = list(stored.prepass["commenters"])
            # The hash reads the comments back from the stored excerpt whether
            # or not they were just re-read, so it doesn't change on a re-read
            # that found nothing new (it used to: the excerpt joins comments
            # with a blank line, the fresh list with a newline).
            if comments_excerpt:
                item.comments = comments_excerpt.split("\n\n")
        # The PR's CI summary counts toward whose move while it is for this head commit.
        ci = stored.ci if stored and stored.ci and item.head_sha and stored.ci.get("head_sha") == item.head_sha else None
        prepass = compute_prepass(item, self.config, now, ci=ci) if scoped else light
        prepass["core_hash"] = core_content_hash(item)
        if commenters is not None:
            prepass["commenters"] = commenters
        if scoped and commented_at:
            prepass["commented_at"] = commented_at
        if scoped and prepass.get("referenced_prs"):
            prepass["referenced_pr_authors"] = self._pr_authors(
                prepass["referenced_prs"], stored.prepass if stored else {}
            )
        self.store.upsert_item(
            item,
            prepass=prepass,
            priority=prepass_priority(item, prepass),
            content_hash=content_hash(item),
            in_scope=scoped,
            comments_excerpt=comments_excerpt,
            now=now,
            reextract_cooldown=self.reextract_cooldown,
            diff_excerpt=diff_excerpt,
            diff_head_sha=diff_head_sha,
        )

    def _pr_authors(self, numbers: list[int], previous: dict[str, Any]) -> dict[str, str]:
        """Authors of the PRs an item names; reuses earlier lookups."""
        known: dict[str, str] = dict(previous.get("referenced_pr_authors") or {})
        missing = [n for n in numbers if str(n) not in known]
        if missing:
            known.update({str(n): login for n, login in self.github.pull_authors(self.repo, missing).items()})
        return {str(n): known[str(n)] for n in numbers if str(n) in known}

    def _refresh_pr_status(self, now: datetime) -> None:
        """Re-read PRs held back from routing because they wait on their
        author, and open P0-P2 PRs whose CI is due a check (store.ci_due).
        A check finishing or a conflict appearing doesn't bump a PR's
        updatedAt, so the cursor wouldn't see the PR become the reviewers'
        move. Writes only what changed."""
        rows = self.store.waiting_prs(self.repo, limit=self.status_refresh_limit)
        due = self.store.ci_due(self.repo, now=now, limit=self.ci_refresh_limit) if self.buildkite else []
        if not rows and not due:
            return
        prs = {number: (item_key, prepass) for item_key, number, prepass in [*rows, *due]}
        statuses = self.github.pr_statuses(self.repo, sorted(prs))
        ci_due = {item_key for item_key, _, _ in due}
        stored_ci = self.store.pr_ci(key for key, _ in prs.values()) if self.buildkite else {}
        main = self.store.main_ci_jobs(now=now) if ci_due else None
        fetched = 0

        def fetch(number: int) -> dict[str, Any]:
            nonlocal fetched
            fetched += 1
            assert self.buildkite is not None
            return self.buildkite.get_build(number)

        for number, (item_key, prepass) in prs.items():
            status = statuses.get(number)
            if status is None or status.state != "open":
                continue  # closed or merged: the next ingest sees that
            ci = stored_ci.get(item_key)
            if item_key in ci_due and status.head_sha:
                try:
                    summary = next_summary(
                        head_sha=status.head_sha, build_url=status.ci_build_url, stored=ci,
                        main=main, fetch=fetch if fetched < self.ci_build_fetch_limit else None,
                    )
                except (RuntimeError, OSError, ValueError, KeyError) as exc:
                    log.warning("triage: CI of %s not refreshed: %s", item_key, exc)
                    summary = None
                if summary is not None:
                    ci = summary.as_json()
                    self.store.save_pr_ci(item_key, ci, now=now)
            if ci is not None and ci.get("head_sha") != status.head_sha:
                ci = None  # a newer commit: its CI isn't known yet
            fields = whose_move(draft=status.draft, review_decision=status.review_decision,
                                mergeable=status.mergeable, failing_checks=status.failing_checks, ci=ci)
            if any(prepass.get(k) != v for k, v in fields.items()):
                self.store.update_prepass(item_key, fields)
        if ci_due:
            log.info("triage: CI checked for %d PRs (%d Buildkite builds fetched; main CI %s)",
                     len(ci_due), fetched, "known" if main is not None else "unknown")


def rereads_comments(item: Item, stored: StoredItemState | None) -> bool:
    """Comments are read when their count changed, or when the item comes
    into scope (out-of-scope items are stored without comments)."""
    if not item.comment_count:
        return False
    if stored is None or stored.comment_count != item.comment_count:
        return True
    return not in_scope(str(stored.prepass.get("scope_reason") or ""))


@dataclass
class RouteHandler:
    store: PostgresTriageStore
    config: TriageConfig
    clock: Clock
    delivery_mode: DeliveryMode
    # Returns {"<login>.yaml": text} from main, or None when it could not be
    # fetched completely (the sync is then skipped). None here disables sync.
    maintainers_source: Callable[[], dict[str, str] | None] | None = None
    # Builds maintainer profiles (recent PRs) once a day. None disables it.
    github: GitHubClient | None = None
    repo: str = "vllm-project/vllm"
    score_limit: int = 3000
    route_limit: int = 200

    def __call__(self, command: ScheduledCommand) -> None:
        now = self.clock.now()
        self._sync_maintainers()
        # Items leave triage as they age past the window; unacted router
        # assignments on them go too (acked/done ones stay in people's history).
        self.store.expire_out_of_window(now - timedelta(days=self.config.max_age_days))
        # Before routing, so closed items free capacity and reopened ones get
        # their owner back instead of a new one.
        closed, reopened, acked = self.store.follow_github(now=now)
        if closed or reopened or acked:
            log.info("triage: from GitHub, %d assignments closed, %d reopened, %d acked", closed, reopened, acked)
        self._refresh_profiles(now)
        self.store.backfill_fixes_issues()
        self._rescore(now)
        self._route(now)

    def _refresh_profiles(self, now: datetime) -> None:
        if self.github is None:
            return
        for login, built_at in self.store.profile_ages().items():
            if not profile_is_stale(built_at, now):
                continue
            try:
                prs = self.github.maintainer_prs(self.repo, login, since=now - PROFILE_WINDOW)
            except GitHubError as exc:
                log.warning("profile for %s not refreshed: %s", login, exc)
                continue
            self.store.save_profile(login, prs, now=now)

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
        judged_by = {m.github_login for m in maintainers}
        if hasattr(self.store, "sync_needs_relevance"):
            self.store.sync_needs_relevance(active_maintainers=judged_by)
        rows = self.store.routing_candidates(limit=self.route_limit)
        partners = partner_map(self.store.fix_links(open_only=True))
        groups = _Groups(partners, self.store.group_members(partners), {r.item_key: r for r in rows})
        routed: set[str] = set()
        partial: dict[str, set[str]] = {}  # item -> maintainers still unjudged, past the grace
        # Pass 1 gives every clear match (involved / high) its slot across the
        # whole queue; pass 2 lets "medium" and rule matches use what is left.
        for strong_only in (True, False):
            for row in rows:
                if row.item_key not in routed:
                    routed |= self._route_one(
                        row, maintainers, by_login, load, judged_by, now, strong_only=strong_only,
                        partial=partial, groups=groups, routed=routed,
                    )
        if routed and hasattr(self.store, "sync_needs_relevance"):
            self.store.sync_needs_relevance(active_maintainers=judged_by)
        if partial:
            missing = Counter(login for logins in partial.values() for login in logins)
            log.warning(
                "triage: %d item(s) waited over %s for relevance and were considered with partial "
                "judgements (%d routed); missing judgements per maintainer: %s",
                len(partial), RELEVANCE_GRACE, len(partial.keys() & routed),
                ", ".join(f"{login}={n}" for login, n in sorted(missing.items())),
            )

    def _route_one(
        self, row: RoutingRow, maintainers: list[Maintainer], by_login: dict[str, Maintainer],
        load: dict[str, int], judged_by: set[str], now: datetime, *, strong_only: bool,
        partial: dict[str, set[str]] | None = None, groups: _Groups | None = None,
        routed: set[str] | None = None,
    ) -> set[str]:
        """Route one item (and the members of its issue/fix-PR group that
        follow it); returns the keys routed."""
        groups = groups or _Groups()
        # A PR waiting on its author (draft, failing pre-commit/DCO, merge
        # conflict, changes requested) isn't routed: there's nothing for a
        # reviewer to do yet. It stays on the dashboard, and is routed once
        # it's the reviewers' move. P0 PRs are routed anyway.
        if waiting_on_author(row.prepass, row.band):
            return set()
        # Assigned on GitHub to someone outside triage: they are handling it.
        if assigned_elsewhere(row.prepass, judged_by):
            return set()
        ctx = self._context(row, now)
        excluded = set(row.excluded)
        linked = groups.linked(row.item_key)
        # Part of a group someone already owns: it goes to them, without a
        # new capacity slot (triage/groups.py).
        follow = group_owner(ctx, linked, by_login, load=load, excluded=excluded, today=now.date())
        if follow is not None:
            candidate, member = follow
            self._commit(row, [candidate], [], by_login, maintainers, now, grouped_with=member.item_key)
            groups.owned({row.item_key}, candidate.maintainer.github_login)
            return {row.item_key}
        # Wait for relevance judgements unless someone is already involved,
        # so an early rule match doesn't pre-empt the right person. Wait only
        # for RELEVANCE_GRACE, though: after that, route among those judged.
        # A missing judgement is never a match (choose_owners only routes on
        # "high"/"medium" judgements that exist), so an unjudged maintainer
        # can still get the item through involvement or their own rules, but
        # never through relevance.
        people = {str(c).lower() for c in row.prepass.get("commenters") or []}
        people |= {str(a).lower() for a in (row.prepass.get("referenced_pr_authors") or {}).values()}
        people |= gh_assignees(row.prepass)
        involved = bool(people & {login.lower() for login in judged_by})
        missing = judged_by - set(row.relevance)
        if self.github is not None and missing and not involved:
            if not relevance_grace_over(row, now):
                return set()
            if partial is not None:
                partial[row.item_key] = missing
        # Nobody owns the group yet: route it with its highest score and
        # band, so a P1 PR fixing a P0 issue is routed as a P0.
        top = max((m for m in linked if m.owner is None and m.state == "open" and m.score is not None
                   and m.band in ("page", "route")), key=lambda m: m.score or 0, default=None)
        if top is not None and top.score is not None and top.score > ctx.score:
            ctx = replace(ctx, score=top.score, band=top.band)  # type: ignore[arg-type]
        owners = choose_owners(ctx, maintainers, load=load, excluded=excluded,
                               today=now.date(), strong_only=strong_only)
        if not owners:
            return set()
        primary = by_login[owners[0].maintainer.github_login]
        followers = self._followers(row, primary, groups, judged_by, now, routed or set(), ctx.score)
        self._commit(row, owners, followers, by_login, maintainers, now, band=ctx.band)
        # One slot for the whole group: followers don't count (store.maintainer_load).
        load[primary.github_login] = load.get(primary.github_login, 0) + 1
        keys = {row.item_key, *(f.item_key for f, _ in followers)}
        groups.owned(keys, primary.github_login)
        return keys

    @staticmethod
    def _context(row: RoutingRow, now: datetime) -> RoutingContext:
        return RoutingContext(
            item_key=row.item_key, kind=row.kind, title=row.title, score=row.score,
            band=row.band,  # type: ignore[arg-type]
            facets=row.facets, prepass=row.prepass, files=row.files,
            relevance=row.relevance,
            fresh=row.created_at is None or now - row.created_at <= FRESH_WINDOW,
        )

    def _followers(
        self, row: RoutingRow, owner: Maintainer, groups: _Groups, judged_by: set[str], now: datetime,
        routed: set[str], score: int,
    ) -> list[tuple[RoutingRow, Member]]:
        """The unowned members of `row`'s group that go to `owner` with it,
        each with the member it is linked to (for its reason). Only this
        run's routing candidates, and only those `owner` may take
        (routing.can_follow)."""
        out: list[tuple[RoutingRow, Member]] = []
        seen = {row.item_key}
        queue = [row]
        while queue:
            current = queue.pop(0)
            for key in sorted(groups.partners.get(current.item_key, ())):
                other = groups.candidates.get(key)
                if key in seen or key in routed or other is None:
                    continue
                seen.add(key)
                if waiting_on_author(other.prepass, other.band) or assigned_elsewhere(other.prepass, judged_by):
                    continue
                if not can_follow(owner, self._context(other, now), excluded=set(other.excluded),
                                  today=now.date(), score=max(score, other.score)):
                    continue
                out.append((other, groups.member(current)))
                queue.append(other)
        return out

    def _commit(
        self, row: RoutingRow, owners: list[Candidate], followers: list[tuple[RoutingRow, Member]],
        by_login: dict[str, Maintainer], maintainers: list[Maintainer], now: datetime, *,
        band: str | None = None, grouped_with: str | None = None,
    ) -> None:
        """Store the assignments for `row` (and its followers, primary only)
        and queue the immediate DM: one per owner, showing the whole group
        when followers come along (the issue first, its fix PRs under it)."""
        band = band or row.band
        assignments: list[NewAssignment] = []
        follower_notified = False
        for index, candidate in enumerate(owners):
            role = "primary" if index == 0 else "backup"
            maintainer = by_login[candidate.maintainer.github_login]
            notification = None
            wants_now = band == "page" or maintainer.notify_mode == "immediate"
            if wants_now and maintainer.notify_mode != "off" and maintainer.slack_user_id:
                lang = str(maintainer.rules.get("language") or "en")
                entries = [self._entry(row, candidate.reasons, maintainer)]
                if role == "primary":
                    entries += [self._entry(f, self._follower_reasons(f, m, maintainer, now), maintainer)
                                for f, m in followers]
                # PRs carry their CI (triage_pr_ci) into the DM line.
                cis = self.store.pr_ci([e.item_key for e in entries if e.kind == "pr"])
                entries = [replace(e, ci=cis.get(e.item_key)) for e in entries]
                main, fixes = _group_main(entries)
                notification = page_dm(
                    assignment_key=f"{row.item_key}:{maintainer.github_login}:{role}",
                    maintainer_slack=maintainer.slack_user_id, entry=main, role=role,
                    mode=self.delivery_mode,
                    reassign_to=[m.github_login for m in maintainers if m.github_login != maintainer.github_login],
                    lang=lang, fixes=fixes,
                )
                follower_notified = follower_notified or role == "primary"
            reason: dict[str, Any] = {
                "matched": candidate.reasons,
                "why": str((row.relevance.get(maintainer.github_login) or {}).get("reason") or ""),
                "load": candidate.load, "capacity": maintainer.capacity_per_week,
            }
            if grouped_with and role == "primary":
                reason["grouped_with"] = grouped_with
            assignments.append(NewAssignment(maintainer=maintainer.github_login, role=role, reason=reason,
                                             notification=notification))
        routes: list[tuple[str, int, list[NewAssignment]]] = [(row.item_key, row.score, assignments)]
        if followers:
            owner = by_login[owners[0].maintainer.github_login]
            for other, member in followers:
                routes.append((other.item_key, other.score, [NewAssignment(
                    maintainer=owner.github_login, role="primary",
                    reason={"matched": self._follower_reasons(other, member, owner, now),
                            "why": str((other.relevance.get(owner.github_login) or {}).get("reason") or ""),
                            "grouped_with": member.item_key,
                            "load": owners[0].load, "capacity": owner.capacity_per_week},
                    notification=None, notified=follower_notified,
                )]))
        self.store.commit_routes(routes, now=now)

    def _follower_reasons(self, row: RoutingRow, member: Member, owner: Maintainer, now: datetime) -> list[str]:
        return [group_reason(member), *involvement(owner.github_login, self._context(row, now))]

    @staticmethod
    def _entry(row: RoutingRow, reasons: list[str], maintainer: Maintainer) -> DigestEntry:
        return DigestEntry(
            0, row.item_key, row.title, row.html_url, row.score, row.band,
            str(row.facets.get("summary") or ""), reasons,
            str((row.relevance.get(maintainer.github_login) or {}).get("reason_local") or ""),
            kind=row.kind,
        )


def _group_main(entries: list[DigestEntry]) -> tuple[DigestEntry, list[DigestEntry]]:
    """The entry a group is shown under (its highest-scored issue, else the
    first entry) and the rest, highest score first."""
    issues = [e for e in entries if e.kind == "issue"]
    main = max(issues, key=lambda e: e.score) if issues else entries[0]
    return main, sorted((e for e in entries if e is not main), key=lambda e: -e.score)


def relevance_grace_over(row: RoutingRow, now: datetime) -> bool:
    """True once the item has waited RELEVANCE_GRACE for relevance
    judgements (or when we can't tell how long it has waited)."""
    return row.waiting_since is None or now - row.waiting_since >= RELEVANCE_GRACE


# Maintainers get their digest at this local hour unless their file sets
# `digest_hour`; with no `timezone` it is UTC.
DEFAULT_DIGEST_HOUR = 9
# The team channel digest goes out once a day at this UTC hour (as before).
TEAM_DIGEST_HOUR_UTC = 15


def maintainer_local_time(maintainer: Maintainer, now: datetime) -> datetime:
    """`now` in the maintainer's own time zone (UTC if unset or unknown)."""
    name = maintainer.rules.get("timezone")
    tz: tzinfo = timezone.utc
    if isinstance(name, str) and name:
        try:
            tz = ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            log.warning("triage: unknown timezone %r for %s; using UTC", name, maintainer.github_login)
    return now.astimezone(tz)


def digest_hour(maintainer: Maintainer) -> int:
    hour = maintainer.rules.get("digest_hour")
    return hour if isinstance(hour, int) and not isinstance(hour, bool) and 0 <= hour <= 23 else DEFAULT_DIGEST_HOUR


@dataclass
class DigestHandler:
    """Runs hourly. Each maintainer's DM digest goes out in the run where
    their local hour is their digest_hour (09:00 by default, UTC unless
    their file sets `timezone`), at most once per local day: the delivery
    id carries the local date and commit_digest skips one already queued.
    An hour skipped by a daylight-saving jump means no digest that day;
    the items wait for the next one. The team channel digest goes out once
    a day at team_digest_hour_utc."""

    store: PostgresTriageStore
    clock: Clock
    delivery_mode: DeliveryMode
    team_channel: str | None
    suppression_threshold: int = 10
    team_digest_hour_utc: int = TEAM_DIGEST_HOUR_UTC

    def __call__(self, command: ScheduledCommand) -> None:
        now = self.clock.now()
        active = self.store.active_maintainers()
        for maintainer in active:
            if maintainer.notify_mode == "off" or not maintainer.slack_user_id:
                continue
            local = maintainer_local_time(maintainer, now)
            if local.hour != digest_hour(maintainer):
                continue
            entries = self.store.unnotified_assignments(maintainer.github_login)
            waiting, waiting_total = self.store.waiting_assignments(
                maintainer.github_login, assigned_before=now - timedelta(days=WAITING_AFTER_DAYS),
                limit=WAITING_MAX_ITEMS,
            )
            if not entries and not waiting:
                continue
            # Reminders are not re-marked: notified_at stays the first send.
            self.store.commit_digest(
                maintainer_digest(
                    maintainer=maintainer.github_login, maintainer_slack=maintainer.slack_user_id,
                    entries=entries, day=local, mode=self.delivery_mode,
                    lang=str(maintainer.rules.get("language") or "en"),
                    reassign_to=[m.github_login for m in active if m.github_login != maintainer.github_login],
                    waiting=waiting, waiting_total=waiting_total,
                ),
                [e.assignment_id for e in entries],
                now=now,
            )
        if now.astimezone(timezone.utc).hour != self.team_digest_hour_utc:
            return
        suppression = self.store.suppression_since(now - timedelta(days=1), threshold=self.suppression_threshold)
        for actor, drops, slops in suppression:
            log.warning("triage: %s hid %d items in 24h (%d dropped, %d slop)", actor, drops + slops, drops, slops)
        if self.team_channel:
            top = self.store.top_new_items(since=now - timedelta(days=1), limit=30)
            self.store.commit_digest(
                team_digest(channel=self.team_channel, entries=top, day=now.astimezone(timezone.utc),
                            mode=self.delivery_mode, suppression=suppression),
                [],
                now=now,
            )
