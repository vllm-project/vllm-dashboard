import { queueFocusCte, queueViewWhere } from "@/lib/triage-queue-filters";
import { getDb } from "@/lib/db";
import {
  fixtureActiveMaintainers,
  fixtureItemDetail,
  fixtureMaintainer,
  fixtureMyPlate,
  fixtureQueue,
  fixtureStats,
  triageDevFixturesEnabled,
} from "@/lib/triage-fixtures";
import { OWNER_NONE, type QueueFilters } from "@/lib/triage-query";
import {
  GROUP_ACTIONS,
  checkUndo,
  memberRequest,
  planTriageAction,
  planUndo,
  type UndoActionRow,
  type UndoAssignmentState,
  type UndoResult,
  type UndoStep,
  type ActionPlan,
  type ActionRequest,
  type AssignmentState,
  type PlanResult,
} from "@/lib/triage-actions";
import { matchRules, normalizeRules } from "@/lib/triage-rules";
import { toTriageCi, type TriageCi } from "@/lib/triage-ci";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";
import {
  commentersFromExcerpt,
  explainUnowned,
  type RelevanceLevel,
  type WhyUnowned,
} from "@/lib/triage-why-unowned";
import type {
  TriageRelevance,
  TriageAssignment,
  TriageBreakdownEntry,
  TriageAssignmentSummary,
  TriageFacets,
  TriageItemDetail,
  TriageLinkedItem,
  TriageMaintainer,
  TriageMyPlate,
  TriagePipelineHealth,
  TriagePrepass,
  TriageQueueItem,
  TriageQueueResponse,
  TriageRules,
  TriageStats,
} from "@/lib/triage-types";
import type { NotifyMode } from "@/lib/triage-vocab";

type Db = ReturnType<typeof getDb>;

/**
 * Whether migration 0048 (`triage_actions.undone_at`) is applied. The
 * dashboard deploys on merge, possibly before the migration runs, so every
 * reader checks once (cached; re-checked each minute until it appears) and
 * leaves the filter out while the column is missing (no row can be undone
 * then anyway).
 */
let undoneColumn: { present: boolean; checkedAt: number } | null = null;

export async function hasUndoneColumn(db: Db): Promise<boolean> {
  if (undoneColumn && (undoneColumn.present || Date.now() - undoneColumn.checkedAt < 60_000)) {
    return undoneColumn.present;
  }
  const [row] = await db<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'triage_actions' AND column_name = 'undone_at'
    ) AS present
  `;
  undoneColumn = { present: !!row?.present, checkedAt: Date.now() };
  return undoneColumn.present;
}

/** `AND <alias>.undone_at IS NULL` when the column exists, else nothing. */
function liveAction(db: Db, present: boolean, alias?: string) {
  if (!present) return db``;
  return alias ? db`AND ${db(alias)}.undone_at IS NULL` : db`AND undone_at IS NULL`;
}

interface QueueRow {
  item_key: string;
  repo: string;
  number: number;
  kind: "issue" | "pr";
  title: string;
  html_url: string;
  author: string;
  state: string;
  draft: boolean;
  gh_created_at: Date;
  gh_updated_at: Date;
  score: number | null;
  band: string | null;
  unowned_reason?: { summary?: unknown } | null;
  facets: TriageFacets | null;
  prepass: TriagePrepass | null;
  assignments: TriageAssignmentSummary[] | null;
  total?: string | number;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function toQueueItem(row: QueueRow): TriageQueueItem {
  const facets = row.facets ?? {};
  const areas = new Set([...strings(facets.areas), ...strings(row.prepass?.areas)]);
  return {
    itemKey: row.item_key,
    repo: row.repo,
    number: row.number,
    kind: row.kind,
    title: row.title,
    htmlUrl: row.html_url,
    author: row.author,
    state: row.state,
    draft: row.draft,
    ghCreatedAt: iso(row.gh_created_at)!,
    ghUpdatedAt: iso(row.gh_updated_at)!,
    score: row.score,
    band: row.band,
    summary: typeof facets.summary === "string" ? facets.summary : null,
    type: typeof facets.type === "string" ? facets.type : null,
    areas: [...areas],
    models: Array.isArray(facets.models)
      ? facets.models
          .map((model) => model?.name)
          .filter((name): name is string => typeof name === "string")
      : [],
    hardware: strings(facets.hardware),
    serving: strings(facets.serving),
    severity:
      facets.severity && typeof facets.severity === "object" && !Array.isArray(facets.severity)
        ? facets.severity
        : null,
    assignments: row.assignments ?? [],
    waitingOn:
      row.prepass?.waiting_on === "author" || row.prepass?.waiting_on === "reviewer" ? row.prepass.waiting_on : null,
    reviewDecision: row.prepass?.review_decision ?? null,
    mergeReady: row.prepass?.merge_ready === true,
    mergeCheckedAt: row.prepass?.merge_checked_at ?? null,
    prSize: typeof facets.pr?.size === "string" ? facets.pr.size : null,
    hasTests: typeof facets.pr?.has_tests === "boolean" ? facets.pr.has_tests : null,
    isMaintainer: row.prepass?.is_maintainer === true,
    firstTime: row.prepass?.first_time === true,
    unownedReason:
      row.unowned_reason && typeof row.unowned_reason === "object" && typeof row.unowned_reason.summary === "string"
        ? row.unowned_reason.summary
        : null,
    fixes: [],
    fixedBy: [],
  };
}

export interface GroupLinks {
  fixes: TriageLinkedItem[];
  fixedBy: TriageLinkedItem[];
}

/**
 * Issue + fix PR links touching `keys` (triage/groups.py; the SQL mirrors
 * `fix_links` in triage/store.py): for each key, the issues it fixes (a PR)
 * or the PRs that fix it (an issue), with their state, score and owner.
 */
export async function groupLinks(db: Db, keys: readonly string[]): Promise<Map<string, GroupLinks>> {
  const out = new Map<string, GroupLinks>();
  if (keys.length === 0) return out;
  const rows = await db<
    {
      pr_key: string;
      issue_key: string;
      side: "pr" | "issue";
      item_key: string;
      number: number;
      kind: "issue" | "pr";
      title: string;
      state: string;
      html_url: string;
      score: number | null;
      band: string | null;
      owner: string | null;
    }[]
  >`
    WITH links AS (
      SELECT p.item_key AS pr_key, t.item_key AS issue_key
      FROM triage_items p
      LEFT JOIN LATERAL (
        SELECT x.facets FROM triage_extractions x WHERE x.item_key = p.item_key
        ORDER BY x.created_at DESC, x.id DESC LIMIT 1
      ) e ON true
      CROSS JOIN LATERAL (
        SELECT DISTINCT n.num FROM jsonb_array_elements_text(
          (CASE WHEN jsonb_typeof(p.prepass->'fixes_issues') = 'array'
                THEN p.prepass->'fixes_issues' ELSE '[]'::jsonb END)
          || (CASE WHEN jsonb_typeof(e.facets->'pr'->'fixes_issues') = 'array'
                   THEN e.facets->'pr'->'fixes_issues' ELSE '[]'::jsonb END)) AS n(num)
        WHERE n.num ~ '^[0-9]{1,9}$'
      ) f
      JOIN triage_items t ON t.item_key = p.repo || '#' || f.num AND t.kind = 'issue'
      WHERE p.kind = 'pr'
    ),
    touching AS (
      SELECT pr_key, issue_key, 'issue' AS side, issue_key AS item_key FROM links WHERE pr_key IN ${db(keys as string[])}
      UNION
      SELECT pr_key, issue_key, 'pr' AS side, pr_key AS item_key FROM links WHERE issue_key IN ${db(keys as string[])}
    )
    SELECT l.pr_key, l.issue_key, l.side, i.item_key, i.number, i.kind, i.title, i.state, i.html_url,
           s.score, s.band,
           (SELECT a.maintainer FROM triage_assignments a
             WHERE a.item_key = i.item_key AND a.role = 'primary' AND a.status IN ('open', 'acked')
             ORDER BY a.assigned_at DESC, a.id DESC LIMIT 1) AS owner
    FROM touching l
    JOIN triage_items i ON i.item_key = l.item_key
    LEFT JOIN triage_scores s ON s.item_key = i.item_key
    ORDER BY s.score DESC NULLS LAST, i.number
  `;
  const entry = (key: string) => {
    let value = out.get(key);
    if (!value) {
      value = { fixes: [], fixedBy: [] };
      out.set(key, value);
    }
    return value;
  };
  for (const row of rows) {
    const linked: TriageLinkedItem = {
      itemKey: row.item_key,
      number: Number(row.number),
      kind: row.kind,
      title: row.title,
      state: row.state,
      htmlUrl: row.html_url,
      score: row.score,
      band: row.band,
      owner: row.owner,
    };
    if (row.side === "issue") entry(row.pr_key).fixes.push(linked);
    else entry(row.issue_key).fixedBy.push(linked);
  }
  return out;
}

async function withGroupLinks<T extends TriageQueueItem>(db: Db, items: T[]): Promise<T[]> {
  const links = await groupLinks(db, items.map((item) => item.itemKey));
  return items.map((item) => ({ ...item, ...(links.get(item.itemKey) ?? { fixes: [], fixedBy: [] }) }));
}

/**
 * The columns every queue-shaped query returns: the item, its current score,
 * its latest extraction's facets, and its open/acked assignments.
 */
function queueSelect(db: Db) {
  return db`
    SELECT i.item_key, i.repo, i.number, i.kind, i.title, i.html_url, i.author,
           i.state, i.draft, i.gh_created_at, i.gh_updated_at, i.prepass,
           s.score, s.band, s.unowned_reason, e.facets,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', a.id, 'maintainer', a.maintainer,
                      'role', a.role, 'status', a.status)
                    ORDER BY a.role, a.assigned_at)
             FROM triage_assignments a
             WHERE a.item_key = i.item_key AND a.status IN ('open', 'acked')
           ), '[]'::jsonb) AS assignments
  `;
}

/**
 * CI status of these PRs (triage_pr_ci, see triage/ci.py), by item key. A
 * separate query so lists keep working before migration 0044 is applied.
 */
async function ciByItem(db: Db, itemKeys: string[]): Promise<Map<string, TriageCi>> {
  const out = new Map<string, TriageCi>();
  if (itemKeys.length === 0) return out;
  try {
    const rows = await db<Record<string, unknown>[]>`
      SELECT * FROM triage_pr_ci WHERE item_key IN ${db(itemKeys)}
    `;
    for (const row of rows) {
      const ci = toTriageCi(row);
      if (ci) out.set(String(row.item_key), ci);
    }
  } catch (error) {
    if (!hasPostgresErrorCode(error, "42P01")) throw error; // undefined_table: not migrated yet
  }
  return out;
}

/** Adds `ci` to the open PRs of a queue-shaped list. */
async function withCi<T extends TriageQueueItem>(db: Db, items: T[]): Promise<T[]> {
  const ci = await ciByItem(db, items.filter((i) => i.kind === "pr" && i.state === "open").map((i) => i.itemKey));
  return items.map((item) => ({ ...item, ci: ci.get(item.itemKey) ?? null }));
}

/**
 * Adds Suggested to close reasons (competing non-draft open PRs, low effort, slop
 * signals) to a cleanup-filtered list so each row explains why it is listed.
 */
async function withCleanupInfo(
  db: Db,
  rows: readonly QueueRow[],
  items: TriageQueueItem[],
): Promise<TriageQueueItem[]> {
  if (items.length === 0) return items;
  const keys = items.map((item) => item.itemKey);
  const peerRows = await db<{
    pr_key: string;
    issue_number: number;
    other_key: string;
    other_number: number;
    other_url: string;
  }[]>`
    ${queueFocusCte(db, "cleanup")}
    SELECT a.pr_key, a.issue_number::int AS issue_number,
           b.pr_key AS other_key, o.number AS other_number, o.html_url AS other_url
    FROM open_fix_links a
    JOIN open_fix_links b
      ON a.repo = b.repo AND a.issue_number = b.issue_number AND a.pr_key <> b.pr_key
    JOIN triage_items o ON o.item_key = b.pr_key
    WHERE a.pr_key IN ${db(keys)} AND NOT a.draft AND NOT b.draft
    ORDER BY a.issue_number::int, o.number
  `;
  const peersByPr = new Map<string, Map<number, { itemKey: string; number: number; htmlUrl: string }[]>>();
  for (const row of peerRows) {
    let byIssue = peersByPr.get(row.pr_key);
    if (!byIssue) {
      byIssue = new Map();
      peersByPr.set(row.pr_key, byIssue);
    }
    const list = byIssue.get(row.issue_number) ?? [];
    list.push({ itemKey: row.other_key, number: Number(row.other_number), htmlUrl: row.other_url });
    byIssue.set(row.issue_number, list);
  }
  const facetsByKey = new Map(rows.map((row) => [row.item_key, row.facets ?? {}]));
  return items.map((item) => {
    const facets = facetsByKey.get(item.itemKey) ?? {};
    const lowEffort = facets.pr?.low_effort === true;
    const slopSignals = strings(facets.slop_signals);
    const byIssue = peersByPr.get(item.itemKey);
    const competesWith = byIssue
      ? [...byIssue.entries()].map(([issueNumber, prs]) => ({ issueNumber, prs }))
      : [];
    if (!lowEffort && slopSignals.length === 0 && competesWith.length === 0) return item;
    return { ...item, cleanup: { lowEffort, slopSignals, competesWith } };
  });
}

function latestExtractionJoin(db: Db) {
  return db`
    LEFT JOIN triage_scores s ON s.item_key = i.item_key
    LEFT JOIN LATERAL (
      SELECT x.facets FROM triage_extractions x
      WHERE x.item_key = i.item_key
      ORDER BY x.created_at DESC, x.id DESC
      LIMIT 1
    ) e ON true
  `;
}

export async function listQueue(filters: QueueFilters, viewerLogin?: string): Promise<TriageQueueResponse> {
  if (triageDevFixturesEnabled()) return fixtureQueue(filters);
  const db = getDb();
  let viewerScope: { areas: string[]; hardware: string[] } | null = null;
  if (filters.mine && viewerLogin) {
    const [m] = await db<{ rules: TriageRules | null }[]>`
      SELECT rules FROM triage_maintainers WHERE lower(github_login) = lower(${viewerLogin}) LIMIT 1
    `;
    viewerScope = {
      areas: strings(m?.rules?.areas),
      hardware: strings(m?.rules?.hardware),
    };
  }
  const realBands = filters.bands.filter((band) => band !== "unscored");
  const includeUnscored = filters.bands.includes("unscored");
  const bandFilter = db`AND (${
    realBands.length > 0 ? db`s.band IN ${db(realBands)}` : db`false`
  } OR ${includeUnscored ? db`s.band IS NULL` : db`false`})`;
  // db.json, not JSON.stringify: a plain string parameter cast to ::jsonb
  // arrives as a JSON *string* scalar under prepare:false, so @> never matches.
  const json = (value: unknown) => db.json(value as never);
  const mineFilter = filters.mine
    ? viewerScope && (viewerScope.areas.length > 0 || viewerScope.hardware.length > 0)
      ? db`AND (${
          viewerScope.areas.length > 0
            ? db`EXISTS (
                   SELECT 1 FROM jsonb_array_elements_text(
                     (CASE WHEN jsonb_typeof(e.facets->'areas') = 'array' THEN e.facets->'areas' ELSE '[]'::jsonb END)
                     || (CASE WHEN jsonb_typeof(i.prepass->'areas') = 'array' THEN i.prepass->'areas' ELSE '[]'::jsonb END)
                   ) AS a(val) WHERE a.val IN ${db(viewerScope.areas)}
                 )`
            : db`false`
        } OR ${
          viewerScope.hardware.length > 0
            ? db`EXISTS (
                   SELECT 1 FROM jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(e.facets->'hardware') = 'array' THEN e.facets->'hardware' ELSE '[]'::jsonb END
                   ) AS h(val) WHERE h.val IN ${db(viewerScope.hardware)}
                 )`
            : db`false`
        })`
      : db`AND false`
    : db``;

  const where = db`
    WHERE true
    ${filters.includeOutOfScope ? db`` : db`AND i.in_scope`}
    ${filters.state === "open" ? db`AND i.state = 'open'` : db``}
    ${bandFilter}
    ${filters.kind ? db`AND i.kind = ${filters.kind}` : db``}
    ${filters.area
      ? db`AND (COALESCE(e.facets->'areas', '[]'::jsonb) @> ${json([filters.area])}::jsonb
               OR COALESCE(i.prepass->'areas', '[]'::jsonb) @> ${json([filters.area])}::jsonb)`
      : db``}
    ${filters.hardware
      ? db`AND COALESCE(e.facets->'hardware', '[]'::jsonb) @> ${json([filters.hardware])}::jsonb`
      : db``}
    ${filters.model
      ? db`AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(e.facets->'models') = 'array'
                    THEN e.facets->'models' ELSE '[]'::jsonb END) m
             WHERE m->>'name' ILIKE ${"%" + escapeLike(filters.model) + "%"})`
      : db``}
    ${filters.owner === OWNER_NONE
      ? db`AND NOT EXISTS (SELECT 1 FROM triage_assignments a
                           WHERE a.item_key = i.item_key AND a.status IN ('open', 'acked'))`
      : filters.owner
        ? db`AND EXISTS (SELECT 1 FROM triage_assignments a
                         WHERE a.item_key = i.item_key AND a.status IN ('open', 'acked')
                           AND lower(a.maintainer) = lower(${filters.owner}))`
        : db``}
    ${statusFilter(db, filters.status)}
    ${queueViewWhere(db, filters)}
    ${mineFilter}
    ${filters.q
      ? db`AND (i.title ILIKE ${"%" + escapeLike(filters.q) + "%"}
               OR e.facets->>'summary' ILIKE ${"%" + escapeLike(filters.q) + "%"}
               OR i.number::text = ${filters.q.replace(/^#/, "")})`
      : db``}
  `;
  const order =
    filters.sort === "age"
      ? db`ORDER BY i.gh_created_at DESC`
      : filters.sort === "updated"
        ? db`ORDER BY i.gh_updated_at DESC`
        : db`ORDER BY s.score DESC NULLS LAST, i.gh_created_at DESC`;

  const rows = await db<QueueRow[]>`
    ${queueFocusCte(db, filters.focus, filters.review)}
    ${queueSelect(db)}, count(*) OVER () AS total
    FROM triage_items i
    ${latestExtractionJoin(db)}
    ${where}
    ${order}
    LIMIT ${filters.pageSize} OFFSET ${(filters.page - 1) * filters.pageSize}
  `;
  const baseItems = await withCi(db, await withGroupLinks(db, rows.map(toQueueItem)));
  const items =
    filters.review === "cleanup" || filters.focus === "cleanup"
      ? await withCleanupInfo(db, rows, baseItems)
      : baseItems;
  return {
    items,
    total: rows.length > 0 ? Number(rows[0].total) : 0,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

function statusFilter(db: Db, status: QueueFilters["status"]) {
  switch (status) {
    case "unassigned":
      return db`AND NOT EXISTS (SELECT 1 FROM triage_assignments a
                                WHERE a.item_key = i.item_key AND a.status IN ('open', 'acked'))`;
    case "open":
    case "acked":
      return db`AND EXISTS (SELECT 1 FROM triage_assignments a
                            WHERE a.item_key = i.item_key AND a.status = ${status})`;
    case "closed":
      return db`AND EXISTS (SELECT 1 FROM triage_assignments a WHERE a.item_key = i.item_key)
                AND NOT EXISTS (SELECT 1 FROM triage_assignments a
                                WHERE a.item_key = i.item_key AND a.status IN ('open', 'acked'))`;
    default:
      return db``;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

interface AssignmentRow {
  id: string | number;
  item_key: string;
  maintainer: string;
  role: "primary" | "backup";
  status: TriageAssignment["status"];
  reason: Record<string, unknown> | null;
  score_at_assign: number;
  assigned_by: string;
  assigned_at: Date;
  notified_at: Date | null;
  closed_at: Date | null;
}

function toAssignment(row: AssignmentRow): TriageAssignment {
  return {
    id: Number(row.id),
    itemKey: row.item_key,
    maintainer: row.maintainer,
    role: row.role,
    status: row.status,
    reason: row.reason ?? {},
    scoreAtAssign: row.score_at_assign,
    assignedBy: row.assigned_by,
    assignedAt: iso(row.assigned_at)!,
    notifiedAt: iso(row.notified_at),
    closedAt: iso(row.closed_at),
  };
}

export async function getItemDetail(itemKey: string): Promise<TriageItemDetail | null> {
  if (triageDevFixturesEnabled()) return fixtureItemDetail(itemKey);
  const db = getDb();
  // Keep the parallel reads on one backend. Independent statements pipelined
  // through the transaction pooler can lose their result descriptions.
  return db.begin("read only", (transaction) =>
    readItemDetail(transaction as unknown as Db, itemKey),
  );
}

async function readItemDetail(db: Db, itemKey: string): Promise<TriageItemDetail | null> {
  const [item] = await db<
    {
      item_key: string;
      repo: string;
      number: number;
      kind: "issue" | "pr";
      title: string;
      html_url: string;
      author: string;
      author_association: string;
      state: string;
      draft: boolean;
      labels: unknown;
      files: unknown;
      reactions: number;
      comment_count: number;
      gh_created_at: Date;
      gh_updated_at: Date;
      prepass: TriagePrepass;
      in_scope: boolean;
      extraction_status: string;
      extraction_error: string | null;
    }[]
  >`
    SELECT item_key, repo, number, kind, title, html_url, author, author_association,
           state, draft, labels, files, reactions, comment_count, gh_created_at,
           gh_updated_at, prepass, in_scope, extraction_status, extraction_error
    FROM triage_items WHERE item_key = ${itemKey}
  `;
  if (!item) return null;
  const undoable = await hasUndoneColumn(db);

  const [score, extraction, assignments, actions, relevance, links, ci] = await Promise.all([
    db<
      {
        score: number;
        band: string;
        breakdown: unknown;
        scoring_version: string;
        scored_at: Date;
        labelled: boolean;
      }[]
    >`
      SELECT score, band, breakdown, scoring_version, scored_at, extraction_id IS NOT NULL AS labelled
      FROM triage_scores WHERE item_key = ${itemKey}
    `,
    db<{ id: string; facets: TriageFacets; model: string; prompt_version: string; created_at: Date }[]>`
      SELECT id, facets, model, prompt_version, created_at
      FROM triage_extractions WHERE item_key = ${itemKey}
      ORDER BY created_at DESC, id DESC LIMIT 1
    `,
    db<AssignmentRow[]>`
      SELECT id, item_key, maintainer, role, status, reason, score_at_assign,
             assigned_by, assigned_at, notified_at, closed_at
      FROM triage_assignments WHERE item_key = ${itemKey}
      ORDER BY assigned_at DESC, id DESC
    `,
    db<
      {
        id: string;
        item_key: string;
        assignment_id: string | null;
        actor: string;
        action: TriageItemDetail["actions"][number]["action"];
        target: string | null;
        note: string | null;
        source: string;
        created_at: Date;
        undone_at: Date | null;
      }[]
    >`
      SELECT id, item_key, assignment_id, actor, action, target, note, source, created_at,
             ${undoable ? db`undone_at` : db`NULL::timestamptz AS undone_at`}
      FROM triage_actions WHERE item_key = ${itemKey}
      ORDER BY created_at DESC, id DESC LIMIT 200
    `,
    db<
      {
        maintainer: string;
        relevance: TriageRelevance["relevance"];
        reason: string;
        evidence: unknown;
        current: boolean;
        created_at: Date;
      }[]
    >`
      SELECT r.maintainer, r.relevance, r.reason, r.created_at,
             r.content_hash = i.content_hash AS current,
             COALESCE((
               SELECT jsonb_agg(pr ORDER BY pr->>'number')
               FROM jsonb_array_elements(p.prs) AS pr
               WHERE pr->'number' IN (SELECT jsonb_array_elements(r.evidence_prs))
             ), '[]'::jsonb) AS evidence
      FROM triage_relevance r
      JOIN triage_items i ON i.item_key = r.item_key
      LEFT JOIN triage_maintainer_profiles p ON p.github_login = r.maintainer
      WHERE r.item_key = ${itemKey}
      ORDER BY CASE r.relevance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
               r.maintainer
    `,
    groupLinks(db, [itemKey]),
    item.kind === "pr" ? ciByItem(db, [itemKey]) : Promise.resolve(new Map<string, TriageCi>()),
  ]);
  const group = links.get(itemKey) ?? { fixes: [], fixedBy: [] };

  const labelNames = Array.isArray(item.labels)
    ? item.labels
        .map((label) =>
          typeof label === "string"
            ? label
            : label && typeof label === "object" && typeof (label as { name?: unknown }).name === "string"
              ? (label as { name: string }).name
              : null,
        )
        .filter((name): name is string => name !== null)
    : [];

  const relevanceRows: TriageRelevance[] = relevance.map((r) => ({
    maintainer: r.maintainer,
    relevance: r.relevance,
    reason: r.reason,
    evidence: Array.isArray(r.evidence)
      ? r.evidence.flatMap((pr) => {
          const p = pr as { number?: unknown; kind?: unknown; title?: unknown };
          return typeof p.number === "number"
            ? [{ number: p.number, kind: String(p.kind ?? ""), title: String(p.title ?? "") }]
            : [];
        })
      : [],
    current: Boolean(r.current),
    judgedAt: r.created_at.toISOString(),
  }));

  const openOwners = assignments.filter((a) => a.status === "open" || a.status === "acked");
  let persistedReason: WhyUnowned | null = null;
  if (openOwners.length === 0 && score[0]) {
    try {
      const [reasonRow] = await db<{ unowned_reason: unknown }[]>`
        SELECT unowned_reason FROM triage_scores WHERE item_key = ${itemKey}
      `;
      persistedReason = parsePersistedUnownedReason(reasonRow?.unowned_reason);
    } catch {
      // Gracefully tolerate missing `unowned_reason` column before migration 0047 is applied.
    }
  }
  const whyUnowned =
    openOwners.length === 0
      ? (persistedReason ??
        (await explainItemRouting(db, {
          itemKey,
          item,
          score: score[0] ?? null,
          facets: extraction[0]?.facets ?? null,
          relevance: relevanceRows,
          assignments: assignments.map(toAssignment),
          // An undone click never happened, as far as routing is concerned.
          actions: actions.filter((a) => a.undone_at === null).map((a) => ({ actor: a.actor, action: a.action })),
          linked: [...group.fixes, ...group.fixedBy],
        })))
      : null;

  return {
    relevance: relevanceRows,
    whyUnowned,
    fixes: group.fixes,
    fixedBy: group.fixedBy,
    ci: ci.get(itemKey) ?? null,
    item: {
      itemKey: item.item_key,
      repo: item.repo,
      number: item.number,
      kind: item.kind,
      title: item.title,
      htmlUrl: item.html_url,
      author: item.author,
      authorAssociation: item.author_association,
      state: item.state,
      draft: item.draft,
      labels: labelNames,
      files: Array.isArray(item.files) ? (item.files as TriageItemDetail["item"]["files"]) : [],
      reactions: item.reactions,
      commentCount: item.comment_count,
      ghCreatedAt: iso(item.gh_created_at)!,
      ghUpdatedAt: iso(item.gh_updated_at)!,
      prepass: item.prepass ?? {},
      inScope: item.in_scope,
      extractionStatus: item.extraction_status,
      extractionError: item.extraction_error,
    },
    score: score[0]
      ? {
          score: score[0].score,
          band: score[0].band,
          breakdown: Array.isArray(score[0].breakdown)
            ? (score[0].breakdown as TriageBreakdownEntry[])
            : [],
          scoringVersion: score[0].scoring_version,
          scoredAt: iso(score[0].scored_at)!,
        }
      : null,
    extraction: extraction[0]
      ? {
          id: Number(extraction[0].id),
          facets: extraction[0].facets ?? {},
          model: extraction[0].model,
          promptVersion: extraction[0].prompt_version,
          createdAt: iso(extraction[0].created_at)!,
        }
      : null,
    assignments: assignments.map(toAssignment),
    actions: actions.map((row) => ({
      id: Number(row.id),
      itemKey: row.item_key,
      assignmentId: row.assignment_id === null ? null : Number(row.assignment_id),
      actor: row.actor,
      action: row.action,
      target: row.target,
      note: row.note,
      source: row.source,
      createdAt: iso(row.created_at)!,
      undoneAt: iso(row.undone_at),
    })),
  };
}

function parsePersistedUnownedReason(raw: unknown): WhyUnowned | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { summary?: unknown; lines?: unknown; pending?: unknown };
  if (typeof obj.summary !== "string" || !obj.summary.trim()) return null;
  const lines = Array.isArray(obj.lines) ? obj.lines.filter((l): l is string => typeof l === "string") : [];
  return { summary: obj.summary, lines, pending: Boolean(obj.pending) };
}

/**
 * The router's view of an unowned item: active maintainers, this week's load,
 * who has a work profile, and commenters for items stored before
 * `prepass.commenters` existed. The decision itself is `explainUnowned`.
 */
async function explainItemRouting(
  db: Db,
  input: {
    itemKey: string;
    item: {
      state: string;
      in_scope: boolean;
      title: string;
      files: unknown;
      prepass: TriagePrepass;
      gh_created_at: Date;
      extraction_status: string;
    };
    score: { score: number; band: string; labelled: boolean } | null;
    facets: TriageFacets | null;
    relevance: TriageRelevance[];
    assignments: TriageAssignment[];
    actions: { actor: string; action: string }[];
    linked: TriageLinkedItem[];
  },
): Promise<WhyUnowned> {
  const undoable = await hasUndoneColumn(db);
  const [maintainers, load, excerpt, ahead, waiting] = await Promise.all([
    db<(MaintainerRow & { has_profile: boolean })[]>`
      SELECT m.github_login, m.slack_user_id, m.active, m.rules, m.min_score, m.capacity_per_week,
             m.away, m.notify_mode, m.updated_by, m.updated_at,
             EXISTS (SELECT 1 FROM triage_maintainer_profiles p WHERE p.github_login = m.github_login) AS has_profile
      FROM triage_maintainers m WHERE m.active
    `,
    // maintainer_load in triage/store.py.
    db<{ maintainer: string; n: string }[]>`
      SELECT maintainer, count(*) AS n FROM triage_assignments
      WHERE assigned_at >= now() - interval '7 days' AND role = 'primary'
        AND status NOT IN ('not_mine', 'reassigned')
        AND NOT (status = 'done' AND reason->>'closed_by' = 'github'
                 AND reason->>'closed_from' = 'open')
        AND NOT (reason ? 'grouped_with')
      GROUP BY maintainer
    `,
    input.item.prepass && "commenters" in input.item.prepass
      ? Promise.resolve([] as { comments_excerpt: string }[])
      : db<{ comments_excerpt: string }[]>`
          SELECT comments_excerpt FROM triage_items WHERE item_key = ${input.itemKey}
        `,
    // Router candidates (routing_candidates in triage/store.py) scoring higher.
    input.score
      ? db<{ n: string }[]>`
          SELECT count(*) AS n FROM triage_items i JOIN triage_scores s ON s.item_key = i.item_key
          WHERE i.in_scope AND i.state = 'open' AND s.band IN ('page', 'route')
            AND s.extraction_id IS NOT NULL AND s.score > ${input.score.score}
            AND NOT EXISTS (SELECT 1 FROM triage_assignments a WHERE a.item_key = i.item_key
                            AND a.role = 'primary' AND a.status IN ('open', 'acked', 'done'))
            AND NOT EXISTS (SELECT 1 FROM triage_actions a WHERE a.item_key = i.item_key
                            AND a.action IN ('drop', 'slop') ${liveAction(db, undoable, "a")})
            AND NOT (COALESCE(i.prepass->>'waiting_on', '') = 'author' AND s.band <> 'page')
        `
      : Promise.resolve([{ n: "0" }]),
    // RoutingRow.waiting_since: GREATEST(routable_since, first label). Read
    // through to_jsonb so this works before migration 0043 adds the column;
    // without it the start of the wait is unknown.
    db<{ has_column: boolean; waiting_since: Date | null }[]>`
      SELECT to_jsonb(s) ? 'routable_since' AS has_column,
             GREATEST((to_jsonb(s)->>'routable_since')::timestamptz,
                      (SELECT min(x.created_at) FROM triage_extractions x WHERE x.item_key = s.item_key))
               AS waiting_since
      FROM triage_scores s WHERE s.item_key = ${input.itemKey}
    `,
  ]);
  const prepass: TriagePrepass = input.item.prepass ?? {};
  const hidden = [...input.actions].reverse().find((a) => a.action === "drop" || a.action === "slop");
  const done = input.assignments.find((a) => a.role === "primary" && a.status === "done");
  return explainUnowned({
    state: input.item.state,
    inScope: input.item.in_scope,
    band: input.score?.band ?? null,
    score: input.score?.score ?? null,
    labelled: input.score?.labelled ?? false,
    extractionStatus: input.item.extraction_status,
    createdAt: iso(input.item.gh_created_at),
    title: input.item.title,
    facets: input.facets,
    prepass: "commenters" in prepass
      ? prepass
      : { ...prepass, commenters: commentersFromExcerpt(excerpt[0]?.comments_excerpt ?? "") },
    files: Array.isArray(input.item.files) ? (input.item.files as { path?: string }[]) : [],
    relevance: input.relevance.map((r) => ({
      maintainer: r.maintainer,
      relevance: r.relevance as RelevanceLevel,
      current: r.current,
    })),
    maintainers: maintainers.map((row) => {
      const m = toMaintainer(row);
      return {
        login: m.githubLogin,
        minScore: m.minScore,
        capacityPerWeek: m.capacityPerWeek,
        away: m.away,
        rules: m.rules,
        hasProfile: row.has_profile,
      };
    }),
    load: Object.fromEntries(load.map((row) => [row.maintainer, Number(row.n)])),
    notMine: [...new Set(input.actions.filter((a) => a.action === "not_mine").map((a) => a.actor))],
    hidden: hidden ? { action: hidden.action as "drop" | "slop", actor: hidden.actor } : null,
    doneBy: done?.maintainer ?? null,
    doneOnGithub: done?.reason.closed_by === "github",
    waitingSince: waiting[0]?.has_column ? iso(waiting[0].waiting_since) : undefined,
    queuePosition: Number(ahead[0]?.n ?? 0) + 1,
    linked: input.linked.map((l) => ({
      number: l.number,
      kind: l.kind,
      state: l.state,
      score: l.score,
      band: l.band,
      owner: l.owner,
    })),
    now: new Date(),
  });
}

export async function getMyPlate(login: string): Promise<TriageMyPlate> {
  if (triageDevFixturesEnabled()) return fixtureMyPlate(login);
  const db = getDb();
  type Row = QueueRow & AssignmentRow & { a_item_key: string };
  const rows = await db<Row[]>`
    ${queueSelect(db)},
           a.id, a.item_key AS a_item_key, a.maintainer, a.role, a.status, a.reason,
           a.score_at_assign, a.assigned_by, a.assigned_at, a.notified_at, a.closed_at
    FROM triage_assignments a
    JOIN triage_items i ON i.item_key = a.item_key
    ${latestExtractionJoin(db)}
    WHERE lower(a.maintainer) = lower(${login})
      AND (a.status IN ('open', 'acked') OR a.closed_at > now() - interval '14 days')
    ORDER BY (a.status IN ('open', 'acked')) DESC, s.score DESC NULLS LAST, a.assigned_at DESC
    LIMIT 300
  `;
  const open: TriageMyPlate["open"] = [];
  const recentlyClosed: TriageMyPlate["recentlyClosed"] = [];
  for (const row of rows) {
    const entry = {
      ...toQueueItem(row),
      assignment: toAssignment({ ...row, item_key: row.a_item_key }),
    };
    (entry.assignment.status === "open" || entry.assignment.status === "acked"
      ? open
      : recentlyClosed
    ).push(entry);
  }
  const links = await groupLinks(db, rows.map((row) => row.a_item_key));
  const attach = <T extends TriageQueueItem>(entry: T): T => ({
    ...entry,
    ...(links.get(entry.itemKey) ?? { fixes: [], fixedBy: [] }),
  });
  // Claude's high/medium matches per open item, to order "Reassign…".
  const openKeys = open.map((entry) => entry.itemKey);
  const matches = new Map<string, { maintainer: string; relevance: "high" | "medium" }[]>();
  if (openKeys.length > 0) {
    const rows = await db<{ item_key: string; maintainer: string; relevance: "high" | "medium" }[]>`
      SELECT r.item_key, r.maintainer, r.relevance
      FROM triage_relevance r
      JOIN triage_maintainers m ON m.github_login = r.maintainer AND m.active
      WHERE r.item_key IN ${db(openKeys)} AND r.relevance IN ('high', 'medium')
    `;
    for (const row of rows) {
      const list = matches.get(row.item_key) ?? [];
      list.push({ maintainer: row.maintainer, relevance: row.relevance });
      matches.set(row.item_key, list);
    }
  }
  const withMatches = open.map((entry) => ({ ...attach(entry), relevanceMatches: matches.get(entry.itemKey) ?? [] }));
  return { login, open: await withCi(db, withMatches), recentlyClosed: recentlyClosed.map(attach) };
}

interface MaintainerRow {
  github_login: string;
  slack_user_id: string | null;
  active: boolean;
  rules: unknown;
  min_score: number;
  capacity_per_week: number;
  away: unknown;
  notify_mode: NotifyMode;
  updated_by: string | null;
  updated_at: Date | null;
}

function toMaintainer(row: MaintainerRow): TriageMaintainer {
  return {
    githubLogin: row.github_login,
    slackUserId: row.slack_user_id,
    active: row.active,
    rules: normalizeRules(row.rules),
    minScore: row.min_score,
    capacityPerWeek: row.capacity_per_week,
    away: Array.isArray(row.away)
      ? row.away.filter(
          (range): range is { start: string; end: string } =>
            !!range && typeof range.start === "string" && typeof range.end === "string",
        )
      : [],
    notifyMode: row.notify_mode,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  };
}

/** The active maintainer whose file links this Slack user, and their bot language. */
export async function maintainerForSlackUser(
  slackUserId: string,
): Promise<{ login: string; language: "en" | "vi" } | null> {
  const [row] = await getDb()<{ github_login: string; language: string | null }[]>`
    SELECT github_login, rules->>'language' AS language
    FROM triage_maintainers WHERE active AND slack_user_id = ${slackUserId} LIMIT 1
  `;
  return row ? { login: row.github_login, language: row.language === "vi" ? "vi" : "en" } : null;
}

/** The person's open (or acked) assignment on an item, if they have one. */
export async function openAssignmentFor(itemKey: string, login: string): Promise<number | null> {
  const [row] = await getDb()<{ id: string }[]>`
    SELECT id FROM triage_assignments
    WHERE item_key = ${itemKey} AND lower(maintainer) = lower(${login}) AND status IN ('open', 'acked')
    ORDER BY role = 'primary' DESC, assigned_at DESC LIMIT 1
  `;
  return row ? Number(row.id) : null;
}

export async function listActiveMaintainers(): Promise<
  { githubLogin: string; openAssignments: number; openPrimaries: number }[]
> {
  if (triageDevFixturesEnabled()) return fixtureActiveMaintainers();
  const db = getDb();
  const rows = await db<{ github_login: string; open_assignments: string; open_primaries: string }[]>`
    SELECT m.github_login,
           count(a.id) AS open_assignments,
           count(a.id) FILTER (WHERE a.role = 'primary') AS open_primaries
    FROM triage_maintainers m
    LEFT JOIN triage_assignments a
      ON a.maintainer = m.github_login AND a.status IN ('open', 'acked')
    WHERE m.active
    GROUP BY m.github_login
    ORDER BY lower(m.github_login)
  `;
  return rows.map((row) => ({
    githubLogin: row.github_login,
    openAssignments: Number(row.open_assignments),
    openPrimaries: Number(row.open_primaries),
  }));
}

export async function getMaintainer(login: string): Promise<TriageMaintainer | null> {
  if (triageDevFixturesEnabled()) return fixtureMaintainer(login);
  const db = getDb();
  const [row] = await db<MaintainerRow[]>`
    SELECT github_login, slack_user_id, active, rules, min_score, capacity_per_week,
           away, notify_mode, updated_by, updated_at
    FROM triage_maintainers WHERE lower(github_login) = lower(${login})
  `;
  return row ? toMaintainer(row) : null;
}

export interface RulePreviewMatch {
  itemKey: string;
  title: string;
  htmlUrl: string;
  kind: "issue" | "pr";
  score: number | null;
  band: string | null;
  matched: string[];
  meetsMinScore: boolean;
}

/** Items first seen in the last 30 days that these rules would match. */
export async function previewRules(
  rules: TriageRules,
  minScore: number,
): Promise<{ scanned: number; matches: RulePreviewMatch[] }> {
  const db = getDb();
  const rows = await db<
    {
      item_key: string;
      title: string;
      html_url: string;
      kind: "issue" | "pr";
      files: unknown;
      prepass: TriagePrepass | null;
      facets: TriageFacets | null;
      score: number | null;
      band: string | null;
    }[]
  >`
    SELECT i.item_key, i.title, i.html_url, i.kind, i.files, i.prepass, e.facets, s.score, s.band
    FROM triage_items i
    ${latestExtractionJoin(db)}
    WHERE i.in_scope AND i.gh_created_at > now() - interval '30 days'
    ORDER BY s.score DESC NULLS LAST, i.gh_created_at DESC
    LIMIT 5000
  `;
  const matches: RulePreviewMatch[] = [];
  for (const row of rows) {
    const result = matchRules(rules, {
      title: row.title,
      facets: row.facets,
      prepass: row.prepass,
      files: Array.isArray(row.files) ? (row.files as { path?: string }[]) : [],
    });
    if (!result) continue;
    matches.push({
      itemKey: row.item_key,
      title: row.title,
      htmlUrl: row.html_url,
      kind: row.kind,
      score: row.score,
      band: row.band,
      matched: result.matched,
      meetsMinScore: row.score !== null && row.score >= minScore,
    });
  }
  return { scanned: rows.length, matches };
}

/** Drop/slop actions per person per 24h that raise the suppression warning. */
export function suppressionThreshold(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.TRIAGE_SUPPRESSION_ALERT);
  return Number.isInteger(value) && value > 0 ? value : 10;
}

export async function getStats(
  viewerLogin?: string,
  options: { includeHealth?: boolean } = {},
): Promise<TriageStats> {
  if (triageDevFixturesEnabled()) return fixtureStats();
  const db = getDb();
  const threshold = suppressionThreshold();
  const undoable = await hasUndoneColumn(db);
  const [[row], bands, suppressors, health, [cleanupRow], viewerRows] = await Promise.all([
    db<
      {
        ingested_24h: string;
        new_today: string;
        in_scope_7d: string;
        extracted_7d: string;
        page_unacked: string;
        unowned: string;
        unowned_page: string;
        not_acked: string;
        ready_review: string;
        ready_merge: string;
        assigned_7d: string;
        not_mine_7d: string;
      }[]
    >`
      SELECT
        (SELECT count(*) FROM triage_items WHERE first_seen_at > now() - interval '24 hours') AS ingested_24h,
        (SELECT count(*) FROM triage_items
          WHERE first_seen_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS new_today,
        (SELECT count(*) FROM triage_items
          WHERE in_scope AND first_seen_at > now() - interval '7 days') AS in_scope_7d,
        (SELECT count(*) FROM triage_items
          WHERE in_scope AND first_seen_at > now() - interval '7 days'
            AND extraction_status = 'done') AS extracted_7d,
        (SELECT count(*) FROM triage_scores s JOIN triage_items i ON i.item_key = s.item_key
          WHERE s.band = 'page' AND i.state = 'open'
            AND NOT EXISTS (SELECT 1 FROM triage_assignments a
                            WHERE a.item_key = s.item_key AND a.status IN ('acked', 'done'))) AS page_unacked,
        (SELECT count(*) FROM triage_scores s JOIN triage_items i ON i.item_key = s.item_key
          WHERE s.band IN ('page', 'route') AND i.state = 'open' AND i.in_scope
            AND NOT EXISTS (SELECT 1 FROM triage_assignments a
                            WHERE a.item_key = s.item_key AND a.status IN ('open', 'acked'))) AS unowned,
        (SELECT count(*) FROM triage_scores s JOIN triage_items i ON i.item_key = s.item_key
          WHERE s.band = 'page' AND i.state = 'open' AND i.in_scope
            AND NOT EXISTS (SELECT 1 FROM triage_assignments a
                            WHERE a.item_key = s.item_key AND a.status IN ('open', 'acked'))) AS unowned_page,
        (SELECT count(*) FROM triage_items i
          WHERE i.in_scope AND i.state = 'open'
            AND EXISTS (SELECT 1 FROM triage_assignments a
                        WHERE a.item_key = i.item_key AND a.status = 'open')) AS not_acked,
        (SELECT count(*) FROM triage_items i LEFT JOIN triage_scores s ON s.item_key = i.item_key
          WHERE i.in_scope AND i.state = 'open' AND i.kind = 'pr' AND NOT i.draft
            AND s.band IN ('page', 'route', 'watch')
            AND i.prepass->>'waiting_on' = 'reviewer'
            AND COALESCE(i.prepass->>'review_decision', '') <> 'APPROVED') AS ready_review,
        (SELECT count(*) FROM triage_items i
          WHERE i.in_scope AND i.state = 'open' AND i.kind = 'pr' AND NOT i.draft
            AND i.prepass->>'waiting_on' = 'reviewer'
            AND i.prepass->>'merge_ready' = 'true'
            AND (i.prepass->>'merge_checked_at')::timestamptz > now() - interval '1 hour') AS ready_merge,
        (SELECT count(*) FROM triage_assignments
          WHERE assigned_at > now() - interval '7 days') AS assigned_7d,
        (SELECT count(*) FROM triage_actions
          WHERE action = 'not_mine' AND created_at > now() - interval '7 days'
            ${liveAction(db, undoable)}) AS not_mine_7d
    `,
    db<{ band: string | null; n: string }[]>`
      SELECT s.band, count(*) AS n
      FROM triage_items i
      LEFT JOIN triage_scores s ON s.item_key = i.item_key
      WHERE i.in_scope AND i.state = 'open'
      GROUP BY s.band
    `,
    db<{ actor: string; drops: string; slops: string }[]>`
      SELECT actor,
             count(*) FILTER (WHERE action = 'drop') AS drops,
             count(*) FILTER (WHERE action = 'slop') AS slops
      FROM triage_actions
      WHERE action IN ('drop', 'slop') AND created_at > now() - interval '24 hours'
        ${liveAction(db, undoable)}
      GROUP BY actor
      HAVING count(*) >= ${threshold}
      ORDER BY count(*) DESC
    `,
    options.includeHealth ? getPipelineHealth(db) : Promise.resolve(null),
    db<{ n: string }[]>`
      ${queueFocusCte(db, "cleanup")}
      SELECT count(*) AS n
      FROM triage_items i
      ${latestExtractionJoin(db)}
      WHERE i.in_scope ${queueViewWhere(db, { review: "cleanup", focus: null })}
    `,
    viewerLogin
      ? db<{ my_open: string; my_unacked: string; rules: TriageRules | null }[]>`
          SELECT
            (SELECT count(*) FROM triage_assignments a JOIN triage_items i ON i.item_key = a.item_key
              WHERE lower(a.maintainer) = lower(${viewerLogin}) AND a.status IN ('open', 'acked') AND i.state = 'open') AS my_open,
            (SELECT count(*) FROM triage_assignments a JOIN triage_items i ON i.item_key = a.item_key
              WHERE lower(a.maintainer) = lower(${viewerLogin}) AND a.status = 'open' AND i.state = 'open') AS my_unacked,
            (SELECT m.rules FROM triage_maintainers m
              WHERE lower(m.github_login) = lower(${viewerLogin}) LIMIT 1) AS rules
        `
      : Promise.resolve([]),
  ]);
  const bandCounts: TriageStats["bandCounts"] = { page: 0, route: 0, watch: 0, ignore: 0, unscored: 0 };
  for (const { band, n } of bands) {
    const key = band === "page" || band === "route" || band === "watch" || band === "ignore" ? band : "unscored";
    bandCounts[key] += Number(n);
  }
  const allOpen = bandCounts.page + bandCounts.route + bandCounts.watch + bandCounts.ignore + bandCounts.unscored;
  const viewerRow = viewerRows[0];
  return {
    bandCounts,
    unowned: Number(row.unowned),
    unownedPage: Number(row.unowned_page),
    newToday: Number(row.new_today),
    ingestedLast24h: Number(row.ingested_24h),
    inScopeLast7d: Number(row.in_scope_7d),
    extractedLast7d: Number(row.extracted_7d),
    pageUnacked: Number(row.page_unacked),
    assignedLast7d: Number(row.assigned_7d),
    notMineLast7d: Number(row.not_mine_7d),
    suppression: {
      threshold,
      actors: suppressors.map((r) => ({ actor: r.actor, drops: Number(r.drops), slops: Number(r.slops) })),
    },
    health,
    presetCounts: {
      "needs-triage": Number(row.unowned),
      "not-acked": Number(row.not_acked),
      review: Number(row.ready_review),
      merge: Number(row.ready_merge),
      cleanup: Number(cleanupRow?.n ?? 0),
      all: allOpen,
    },
    viewer: viewerRow
      ? {
          myOpen: Number(viewerRow.my_open),
          myUnacked: Number(viewerRow.my_unacked),
          areas: strings(viewerRow.rules?.areas),
          hardware: strings(viewerRow.rules?.hardware),
        }
      : null,
  };
}

/** The extractor's default `max_attempts` (triage/extract.py): failed items stop being retried after this. */
const EXTRACTION_MAX_ATTEMPTS = 3;

/**
 * Is labelling / relevance judging keeping up? Both run from cron on the
 * extractor host and fail silently, so the queue page grades these
 * (triage-health.ts).
 */
async function getPipelineHealth(db: Db): Promise<TriagePipelineHealth> {
  const undoable = await hasUndoneColumn(db);
  const [row] = await db<
    {
      last_labelled_at: Date | null;
      last_judged_at: Date | null;
      waiting_for_label: string;
      label_wait_since: Date | null;
      waiting_for_judgement: string;
      judgement_wait_since: Date | null;
      label_failures_24h: string;
      label_gave_up: string;
      last_label_error: string | null;
    }[]
  >`
    WITH label_wait AS (
      SELECT updated_at FROM triage_items
      WHERE in_scope AND state = 'open'
        AND (extraction_status IN ('pending', 'running')
             OR (extraction_status = 'failed' AND extraction_attempts < ${EXTRACTION_MAX_ATTEMPTS}))
    ),
    -- The router's candidates (routing_candidates in triage/store.py) that
    -- still lack a current judgement for some active maintainer.
    judgement_wait AS (
      SELECT CASE WHEN e.content_hash = i.content_hash THEN e.created_at END AS labelled_at
      FROM triage_items i JOIN triage_scores s ON s.item_key = i.item_key
      JOIN triage_extractions e ON e.id = s.extraction_id
      WHERE i.in_scope AND i.state = 'open' AND s.band IN ('page', 'route')
          AND s.extraction_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM triage_assignments a WHERE a.item_key = i.item_key
                          AND a.role = 'primary' AND a.status IN ('open', 'acked', 'done'))
          AND NOT EXISTS (SELECT 1 FROM triage_actions a WHERE a.item_key = i.item_key
                          AND a.action IN ('drop', 'slop') ${liveAction(db, undoable, "a")})
          AND EXISTS (SELECT 1 FROM triage_maintainers m
                      WHERE m.active AND NOT EXISTS (
                        SELECT 1 FROM triage_relevance r
                        WHERE r.item_key = i.item_key AND r.maintainer = m.github_login
                          AND r.content_hash = i.content_hash))
    )
    SELECT
      (SELECT max(created_at) FROM triage_extractions) AS last_labelled_at,
      (SELECT max(created_at) FROM triage_relevance) AS last_judged_at,
      (SELECT count(*) FROM label_wait) AS waiting_for_label,
      (SELECT min(updated_at) FROM label_wait) AS label_wait_since,
      (SELECT count(*) FROM judgement_wait) AS waiting_for_judgement,
      (SELECT min(labelled_at) FROM judgement_wait) AS judgement_wait_since,
      (SELECT count(*) FROM triage_items
        WHERE extraction_status = 'failed' AND updated_at > now() - interval '24 hours'
      ) AS label_failures_24h,
      (SELECT count(*) FROM triage_items
        WHERE in_scope AND state = 'open' AND extraction_status = 'failed'
          AND extraction_attempts >= ${EXTRACTION_MAX_ATTEMPTS}
      ) AS label_gave_up,
      (SELECT extraction_error FROM triage_items
        WHERE extraction_status = 'failed' AND extraction_error IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1
      ) AS last_label_error
  `;
  const expires = process.env.TRIAGE_CLAUDE_LOGIN_EXPIRES?.trim();
  let workerWarnings24h = 0;
  let latestWorkerWarning: string | null = null;
  try {
    const [runRow] = await db<{ warn_runs: string; latest_warning: string | null }[]>`
      SELECT
        (SELECT count(*) FROM triage_runs
          WHERE status IN ('warning', 'error') AND finished_at > now() - interval '24 hours') AS warn_runs,
        (SELECT warnings->>0 FROM triage_runs
          WHERE status IN ('warning', 'error') AND jsonb_array_length(warnings) > 0
            AND finished_at > now() - interval '24 hours'
          ORDER BY finished_at DESC LIMIT 1) AS latest_warning
    `;
    workerWarnings24h = Number(runRow?.warn_runs ?? 0);
    latestWorkerWarning = runRow?.latest_warning ?? null;
  } catch {
    // Gracefully tolerate missing `triage_runs` table before migration 0047 is applied.
  }
  return {
    lastLabelledAt: iso(row.last_labelled_at),
    lastJudgedAt: iso(row.last_judged_at),
    waitingForLabel: Number(row.waiting_for_label),
    labelWaitSince: iso(row.label_wait_since),
    waitingForJudgement: Number(row.waiting_for_judgement),
    judgementWaitSince: iso(row.judgement_wait_since),
    labelFailures24h: Number(row.label_failures_24h),
    labelGaveUp: Number(row.label_gave_up),
    lastLabelError: row.last_label_error,
    loginExpiresOn: expires && /^\d{4}-\d{2}-\d{2}$/.test(expires) ? expires : null,
    workerWarnings24h,
    latestWorkerWarning,
  };
}

/**
 * Applies one maintainer action in a single transaction: lock the item's
 * assignments, plan the transition, update/insert assignments, and record a
 * triage_actions row. Ack / not mine / done / reassign on an issue also
 * apply to the PRs fixing it that the same person holds (triage/groups.py);
 * their keys come back in `alsoApplied`.
 */
export async function applyTriageAction(
  actor: string,
  request: ActionRequest,
  source: "dashboard" | "slack" = "dashboard",
): Promise<PlanResult | { ok: true; assignmentId: number | null; actionId: number; alsoApplied: string[] }> {
  const db = getDb();
  return db.begin(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [item] = await tx<{ item_key: string; kind: "issue" | "pr" }[]>`
      SELECT item_key, kind FROM triage_items WHERE item_key = ${request.itemKey} FOR UPDATE
    `;
    if (!item) return { ok: false as const, status: 404 as const, error: "No such triage item." };
    const maintainers = await tx<{ github_login: string }[]>`
      SELECT github_login FROM triage_maintainers WHERE active
    `;
    const active = new Set(maintainers.map((row) => row.github_login.toLowerCase()));

    const assignments = await lockAssignments(tx, request.itemKey);
    const result = planTriageAction(request, actor, assignments, active);
    if (!result.ok) return result;
    const { assignmentId, actionId } = await applyPlan(tx, actor, request, result.plan, source);

    const alsoApplied: string[] = [];
    const holder =
      request.action === "reassign"
        ? assignments.find((a) => a.id === result.plan.update?.id)?.maintainer
        : actor;
    if (item.kind === "issue" && holder && GROUP_ACTIONS.includes(request.action)) {
      const members = (await groupLinks(tx, [request.itemKey])).get(request.itemKey)?.fixedBy ?? [];
      for (const member of members) {
        await tx`SELECT item_key FROM triage_items WHERE item_key = ${member.itemKey} FOR UPDATE`;
        const memberAssignments = await lockAssignments(tx, member.itemKey);
        const follow = memberRequest(request, holder, member.itemKey, memberAssignments);
        if (!follow) continue;
        const planned = planTriageAction(follow, actor, memberAssignments, active);
        if (!planned.ok) continue;
        await applyPlan(tx, actor, follow, planned.plan, source, request.itemKey);
        alsoApplied.push(member.itemKey);
      }
    }
    return { ok: true as const, assignmentId, actionId, alsoApplied };
  });
}

async function lockAssignments(tx: Db, itemKey: string): Promise<AssignmentState[]> {
  const rows = await tx<
    {
      id: string;
      maintainer: string;
      role: "primary" | "backup";
      status: AssignmentState["status"];
      closed_at: Date | null;
      assigned_at: Date;
    }[]
  >`
    SELECT id, maintainer, role, status, closed_at, assigned_at
    FROM triage_assignments WHERE item_key = ${itemKey}
    FOR UPDATE
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    maintainer: row.maintainer,
    role: row.role,
    status: row.status,
    closedAt: iso(row.closed_at),
    assignedAt: iso(row.assigned_at)!,
  }));
}

/**
 * Write one planned transition and its triage_actions row. `groupedWith`:
 * the issue this fix PR followed; a new assignment it creates (reassign)
 * then carries reason.grouped_with, so the group still takes one slot of
 * the new owner's weekly capacity (`maintainer_load` in triage/store.py).
 */
async function applyPlan(
  tx: Db,
  actor: string,
  request: ActionRequest,
  plan: ActionPlan,
  source: "dashboard" | "slack",
  groupedWith?: string,
): Promise<{ assignmentId: number | null; actionId: number }> {
  if (plan.update) {
    const closedAt =
      plan.update.closedAt === "close"
        ? tx`closed_at = now()`
        : plan.update.closedAt === "reopen"
          ? tx`closed_at = NULL`
          : tx`closed_at = closed_at`;
    await tx`
      UPDATE triage_assignments
      SET status = ${plan.update.status}, ${closedAt}
      WHERE id = ${plan.update.id}
    `;
  }

  let assignmentId = plan.assignmentId;
  if (plan.insert) {
    // Canonical casing for the FK: use the maintainer row's own login.
    const [target] = await tx<{ github_login: string }[]>`
      SELECT github_login FROM triage_maintainers
      WHERE lower(github_login) = lower(${plan.insert.maintainer})
    `;
    if (!target) {
      // `ack` on an unassigned item by someone without a maintainer row:
      // create a minimal row so the assignment FK holds. updated_by is the
      // actor, never 'repo': the triage/config/maintainers/ sync only manages
      // rows with a file or marked updated_by='repo', so it leaves this row
      // alone until the person adds their own file.
      await tx`
        INSERT INTO triage_maintainers (github_login, updated_by)
        VALUES (${plan.insert.maintainer}, ${actor})
        ON CONFLICT (github_login) DO NOTHING
      `;
    }
    const [inserted] = await tx<{ id: string }[]>`
      INSERT INTO triage_assignments
        (item_key, maintainer, role, status, reason, score_at_assign, assigned_by)
      VALUES (
        ${request.itemKey},
        ${target?.github_login ?? plan.insert.maintainer},
        ${plan.insert.role},
        ${plan.insert.status},
        ${getDb().json(
          (groupedWith
            ? { manual: request.action, by: actor, grouped_with: groupedWith }
            : { manual: request.action, by: actor }) as never,
        )}::jsonb,
        COALESCE((SELECT score FROM triage_scores WHERE item_key = ${request.itemKey}), 0),
        ${actor}
      )
      RETURNING id
    `;
    // The action row refers to the assignment it closed (reassign) or,
    // when nothing was closed, the one it created.
    if (assignmentId === null) assignmentId = Number(inserted.id);
  }

  const [action] = await tx<{ id: string }[]>`
    INSERT INTO triage_actions (item_key, assignment_id, actor, action, target, note, source)
    VALUES (${request.itemKey}, ${assignmentId}, ${actor}, ${request.action},
            ${request.target}, ${request.note}, ${source})
    RETURNING id
  `;
  return { assignmentId, actionId: Number(action.id) };
}

/**
 * Undo one dashboard action of `actor` (see `checkUndo` / `planUndo` in
 * triage-actions.ts): reverts the assignment(s) and deletes the action rows,
 * including the fix-PR rows that followed it in the same transaction.
 */
export async function undoTriageAction(
  actor: string,
  actionId: number,
): Promise<UndoResult<{ itemKeys: string[] }>> {
  const db = getDb();
  if (!(await hasUndoneColumn(db))) {
    return { ok: false, status: 503, error: "Undo needs database migration 0048; reopen it instead for now." };
  }
  return db.begin(async (transaction) => {
    const tx = transaction as unknown as Db;
    const actionRow = async (id: number) => {
      const [row] = await tx<
        {
          id: string;
          item_key: string;
          assignment_id: string | null;
          actor: string;
          action: UndoActionRow["action"];
          target: string | null;
          source: string;
          age_seconds: number;
          undone: boolean;
        }[]
      >`
        SELECT id, item_key, assignment_id, actor, action, target, source,
               EXTRACT(EPOCH FROM (now() - created_at))::float8 AS age_seconds,
               undone_at IS NOT NULL AS undone
        FROM triage_actions WHERE id = ${id}
        FOR UPDATE
      `;
      return row
        ? ({
            id: Number(row.id),
            itemKey: row.item_key,
            assignmentId: row.assignment_id === null ? null : Number(row.assignment_id),
            actor: row.actor,
            action: row.action,
            target: row.target,
            source: row.source,
            ageSeconds: Number(row.age_seconds),
            undone: row.undone,
          } satisfies UndoActionRow)
        : undefined;
    };

    const checked = checkUndo(actor, await actionRow(actionId));
    if (!checked.ok) return checked;
    const main = checked.value;

    // Rows the same click wrote on the issue's fix PRs (applyTriageAction):
    // same actor, same transaction time, note "with #N".
    const number = main.itemKey.replace(/^.*#/, "");
    const followIds = await tx<{ id: string }[]>`
      SELECT f.id FROM triage_actions f
      JOIN triage_actions m ON m.id = ${main.id}
      WHERE f.id <> m.id
        AND f.created_at = m.created_at
        AND f.actor = m.actor
        AND f.action = m.action
        AND f.source = m.source
        AND f.note LIKE ${`with #${number}%`}
        AND f.undone_at IS NULL
      ORDER BY f.id
    `;
    const rows: UndoActionRow[] = [main];
    for (const { id } of followIds) {
      const row = await actionRow(Number(id));
      if (row) rows.push(row);
    }

    const plans: { row: UndoActionRow; steps: UndoStep[] }[] = [];
    for (const row of rows) {
      await tx`SELECT item_key FROM triage_items WHERE item_key = ${row.itemKey} FOR UPDATE`;
      const assignments = await tx<
        {
          id: string;
          maintainer: string;
          role: "primary" | "backup";
          status: UndoAssignmentState["status"];
          closed_at: Date | null;
          assigned_at: Date;
          assigned_by: string;
          notified_at: Date | null;
          created_by_action: boolean;
          was_acked: boolean;
        }[]
      >`
        SELECT a.id, a.maintainer, a.role, a.status, a.closed_at, a.assigned_at, a.assigned_by,
               a.notified_at,
               a.assigned_at = (SELECT created_at FROM triage_actions WHERE id = ${row.id}) AS created_by_action,
               (a.reason ? 'acked_by' OR EXISTS (
                  SELECT 1 FROM triage_actions t
                  WHERE t.assignment_id = a.id AND t.action = 'ack' AND t.undone_at IS NULL
               )) AS was_acked
        FROM triage_assignments a WHERE a.item_key = ${row.itemKey}
        FOR UPDATE OF a
      `;
      const [later] = await tx<{ n: string }[]>`
        SELECT count(*) AS n FROM triage_actions
        WHERE item_key = ${row.itemKey} AND id > ${row.id} AND undone_at IS NULL
      `;
      const planned = planUndo(
        row,
        assignments.map((a) => ({
          id: Number(a.id),
          maintainer: a.maintainer,
          role: a.role,
          status: a.status,
          closedAt: iso(a.closed_at),
          assignedAt: iso(a.assigned_at)!,
          assignedBy: a.assigned_by,
          notifiedAt: iso(a.notified_at),
          createdByAction: a.created_by_action,
          wasAcked: a.was_acked,
        })),
        Number(later?.n ?? 0),
      );
      if (!planned.ok) {
        // The clicked item must undo cleanly; a fix PR that moved on since is left as it is.
        if (row.id === main.id) return planned;
        continue;
      }
      plans.push({ row, steps: planned.value });
    }

    for (const { row, steps } of plans) {
      // Kept for the record, marked undone; every reader skips undone rows.
      await tx`UPDATE triage_actions SET undone_at = now() WHERE id = ${row.id}`;
      for (const step of steps) {
        if (step.kind === "delete") {
          await tx`DELETE FROM triage_assignments WHERE id = ${step.assignmentId} AND status = 'open'`;
        } else {
          await tx`
            UPDATE triage_assignments SET status = ${step.status}, closed_at = NULL
            WHERE id = ${step.assignmentId}
          `;
        }
      }
    }
    return { ok: true as const, value: { itemKeys: plans.map(({ row }) => row.itemKey) } };
  });
}
