import { getDb } from "@/lib/db";
import type { QueueFilters } from "@/lib/triage-query";
import {
  planTriageAction,
  type ActionRequest,
  type AssignmentState,
  type PlanResult,
} from "@/lib/triage-actions";
import { matchRules, normalizeRules } from "@/lib/triage-rules";
import type {
  TriageAssignment,
  TriageBreakdownEntry,
  TriageAssignmentSummary,
  TriageFacets,
  TriageItemDetail,
  TriageMaintainer,
  TriageMyPlate,
  TriagePrepass,
  TriageQueueItem,
  TriageQueueResponse,
  TriageRules,
  TriageStats,
} from "@/lib/triage-types";
import type { NotifyMode } from "@/lib/triage-vocab";

type Db = ReturnType<typeof getDb>;

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
    assignments: row.assignments ?? [],
  };
}

/**
 * The columns every queue-shaped query returns: the item, its current score,
 * its latest extraction's facets, and its open/acked assignments.
 */
function queueSelect(db: Db) {
  return db`
    SELECT i.item_key, i.repo, i.number, i.kind, i.title, i.html_url, i.author,
           i.state, i.draft, i.gh_created_at, i.gh_updated_at, i.prepass,
           s.score, s.band, e.facets,
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

export async function listQueue(filters: QueueFilters): Promise<TriageQueueResponse> {
  const db = getDb();
  const realBands = filters.bands.filter((band) => band !== "unscored");
  const includeUnscored = filters.bands.includes("unscored");
  const bandFilter = db`AND (${
    realBands.length > 0 ? db`s.band IN ${db(realBands)}` : db`false`
  } OR ${includeUnscored ? db`s.band IS NULL` : db`false`})`;
  // db.json, not JSON.stringify: a plain string parameter cast to ::jsonb
  // arrives as a JSON *string* scalar under prepare:false, so @> never matches.
  const json = (value: unknown) => db.json(value as never);

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
    ${filters.assignee
      ? db`AND EXISTS (SELECT 1 FROM triage_assignments a
                       WHERE a.item_key = i.item_key AND a.status IN ('open', 'acked')
                         AND lower(a.maintainer) = lower(${filters.assignee}))`
      : db``}
    ${statusFilter(db, filters.status)}
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
    ${queueSelect(db)}, count(*) OVER () AS total
    FROM triage_items i
    ${latestExtractionJoin(db)}
    ${where}
    ${order}
    LIMIT ${filters.pageSize} OFFSET ${(filters.page - 1) * filters.pageSize}
  `;
  return {
    items: rows.map(toQueueItem),
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
  const db = getDb();
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

  const [score, extraction, assignments, actions] = await Promise.all([
    db<{ score: number; band: string; breakdown: unknown; scoring_version: string; scored_at: Date }[]>`
      SELECT score, band, breakdown, scoring_version, scored_at
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
      }[]
    >`
      SELECT id, item_key, assignment_id, actor, action, target, note, source, created_at
      FROM triage_actions WHERE item_key = ${itemKey}
      ORDER BY created_at DESC, id DESC LIMIT 200
    `,
  ]);

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

  return {
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
    })),
  };
}

export async function getMyPlate(login: string): Promise<TriageMyPlate> {
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
  return { login, open, recentlyClosed };
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

export async function listActiveMaintainers(): Promise<
  { githubLogin: string; openAssignments: number }[]
> {
  const db = getDb();
  const rows = await db<{ github_login: string; open_assignments: string }[]>`
    SELECT m.github_login,
           (SELECT count(*) FROM triage_assignments a
             WHERE a.maintainer = m.github_login AND a.status IN ('open', 'acked')) AS open_assignments
    FROM triage_maintainers m
    WHERE m.active
    ORDER BY lower(m.github_login)
  `;
  return rows.map((row) => ({
    githubLogin: row.github_login,
    openAssignments: Number(row.open_assignments),
  }));
}

export async function getMaintainer(login: string): Promise<TriageMaintainer | null> {
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

export async function getStats(): Promise<TriageStats> {
  const db = getDb();
  const [row] = await db<
    {
      ingested_24h: string;
      in_scope_7d: string;
      extracted_7d: string;
      page_unacked: string;
      assigned_7d: string;
      not_mine_7d: string;
    }[]
  >`
    SELECT
      (SELECT count(*) FROM triage_items WHERE first_seen_at > now() - interval '24 hours') AS ingested_24h,
      (SELECT count(*) FROM triage_items
        WHERE in_scope AND first_seen_at > now() - interval '7 days') AS in_scope_7d,
      (SELECT count(*) FROM triage_items
        WHERE in_scope AND first_seen_at > now() - interval '7 days'
          AND extraction_status = 'done') AS extracted_7d,
      (SELECT count(*) FROM triage_scores s JOIN triage_items i ON i.item_key = s.item_key
        WHERE s.band = 'page' AND i.state = 'open'
          AND NOT EXISTS (SELECT 1 FROM triage_assignments a
                          WHERE a.item_key = s.item_key AND a.status IN ('acked', 'done'))) AS page_unacked,
      (SELECT count(*) FROM triage_assignments
        WHERE assigned_at > now() - interval '7 days') AS assigned_7d,
      (SELECT count(*) FROM triage_actions
        WHERE action = 'not_mine' AND created_at > now() - interval '7 days') AS not_mine_7d
  `;
  return {
    ingestedLast24h: Number(row.ingested_24h),
    inScopeLast7d: Number(row.in_scope_7d),
    extractedLast7d: Number(row.extracted_7d),
    pageUnacked: Number(row.page_unacked),
    assignedLast7d: Number(row.assigned_7d),
    notMineLast7d: Number(row.not_mine_7d),
  };
}

/**
 * Applies one maintainer action in a single transaction: lock the item's
 * assignments, plan the transition, update/insert assignments, and record a
 * triage_actions row.
 */
export async function applyTriageAction(
  actor: string,
  request: ActionRequest,
): Promise<PlanResult | { ok: true; assignmentId: number | null; actionId: number }> {
  const db = getDb();
  return db.begin(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [item] = await tx<{ item_key: string }[]>`
      SELECT item_key FROM triage_items WHERE item_key = ${request.itemKey} FOR UPDATE
    `;
    if (!item) return { ok: false as const, status: 404 as const, error: "No such triage item." };

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
      FROM triage_assignments WHERE item_key = ${request.itemKey}
      FOR UPDATE
    `;
    const maintainers = await tx<{ github_login: string }[]>`
      SELECT github_login FROM triage_maintainers WHERE active
    `;
    const assignments: AssignmentState[] = rows.map((row) => ({
      id: Number(row.id),
      maintainer: row.maintainer,
      role: row.role,
      status: row.status,
      closedAt: iso(row.closed_at),
      assignedAt: iso(row.assigned_at)!,
    }));
    const active = new Set(maintainers.map((row) => row.github_login.toLowerCase()));
    const result = planTriageAction(request, actor, assignments, active);
    if (!result.ok) return result;
    const { plan } = result;

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
        // actor, never 'repo': the maintainers.yaml sync only manages rows
        // listed in the file or marked updated_by='repo', so it leaves this
        // row alone until the person adds themselves to the file.
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
          ${db.json({ manual: request.action, by: actor } as never)}::jsonb,
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
              ${request.target}, ${request.note}, 'dashboard')
      RETURNING id
    `;
    return { ok: true as const, assignmentId, actionId: Number(action.id) };
  });
}
