import { getDb } from "@/lib/db";
import { resolveGroupsToJobConditions } from "@/lib/test-groups";

// ---------------------------------------------------------------------------
// Shared types / helpers
// ---------------------------------------------------------------------------

export interface CiFilter {
  pipeline?: string | null;
  branch?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

type Sql = ReturnType<typeof getDb>;

// Job states that count as a completed run for failure-rate math.
// Buildkite OTel job spans report job_state as 'finished' | 'canceled' |
// 'timed_out' (not passed/failed). The pass/fail outcome lives in the
// buildkite.job.passed attribute ('true'/'false') and exit_status. Map these to
// the Databricks state vocabulary the dashboard already uses.
//   passed    -> job_state='finished' AND passed='true'
//   failed    -> job_state='finished' AND passed='false'  (non-zero exit)
//   timed_out -> job_state='timed_out'
//   canceled  -> job_state='canceled'  (excluded from completed/failed sets)
// "Completed" (runs that count toward failure-rate denominator): finished or
// timed_out. "Failed": finished-and-not-passed, or timed_out.
const JOB_COMPLETED = `(j.job_state = 'finished' OR j.job_state = 'timed_out')`;
const JOB_FAILED = `((j.job_state = 'finished' AND j.job_passed = 'false') OR j.job_state = 'timed_out')`;
const JOB_PASSED = `(j.job_state = 'finished' AND j.job_passed = 'true')`;

// Derived job state label matching the Databricks `state` vocabulary, for
// display in job listings and run history.
const JOB_STATE_LABEL = `CASE
  WHEN j.job_state = 'finished' AND j.job_passed = 'true' THEN 'passed'
  WHEN j.job_state = 'finished' THEN 'failed'
  WHEN j.job_state = 'timed_out' THEN 'timed_out'
  WHEN j.job_state = 'canceled' THEN 'canceled'
  ELSE j.job_state
END`;

// Join condition linking a job span (j) to its build span (b). build_id is NULL
// on Buildkite spans (Buildkite sends no buildkite.build.id attribute), so join
// on the (pipeline_slug, build_number) pair present on both.
const BUILD_JOIN = `b.pipeline_slug = j.pipeline_slug AND b.build_number = j.build_number AND b.span_name = 'buildkite.build'`;

function toIsoDate(date: string): string {
  // Accepts YYYY-MM-DD or a full ISO timestamp; returns an ISO timestamp usable
  // for timestamptz comparison. postgres.js serializes Date/string params.
  return date.length === 10 ? `${date}T00:00:00.000Z` : date;
}

function endExclusive(date: string): string {
  // Mirror DATE_ADD(endDate, 1): the end date is inclusive, so filter < end+1d.
  const d = new Date(toIsoDate(date));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/**
 * Convert a Buildkite pipeline display name (e.g. "CI", "AMD CI") to its slug
 * ("ci", "amd-ci"). Buildkite slugifies by lowercasing and replacing runs of
 * non-alphanumeric characters with a single hyphen. Filtering on the indexed
 * pipeline_slug column is far faster than a JSONB resource-attribute lookup.
 */
export function pipelineNameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Filter on the indexed pipeline_slug column. */
function pipelineClause(sql: Sql, pipeline?: string | null) {
  if (!pipeline) return sql``;
  return sql`AND pipeline_slug = ${pipelineNameToSlug(pipeline)}`;
}

function branchClause(sql: Sql, branch?: string | null) {
  if (!branch) return sql``;
  return sql`AND span_attributes->>'buildkite.build.branch' = ${branch}`;
}

function buildDateClauses(sql: Sql, f: CiFilter) {
  return sql`
    ${f.startDate ? sql`AND start_time >= ${toIsoDate(f.startDate)}::timestamptz` : sql``}
    ${f.endDate ? sql`AND start_time < ${endExclusive(f.endDate)}::timestamptz` : sql``}
  `;
}

/**
 * Time bounds applied to a job span (alias j) so the self-join against the
 * build span can prune partitions/rows instead of scanning the whole table.
 * Job start_time should fall within the build window; we bound it directly.
 */
function jobDateClauses(sql: Sql, f: CiFilter) {
  return sql`
    ${f.startDate ? sql`AND j.start_time >= ${toIsoDate(f.startDate)}::timestamptz` : sql``}
    ${f.endDate ? sql`AND j.start_time < ${endExclusive(f.endDate)}::timestamptz` : sql``}
  `;
}

/**
 * Postgres equivalent of the Databricks job-group/name filter subquery.
 * Returns a fragment restricting to builds that have a matching script job.
 */
function jobFilterClause(sql: Sql, f: CiFilter, jobGroups: string[], jobNames: string[]) {
  const conditions = [];
  if (jobNames.length > 0) {
    conditions.push(sql`jf.job_label IN ${sql(jobNames)}`);
  }
  if (jobGroups.length > 0) {
    const { exactNames, regexPatterns } = resolveGroupsToJobConditions(jobGroups);
    if (exactNames.length > 0) {
      conditions.push(sql`jf.job_label IN ${sql(exactNames)}`);
    }
    for (const pattern of regexPatterns) {
      conditions.push(sql`jf.job_label ~ ${pattern}`);
    }
  }
  if (conditions.length === 0) return sql``;

  const or = conditions.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} OR ${c}`));
  // build_id is NULL on Buildkite spans, so match the outer build span to its
  // jobs on (pipeline_slug, build_number).
  return sql`
    AND (pipeline_slug, build_number) IN (
      SELECT jf.pipeline_slug, jf.build_number
      FROM otel_spans AS jf
      WHERE jf.span_name = 'buildkite.job'
        AND jf.job_label IS NOT NULL
        AND jf.job_type = 'script'
        ${f.pipeline ? sql`AND jf.pipeline_slug = ${pipelineNameToSlug(f.pipeline)}` : sql``}
        ${f.startDate ? sql`AND jf.start_time >= ${toIsoDate(f.startDate)}::timestamptz` : sql``}
        ${f.endDate ? sql`AND jf.start_time < ${endExclusive(f.endDate)}::timestamptz` : sql``}
        AND jf.job_state <> 'canceled'
        AND (${or})
    )
  `;
}

// ---------------------------------------------------------------------------
// /api/builds
// ---------------------------------------------------------------------------

export interface OtelBuildsResult {
  builds: Record<string, unknown>[];
  buildDurations: Record<string, unknown>[];
  summary: { total: number; passed: number; failed: number; passRate: number };
  total: number;
}

export async function queryBuildsFromOtel(
  f: CiFilter & { page: number; pageSize: number; jobGroups: string[]; jobNames: string[]; state?: string | null },
): Promise<OtelBuildsResult> {
  const sql: Sql = getDb();
  const where = sql`
    span_name = 'buildkite.build'
    ${pipelineClause(sql, f.pipeline)}
    ${branchClause(sql, f.branch)}
    ${buildDateClauses(sql, f)}
    ${f.state ? sql`AND build_state = ${f.state}` : sql``}
    ${jobFilterClause(sql, f, f.jobGroups, f.jobNames)}
  `;

  const buildsPromise = sql<Record<string, unknown>[]>`
    SELECT
      (pipeline_slug || ':' || build_number) AS id,
      build_number::text AS build_number,
      span_attributes->>'buildkite.build.web_url' AS web_url,
      span_attributes->>'buildkite.build.message' AS message,
      span_attributes->>'buildkite.build.commit' AS commit_sha,
      resource_attributes->>'buildkite.pipeline.name' AS pipeline,
      span_attributes->>'buildkite.build.branch' AS branch,
      build_state AS state,
      start_time AS created_at,
      start_time AS started_at,
      end_time AS finished_at,
      COALESCE(
        NULLIF(span_attributes->>'buildkite.build.creator.name', ''),
        NULLIF(span_attributes->>'buildkite.build.creator.email', '')
      ) AS author,
      organization_slug,
      pipeline_slug
    FROM otel_spans
    WHERE ${where}
    ORDER BY start_time DESC
    LIMIT ${f.pageSize} OFFSET ${f.page * f.pageSize}
  `;

  // The OTel build span records the terminal state, so CI builds waiting on a
  // manual unblock are 'blocked' rather than 'passed'. Databricks reflects the
  // post-unblock outcome, so count blocked as passed to match it.
  const countPromise = sql<Record<string, unknown>[]>`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE build_state IN ('passed', 'blocked'))::int AS passed,
      COUNT(*) FILTER (WHERE build_state IN ('failed', 'failing'))::int AS failed
    FROM otel_spans
    WHERE ${where}
  `;

  const durationsPromise = sql<Record<string, unknown>[]>`
    SELECT
      (pipeline_slug || ':' || build_number) AS id,
      build_state AS state,
      start_time AS created_at,
      start_time AS started_at,
      end_time AS finished_at,
      ROUND(duration_ms / 60000.0)::int AS duration_mins
    FROM otel_spans
    WHERE ${where}
    ORDER BY start_time ASC
  `;

  const [builds, countRows, buildDurations] = await Promise.all([
    buildsPromise,
    countPromise,
    durationsPromise,
  ]);

  const counts = countRows[0] ?? { total: 0, passed: 0, failed: 0 };
  const total = Number(counts.total) || 0;
  const passed = Number(counts.passed) || 0;
  const failed = Number(counts.failed) || 0;
  const passRate = passed + failed > 0 ? Math.round((passed / (passed + failed)) * 100) : 0;

  return { builds, buildDurations, summary: { total, passed, failed, passRate }, total };
}

// ---------------------------------------------------------------------------
// /api/builds/summary  (builds + per-build job states)
// ---------------------------------------------------------------------------

// buildIds are composite "pipeline_slug:build_number" keys produced by
// queryBuildsFromOtel (Buildkite spans have no build_id). Returns one row per
// script job with the composite build key echoed back as build_id so callers
// can group by the same key.
export async function queryBuildJobsFromOtel(buildIds: string[]) {
  const keys = buildIds
    .map((id) => {
      const idx = id.lastIndexOf(":");
      if (idx <= 0) return null;
      const slug = id.slice(0, idx);
      const num = Number(id.slice(idx + 1));
      return Number.isInteger(num) ? { slug, num } : null;
    })
    .filter((k): k is { slug: string; num: number } => k !== null);
  if (keys.length === 0) return [] as Record<string, unknown>[];

  const sql: Sql = getDb();
  // Match exact (pipeline_slug, build_number) pairs, not the cross-product.
  const pairs = keys.map((k) => sql`(${k.slug}, ${k.num})`);
  const pairList = pairs.reduce((acc, p, i) => (i === 0 ? p : sql`${acc}, ${p}`));
  return sql<Record<string, unknown>[]>`
    SELECT
      (j.pipeline_slug || ':' || j.build_number) AS build_id,
      j.job_label AS name,
      ${sql.unsafe(JOB_STATE_LABEL)} AS state,
      j.span_attributes->>'buildkite.job.web_url' AS web_url,
      j.start_time AS started_at,
      j.span_attributes->>'buildkite.build.commit' AS commit_sha,
      j.span_attributes->>'buildkite.build.branch' AS branch
    FROM otel_spans AS j
    WHERE j.span_name = 'buildkite.job'
      AND (j.pipeline_slug, j.build_number) IN (${pairList})
      AND j.job_label IS NOT NULL
      AND j.span_attributes->>'buildkite.job.type' = 'script'
  `;
}

// ---------------------------------------------------------------------------
// /api/jobs  (failure ranking + duration stats)
// ---------------------------------------------------------------------------

export interface OtelJobStatsResult {
  failureRanking: Record<string, unknown>[];
  durationStats: Record<string, unknown>[];
}

export async function queryJobStatsFromOtel(
  f: CiFilter & { hasDateRange: boolean },
): Promise<OtelJobStatsResult> {
  const sql: Sql = getDb();
  // Filter the job span (j) on the indexed pipeline_slug and start_time so the
  // join against the build span (b) prunes early. Branch lives only on the
  // build span, so it stays on b.
  const baseWhere = sql`
    j.span_name = 'buildkite.job'
    AND j.job_label IS NOT NULL
    AND j.job_type = 'script'
    AND b.span_name = 'buildkite.build'
    ${f.pipeline ? sql`AND j.pipeline_slug = ${pipelineNameToSlug(f.pipeline)}` : sql``}
    ${f.branch ? sql`AND b.span_attributes->>'buildkite.build.branch' = ${f.branch}` : sql``}
    ${jobDateClauses(sql, f)}
  `;
  // When no explicit date range, restrict to jobs whose build ran in the last 7d.
  const recency = f.hasDateRange
    ? sql``
    : sql`AND j.start_time >= NOW() - INTERVAL '7 days'`;

  const failurePromise = sql<Record<string, unknown>[]>`
    SELECT
      j.job_label AS name,
      COUNT(*)::int AS total_runs,
      COUNT(*) FILTER (WHERE ${sql.unsafe(JOB_FAILED)})::int AS failures,
      COUNT(*) FILTER (WHERE ${sql.unsafe(JOB_PASSED)})::int AS passes,
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE ${sql.unsafe(JOB_FAILED)})
        / NULLIF(COUNT(*) FILTER (WHERE ${sql.unsafe(JOB_COMPLETED)}), 0),
        1
      ) AS failure_rate,
      MAX(CASE WHEN j.job_soft_failed = 'true' THEN 1 ELSE 0 END) AS has_soft_fail
    FROM otel_spans AS j
    INNER JOIN otel_spans AS b ON ${sql.unsafe(BUILD_JOIN)}
    WHERE ${baseWhere}
      AND ${sql.unsafe(JOB_COMPLETED)}
      ${recency}
    GROUP BY j.job_label
    HAVING COUNT(*) FILTER (WHERE ${sql.unsafe(JOB_FAILED)}) > 0
    ORDER BY failure_rate DESC, failures DESC
  `;

  const durationPromise = sql<Record<string, unknown>[]>`
    SELECT
      j.job_label AS name,
      COUNT(*)::int AS total_runs,
      ROUND(AVG(j.duration_ms) / 1000.0)::int AS avg_duration,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY j.duration_ms) / 1000.0)::int AS p50_duration,
      ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY j.duration_ms) / 1000.0)::int AS p90_duration,
      ROUND(MAX(j.duration_ms) / 1000.0)::int AS max_duration
    FROM otel_spans AS j
    INNER JOIN otel_spans AS b ON ${sql.unsafe(BUILD_JOIN)}
    WHERE ${baseWhere}
      AND ${sql.unsafe(JOB_PASSED)}
      ${recency}
    GROUP BY j.job_label
    HAVING COUNT(*) > 0
    ORDER BY p50_duration DESC
  `;

  const [failureRanking, durationStats] = await Promise.all([failurePromise, durationPromise]);
  return { failureRanking, durationStats };
}

// ---------------------------------------------------------------------------
// /api/jobs/runs
// ---------------------------------------------------------------------------

export async function queryJobRunsFromOtel(
  f: CiFilter & { jobName: string },
): Promise<Record<string, unknown>[]> {
  const sql: Sql = getDb();
  return sql<Record<string, unknown>[]>`
    SELECT
      j.job_id,
      j.span_attributes->>'buildkite.job.web_url' AS web_url,
      ${sql.unsafe(JOB_STATE_LABEL)} AS state,
      j.start_time AS started_at,
      j.end_time AS finished_at,
      ROUND(j.duration_ms / 1000.0)::int AS duration_secs,
      b.span_attributes->>'buildkite.build.commit' AS commit_sha,
      b.start_time AS build_created_at
    FROM otel_spans AS j
    INNER JOIN otel_spans AS b ON ${sql.unsafe(BUILD_JOIN)}
    WHERE j.span_name = 'buildkite.job'
      AND j.job_type = 'script'
      AND j.job_label = ${f.jobName}
      ${f.pipeline ? sql`AND j.pipeline_slug = ${pipelineNameToSlug(f.pipeline)}` : sql``}
      ${f.branch ? sql`AND b.span_attributes->>'buildkite.build.branch' = ${f.branch}` : sql``}
      ${jobDateClauses(sql, f)}
      AND ${sql.unsafe(JOB_COMPLETED)}
    ORDER BY b.start_time ASC
  `;
}

// ---------------------------------------------------------------------------
// /api/queue
// ---------------------------------------------------------------------------

export interface OtelQueueResult {
  queueStats: Record<string, unknown>[];
  dailyWaitTime: Record<string, unknown>[];
  queueNames: string[];
}

function queueTimeBucketStride(hourSpan: number): string {
  // Stride for date_bin over j.start_time, mirroring the adaptive bucketing in
  // the Databricks route. Week-ish ranges use 7-day bins (epoch-aligned, which
  // is fine for a trend chart).
  if (hourSpan <= 6) return "5 minutes";
  if (hourSpan <= 24) return "15 minutes";
  if (hourSpan <= 3 * 24) return "1 hour";
  if (hourSpan <= 7 * 24) return "3 hours";
  if (hourSpan <= 14 * 24) return "6 hours";
  if (hourSpan <= 30 * 24) return "1 day";
  return "7 days";
}

export async function queryQueueFromOtel(
  f: CiFilter & { queue?: string | null },
): Promise<OtelQueueResult> {
  const sql: Sql = getDb();

  let hourSpan = 14 * 24;
  if (f.startDate && f.endDate) {
    hourSpan = Math.max(
      1,
      Math.round((new Date(f.endDate).getTime() - new Date(f.startDate).getTime()) / 3600000),
    );
  }
  const stride = queueTimeBucketStride(hourSpan);

  // The queue route filters by pipeline/queue only (no branch), and job spans
  // carry pipeline_slug + start_time, so we can drop the build self-join.
  const baseWhere = sql`
    j.span_name = 'buildkite.job'
    AND j.job_type = 'script'
    AND j.agent_queue IS NOT NULL
    AND j.job_wait_time_ms IS NOT NULL
    ${f.pipeline ? sql`AND j.pipeline_slug = ${pipelineNameToSlug(f.pipeline)}` : sql``}
    ${f.queue ? sql`AND j.agent_queue = ${f.queue}` : sql``}
    ${jobDateClauses(sql, f)}
  `;
  const recency = f.startDate || f.endDate
    ? sql``
    : sql`AND j.start_time >= NOW() - INTERVAL '7 days'`;

  const waitSecs = sql`j.job_wait_time_ms / 1000.0`;

  const statsPromise = sql<Record<string, unknown>[]>`
    SELECT
      j.agent_queue AS queue,
      COUNT(*)::int AS total_jobs,
      ROUND(AVG(${waitSecs}))::int AS avg_wait,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${waitSecs}))::int AS p50_wait,
      ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY ${waitSecs}))::int AS p90_wait,
      ROUND(MAX(${waitSecs}))::int AS max_wait
    FROM otel_spans AS j
    WHERE ${baseWhere} ${recency}
    GROUP BY j.agent_queue
    ORDER BY p50_wait DESC
  `;

  const trendPromise = sql<Record<string, unknown>[]>`
    SELECT
      date_bin(${stride}::interval, j.start_time, '1970-01-01') AS time_bucket,
      j.agent_queue AS queue,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY j.job_wait_time_ms / 1000.0))::int AS p50_wait,
      ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY j.job_wait_time_ms / 1000.0))::int AS p90_wait,
      COUNT(*)::int AS total_jobs
    FROM otel_spans AS j
    WHERE ${baseWhere}
    GROUP BY time_bucket, j.agent_queue
    ORDER BY time_bucket
  `;

  const namesPromise = sql<Record<string, unknown>[]>`
    SELECT DISTINCT agent_queue AS queue
    FROM otel_spans
    WHERE span_name = 'buildkite.job'
      AND agent_queue IS NOT NULL
      AND start_time > NOW() - INTERVAL '30 days'
    ORDER BY queue
  `;

  const [queueStats, dailyWaitTime, queueNames] = await Promise.all([
    statsPromise,
    trendPromise,
    namesPromise,
  ]);

  return {
    queueStats,
    dailyWaitTime,
    queueNames: queueNames.map((q) => q.queue as string),
  };
}

// ---------------------------------------------------------------------------
// /api/cost
// ---------------------------------------------------------------------------

export interface OtelCostRaw {
  byQueue: Record<string, unknown>[];
  dailyCost: Record<string, unknown>[];
  byBuild: Record<string, unknown>[];
  byJob: Record<string, unknown>[];
}

export async function queryCostFromOtel(f: CiFilter): Promise<OtelCostRaw> {
  const sql: Sql = getDb();
  const hours = sql`j.duration_ms / 3600000.0`;

  // Job-span-only filters (indexed pipeline_slug + start_time). Branch is the
  // only filter that lives on the build span, so byQueue/daily/byJob skip the
  // self-join unless a branch filter is requested.
  const jobWhere = sql`
    j.span_name = 'buildkite.job'
    AND j.job_type = 'script'
    AND j.agent_queue IS NOT NULL
    ${f.pipeline ? sql`AND j.pipeline_slug = ${pipelineNameToSlug(f.pipeline)}` : sql``}
    ${jobDateClauses(sql, f)}
  `;
  const branchJoin = f.branch
    ? sql`INNER JOIN otel_spans AS b ON ${sql.unsafe(BUILD_JOIN)}`
    : sql``;
  const branchWhere = f.branch
    ? sql`AND b.span_attributes->>'buildkite.build.branch' = ${f.branch}`
    : sql``;

  const byQueuePromise = sql<Record<string, unknown>[]>`
    SELECT
      j.agent_queue AS queue,
      COUNT(*)::int AS total_jobs,
      ROUND(SUM(${hours})::numeric, 2) AS total_hours
    FROM otel_spans AS j
    ${branchJoin}
    WHERE ${jobWhere} ${branchWhere}
    GROUP BY j.agent_queue
    ORDER BY total_hours DESC
  `;

  const dailyPromise = sql<Record<string, unknown>[]>`
    SELECT
      j.start_time::date AS date,
      j.agent_queue AS queue,
      ROUND(SUM(${hours})::numeric, 2) AS total_hours
    FROM otel_spans AS j
    ${branchJoin}
    WHERE ${jobWhere} ${branchWhere}
    GROUP BY j.start_time::date, j.agent_queue
    ORDER BY date
  `;

  // byBuild needs build-level attributes (url/message/commit/author), so it
  // always joins to the build span. build_id is NULL on Buildkite spans, so
  // group/identify builds by the (pipeline_slug, build_number) pair.
  const byBuildPromise = sql<Record<string, unknown>[]>`
    SELECT
      (j.pipeline_slug || ':' || j.build_number) AS build_id,
      b.span_attributes->>'buildkite.build.web_url' AS build_url,
      b.span_attributes->>'buildkite.build.message' AS message,
      b.span_attributes->>'buildkite.build.commit' AS commit_sha,
      b.span_attributes->>'buildkite.build.branch' AS branch,
      COALESCE(
        NULLIF(b.span_attributes->>'buildkite.build.creator.name', ''),
        NULLIF(b.span_attributes->>'buildkite.build.creator.email', '')
      ) AS author,
      b.start_time AS created_at,
      COUNT(*)::int AS total_jobs,
      ROUND(SUM(${hours})::numeric, 4) AS total_hours
    FROM otel_spans AS j
    INNER JOIN otel_spans AS b ON ${sql.unsafe(BUILD_JOIN)}
    WHERE ${jobWhere}
      ${f.branch ? sql`AND b.span_attributes->>'buildkite.build.branch' = ${f.branch}` : sql``}
    GROUP BY j.pipeline_slug, j.build_number, b.span_attributes, b.start_time
    ORDER BY total_hours DESC
    LIMIT 100
  `;

  const byJobPromise = sql<Record<string, unknown>[]>`
    SELECT
      j.job_label AS job_name,
      j.agent_queue AS queue,
      COUNT(*)::int AS total_runs,
      ROUND(SUM(${hours})::numeric, 4) AS total_hours
    FROM otel_spans AS j
    ${branchJoin}
    WHERE ${jobWhere} ${branchWhere}
    GROUP BY j.job_label, j.agent_queue
  `;

  const [byQueue, dailyCost, byBuild, byJob] = await Promise.all([
    byQueuePromise,
    dailyPromise,
    byBuildPromise,
    byJobPromise,
  ]);

  return { byQueue, dailyCost, byBuild, byJob };
}
