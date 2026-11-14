import { queryClickHouse, type ClickHouseParam } from "@/lib/clickhouse";
import { attrText, DEDUPE_SPANS, toNullableNumber, toNumber } from "@/lib/otel-clickhouse";
import { enrichBuildAuthors } from "@/lib/github-build-authors";
import { resolveGroupsToJobConditions } from "@/lib/test-groups";
import type { ServerTiming } from "@/lib/server-timing";
import { SHARD_SUFFIX_SQL, SHARD_TOTAL_SQL } from "@/lib/job-shards";

// OTel CI reads (?source=otel) over ClickHouse `ci.otel_spans`, the same spans
// the Postgres `otel_spans` table held. Each function returns the shape its
// Postgres version returned: counts and whole-second/minute values are
// numbers, ROUNDed numerics (failure_rate, total_hours) are strings, and
// timestamps are millisecond ISO strings (what a Postgres Date serialized to).
//
// The table is a ReplacingMergeTree, so a retried export or a backfill overlap
// can leave duplicate rows until a merge. Every read keeps one row per
// (trace_id, span_id), the newest, as Postgres's upsert did: span subqueries
// filter on columns a span's versions share (name, pipeline, label, start
// time), dedupe, and only then test fields a later version can change
// (job/build state). FINAL would read the whole sort-key range instead.

// ---------------------------------------------------------------------------
// Shared types / helpers
// ---------------------------------------------------------------------------

export interface CiFilter {
  pipeline?: string | null;
  branch?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

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
// timed_out. "Failed": finished-and-not-passed, or timed_out. A NULL outcome
// stays NULL (neither passed nor failed), as in SQL's three-valued logic.
const JOB_COMPLETED = `(j.job_state = 'finished' OR j.job_state = 'timed_out')`;
const JOB_FAILED = `((j.job_state = 'finished' AND j.job_passed = 'false') OR j.job_state = 'timed_out')`;

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
const BUILD_JOIN = `b.pipeline_slug = j.pipeline_slug AND b.build_number = j.build_number`;

const STEP_NAME = `replaceRegexpOne(j.job_label, '${SHARD_SUFFIX_SQL}', '')`;
const SHARD_TOTAL = `toInt32OrNull(extract(j.job_label, '${SHARD_TOTAL_SQL}'))`;

/** Collects typed ClickHouse query parameters; never interpolate values. */
class Params {
  readonly values: Record<string, ClickHouseParam> = {};
  private count = 0;

  bind(value: ClickHouseParam, type: string): string {
    const name = `p${this.count++}`;
    this.values[name] = value;
    return `{${name}:${type}}`;
  }

  time(iso: string): string {
    return `parseDateTime64BestEffort(${this.bind(iso, "String")}, 6, 'UTC')`;
  }
}

/** One row per span, the newest, of the spans matching `where`. */
function spans(columns: string, where: string[]): string {
  return `(
      SELECT ${columns}
      FROM ci.otel_spans
      WHERE ${where.join("\n        AND ")}
      ${DEDUPE_SPANS}
    )`;
}

function toIsoDate(date: string): string {
  // Accepts YYYY-MM-DD or a full ISO timestamp; returns an ISO timestamp.
  return date.length === 10 ? `${date}T00:00:00.000Z` : date;
}

function endExclusive(date: string): string {
  // A full timestamp (from a drag-zoom on a chart) is already the exact,
  // exclusive end.
  if (date.length !== 10) return date;
  // Mirror DATE_ADD(endDate, 1): the end date is inclusive, so filter < end+1d.
  const d = new Date(toIsoDate(date));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/**
 * Convert a Buildkite pipeline display name (e.g. "CI", "AMD CI") to its slug
 * ("ci", "amd-ci"). Buildkite slugifies by lowercasing and replacing runs of
 * non-alphanumeric characters with a single hyphen. Filtering on the
 * pipeline_slug column is far faster than a resource-attribute lookup.
 */
export function pipelineNameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Pipeline and start-time bounds on a span. */
function spanFilters(p: Params, f: CiFilter): string[] {
  const where: string[] = [];
  if (f.pipeline) where.push(`pipeline_slug = ${p.bind(pipelineNameToSlug(f.pipeline), "String")}`);
  if (f.startDate) where.push(`start_time >= ${p.time(toIsoDate(f.startDate))}`);
  if (f.endDate) where.push(`start_time < ${p.time(endExclusive(f.endDate))}`);
  return where;
}

/** Build spans of the filter's pipeline and branch (no time bound). */
function buildSpans(p: Params, f: CiFilter, columns: string): string {
  const where = ["span_name = 'buildkite.build'"];
  if (f.pipeline) where.push(`pipeline_slug = ${p.bind(pipelineNameToSlug(f.pipeline), "String")}`);
  // build_branch is the materialized buildkite.build.branch attribute.
  if (f.branch) where.push(`build_branch = ${p.bind(f.branch, "String")}`);
  return spans(columns, where);
}

/**
 * RE2 has no lookaround, so a negative lookahead `P(?!N)R` (Postgres regexes
 * supported it) becomes `match(PR) AND NOT match(PN)`.
 */
function regexCondition(p: Params, expr: string, pattern: string): string {
  const lookahead = /^(.*?)\(\?!([^()]*)\)(.*)$/.exec(pattern);
  if (!lookahead) return `match(${expr}, ${p.bind(pattern, "String")})`;
  const [, prefix, negative, rest] = lookahead;
  return `(match(${expr}, ${p.bind(prefix + rest, "String")}) AND NOT match(${expr}, ${p.bind(prefix + negative, "String")}))`;
}

/**
 * Restricts build spans to builds that ran a matching script job, the
 * equivalent of the Databricks job-group/name filter subquery.
 */
function jobFilterClause(p: Params, f: CiFilter, jobGroups: string[], jobNames: string[]): string | null {
  const conditions: string[] = [];
  // Match a runtime-sharded step by its shards too (see job-shards.ts).
  if (jobNames.length > 0) {
    conditions.push(`${STEP_NAME} IN ${p.bind(jobNames, "Array(String)")}`);
  }
  if (jobGroups.length > 0) {
    const { exactNames, regexPatterns } = resolveGroupsToJobConditions(jobGroups);
    if (exactNames.length > 0) {
      conditions.push(`${STEP_NAME} IN ${p.bind(exactNames, "Array(String)")}`);
    }
    for (const pattern of regexPatterns) conditions.push(regexCondition(p, STEP_NAME, pattern));
  }
  if (conditions.length === 0) return null;

  const jobs = spans("pipeline_slug, build_number, job_label, job_state", [
    "span_name = 'buildkite.job'",
    "job_label IS NOT NULL",
    "job_type = 'script'",
    ...spanFilters(p, f),
  ]);
  // build_id is NULL on Buildkite spans, so match the build span to its jobs
  // on (pipeline_slug, build_number).
  return `(pipeline_slug, build_number) IN (
      SELECT j.pipeline_slug, j.build_number
      FROM ${jobs} AS j
      WHERE j.job_state != 'canceled'
        AND (${conditions.join(" OR ")})
    )`;
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
  const p = new Params();
  const where = ["span_name = 'buildkite.build'", ...spanFilters(p, f)];
  if (f.branch) where.push(`build_branch = ${p.bind(f.branch, "String")}`);
  const jobFilter = jobFilterClause(p, f, f.jobGroups, f.jobNames);
  if (jobFilter) where.push(jobFilter);
  // State can change between a span's versions, so test it after dedupe.
  const state = f.state ? `WHERE build_state = ${p.bind(f.state, "String")}` : "";
  const builds = `${spans(
    "pipeline_slug, build_number, organization_slug, build_state, start_time, end_time, duration_ms, span_attributes, resource_attributes",
    where,
  )} AS b ${state}`;

  const buildsPromise = queryClickHouse<Record<string, unknown>>(`
    SELECT
      concat(pipeline_slug, ':', toString(build_number)) AS id,
      toString(build_number) AS build_number,
      ${attrText("buildkite.build.web_url")} AS web_url,
      ${attrText("buildkite.build.message")} AS message,
      ${attrText("buildkite.build.commit")} AS commit_sha,
      ${attrText("buildkite.pipeline.name", "resource_attributes")} AS pipeline,
      ${attrText("buildkite.build.branch")} AS branch,
      -- The OTel build span's terminal state is 'blocked' for builds waiting at
      -- the pipeline's manual gate, even when all jobs passed. Databricks
      -- reflects the resolved state, which is 'passed' for these. Display
      -- 'passed' so the status column matches the warehouse.
      if(build_state = 'blocked', 'passed', build_state) AS state,
      start_time AS created_at,
      start_time AS started_at,
      end_time AS finished_at,
      coalesce(
        ${attrText("buildkite.build.creator.name")},
        ${attrText("buildkite.build.creator.email")}
      ) AS author,
      organization_slug,
      pipeline_slug
    FROM ${builds}
    ORDER BY b.start_time DESC
    LIMIT ${p.bind(f.pageSize, "UInt32")} OFFSET ${p.bind(f.page * f.pageSize, "UInt32")}
  `, p.values);

  // The OTel build span records the terminal state, so CI builds waiting on a
  // manual unblock are 'blocked' rather than 'passed'. Databricks reflects the
  // post-unblock outcome, so count blocked as passed to match it.
  const countPromise = queryClickHouse<Record<string, unknown>>(`
    SELECT
      count() AS total,
      countIf(build_state IN ('passed', 'blocked')) AS passed,
      countIf(build_state IN ('failed', 'failing')) AS failed
    FROM ${builds}
  `, p.values);

  const durationsPromise = queryClickHouse<Record<string, unknown>>(`
    SELECT
      concat(pipeline_slug, ':', toString(build_number)) AS id,
      if(build_state = 'blocked', 'passed', build_state) AS state,
      start_time AS created_at,
      start_time AS started_at,
      end_time AS finished_at,
      toInt32(round(duration_ms / 60000)) AS duration_mins
    FROM ${builds}
    ORDER BY b.start_time ASC
  `, p.values);

  const [builds_, countRows, durations] = await Promise.all([
    buildsPromise,
    countPromise,
    durationsPromise,
  ]);

  const enrichedBuilds = await enrichBuildAuthors(builds_);
  const counts = countRows[0] ?? { total: 0, passed: 0, failed: 0 };
  const total = Number(counts.total) || 0;
  const passed = Number(counts.passed) || 0;
  const failed = Number(counts.failed) || 0;
  const passRate = passed + failed > 0 ? Math.round((passed / (passed + failed)) * 100) : 0;

  return {
    builds: enrichedBuilds,
    buildDurations: durations.map((row) => ({ ...row, duration_mins: toNullableNumber(row.duration_mins) })),
    summary: { total, passed, failed, passRate },
    total,
  };
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
      return Number.isSafeInteger(num) ? { slug, num } : null;
    })
    .filter((k): k is { slug: string; num: number } => k !== null);
  if (keys.length === 0) return [] as Record<string, unknown>[];

  const p = new Params();
  const jobs = spans("pipeline_slug, build_number, job_label, job_state, job_passed, start_time, span_attributes", [
    "span_name = 'buildkite.job'",
    `pipeline_slug IN ${p.bind([...new Set(keys.map((k) => k.slug))], "Array(String)")}`,
    `build_number IN ${p.bind([...new Set(keys.map((k) => k.num))], "Array(Int64)")}`,
    "job_label IS NOT NULL",
  ]);
  // Match exact (pipeline_slug, build_number) pairs, not the cross-product.
  return queryClickHouse<Record<string, unknown>>(`
    SELECT
      concat(j.pipeline_slug, ':', toString(j.build_number)) AS build_id,
      j.job_label AS name,
      ${JOB_STATE_LABEL} AS state,
      ${attrText("buildkite.job.web_url", "j.span_attributes")} AS web_url,
      j.start_time AS started_at,
      ${attrText("buildkite.build.commit", "j.span_attributes")} AS commit_sha,
      ${attrText("buildkite.build.branch", "j.span_attributes")} AS branch
    FROM ${jobs} AS j
    WHERE concat(j.pipeline_slug, ':', toString(j.build_number))
        IN ${p.bind(keys.map((k) => `${k.slug}:${k.num}`), "Array(String)")}
      AND ${attrText("buildkite.job.type", "j.span_attributes")} = 'script'
  `, p.values);
}

// ---------------------------------------------------------------------------
// /api/jobs  (failure ranking + duration stats)
// ---------------------------------------------------------------------------

export interface OtelJobStatsResult {
  failureRanking: Record<string, unknown>[];
  durationStats: Record<string, unknown>[];
}

interface OtelJobStatsRow {
  name: string;
  total_runs: number;
  failures: number;
  passes: number;
  failure_rate: string;
  has_soft_fail: number;
  /** Passed runs with a duration: a sharded run whose shards all ran. */
  timed_passes?: number;
  avg_duration: number | null;
  p50_duration: number | null;
  p90_duration: number | null;
  max_duration: number | null;
}

/** Preserve the two ranking contracts when both come from one aggregate. */
export function splitOtelJobStats(rows: OtelJobStatsRow[]): OtelJobStatsResult {
  return {
    failureRanking: rows
      .filter((row) => row.failures > 0)
      .map(({ name, total_runs, failures, passes, failure_rate, has_soft_fail }) => ({
        name, total_runs, failures, passes, failure_rate, has_soft_fail,
      }))
      .sort((a, b) => Number(b.failure_rate) - Number(a.failure_rate) || b.failures - a.failures),
    durationStats: rows
      .map(({ timed_passes, passes, ...row }) => ({ ...row, timed: timed_passes ?? passes }))
      .filter((row) => row.timed > 0)
      .map(({ name, timed, avg_duration, p50_duration, p90_duration, max_duration }) => ({
        name, total_runs: timed, avg_duration, p50_duration, p90_duration, max_duration,
      }))
      .sort((a, b) => Number(b.p50_duration) - Number(a.p50_duration)),
  };
}

/** A ClickHouse row of strings, parsed into OtelJobStatsRow's numbers. */
export function parseOtelJobStatsRow(row: Record<string, unknown>): OtelJobStatsRow {
  return {
    name: row.name as string,
    total_runs: toNumber(row.total_runs),
    failures: toNumber(row.failures),
    passes: toNumber(row.passes),
    failure_rate: row.failure_rate as string,
    has_soft_fail: toNumber(row.has_soft_fail),
    timed_passes: toNumber(row.timed_passes),
    avg_duration: toNullableNumber(row.avg_duration),
    p50_duration: toNullableNumber(row.p50_duration),
    p90_duration: toNullableNumber(row.p90_duration),
    max_duration: toNullableNumber(row.max_duration),
  };
}

export async function queryJobStatsFromOtel(
  f: CiFilter & { hasDateRange: boolean },
  timing?: ServerTiming,
): Promise<OtelJobStatsResult> {
  const p = new Params();
  const jobWhere = [
    "span_name = 'buildkite.job'",
    "job_label IS NOT NULL",
    "job_type = 'script'",
    ...spanFilters(p, f),
  ];
  // When no explicit date range, restrict to jobs that started in the last 7d.
  if (!f.hasDateRange) jobWhere.push("start_time >= now64(6) - INTERVAL 7 DAY");
  const jobs = spans("pipeline_slug, build_number, job_label, job_id, job_state, job_passed, job_soft_failed, start_time, duration_ms", jobWhere);
  // Branch lives on the build span, so it filters the joined build (b).
  const builds = buildSpans(p, f, "pipeline_slug, build_number");

  // Both rankings use the same completed jobs, aggregated once.
  // A row is one run of a step: a job, or the shards of a runtime-sharded
  // step in one build (see job-shards.ts). Attempt k of a step is the k-th
  // attempt of each of its jobs; a run fails if any of them failed, and its
  // duration is its slowest job's (shards wait for agents apart, so first
  // start to last finish would count queue time), kept only when every
  // shard ran. coalesce(failed, 2) keeps a NULL outcome out of both counts.
  const statement = `
    WITH jobs AS (
      SELECT
        j.build_number AS build_number,
        ${STEP_NAME} AS name,
        ${SHARD_TOTAL} AS shard_total,
        ${JOB_FAILED} AS failed,
        j.job_soft_failed = 'true' AS soft_failed,
        j.duration_ms AS job_ms,
        row_number() OVER (
          PARTITION BY j.build_number, j.job_label ORDER BY j.start_time, j.job_id
        ) AS attempt
      FROM ${jobs} AS j
      INNER JOIN ${builds} AS b ON ${BUILD_JOIN}
      WHERE ${JOB_COMPLETED}
    ),
    step_runs AS (
      SELECT
        name,
        max(failed) AS run_failed,
        max(soft_failed) AS run_soft_failed,
        if(count() = coalesce(max(shard_total), 1), max(job_ms) / 1000, NULL) AS whole_duration
      FROM jobs
      GROUP BY build_number, name, attempt
    )
    SELECT
      name,
      count() AS total_runs,
      countIf(coalesce(run_failed, 2) = 1) AS failures,
      countIf(coalesce(run_failed, 2) = 0) AS passes,
      toDecimalString(round(toDecimal128(100 * countIf(coalesce(run_failed, 2) = 1), 9) / count(), 1), 1) AS failure_rate,
      max(if(run_soft_failed = 1, 1, 0)) AS has_soft_fail,
      countIf(coalesce(run_failed, 2) = 0 AND whole_duration IS NOT NULL) AS timed_passes,
      toInt32(round(avgIf(whole_duration, coalesce(run_failed, 2) = 0))) AS avg_duration,
      toInt32(round(quantileExactInclusiveIf(0.5)(whole_duration, coalesce(run_failed, 2) = 0))) AS p50_duration,
      toInt32(round(quantileExactInclusiveIf(0.9)(whole_duration, coalesce(run_failed, 2) = 0))) AS p90_duration,
      toInt32(round(maxIf(whole_duration, coalesce(run_failed, 2) = 0))) AS max_duration
    FROM step_runs
    GROUP BY name
  `;

  const query = queryClickHouse<Record<string, unknown>>(statement, p.values);
  const rows = await (timing ? timing.measure("statistics", query) : query);
  return splitOtelJobStats(rows.map(parseOtelJobStatsRow));
}

// ---------------------------------------------------------------------------
// /api/jobs/runs
// ---------------------------------------------------------------------------

export async function queryJobRunsFromOtel(
  f: CiFilter & { jobName: string },
): Promise<Record<string, unknown>[]> {
  const p = new Params();
  const name = p.bind(f.jobName, "String");
  // The job itself, or a runtime shard of the step (see job-shards.ts). LIKE
  // only narrows the scan; the exact comparison decides.
  const jobs = spans(
    "pipeline_slug, build_number, job_id, job_label, job_state, job_passed, start_time, end_time, duration_ms, span_attributes",
    [
      "span_name = 'buildkite.job'",
      "job_type = 'script'",
      `(job_label = ${name} OR (job_label LIKE concat(${name}, ' _hard %')
        AND replaceRegexpOne(job_label, '${SHARD_SUFFIX_SQL}', '') = ${name}))`,
      ...spanFilters(p, f),
    ],
  );
  const builds = buildSpans(p, f, "pipeline_slug, build_number, start_time, span_attributes");

  // One run per build and attempt: a sharded step's shards are one run that
  // links to its first failing shard, else to shard 1. The pick key orders
  // as Postgres's `failed DESC` did: unknown outcome, failed, passed.
  const rows = await queryClickHouse<Record<string, unknown>>(`
    WITH jobs AS (
      SELECT
        j.job_id AS run_job_id,
        j.job_label AS job_label,
        j.build_number AS build_number,
        ${attrText("buildkite.job.web_url", "j.span_attributes")} AS run_web_url,
        ${JOB_STATE_LABEL} AS run_state,
        ${JOB_FAILED} AS failed,
        j.start_time AS job_start,
        j.end_time AS job_end,
        j.duration_ms AS job_ms,
        ${SHARD_TOTAL} AS shard_total,
        ${attrText("buildkite.build.commit", "b.span_attributes")} AS build_commit,
        b.start_time AS build_start,
        row_number() OVER (
          PARTITION BY j.build_number, j.job_label ORDER BY j.start_time, j.job_id
        ) AS attempt
      FROM ${jobs} AS j
      INNER JOIN ${builds} AS b ON ${BUILD_JOIN}
      WHERE ${JOB_COMPLETED}
    )
    SELECT
      argMin((run_job_id, run_web_url, run_state), (multiIf(failed IS NULL, 0, failed = 1, 1, 2), job_label)).1 AS job_id,
      argMin((run_job_id, run_web_url, run_state), (multiIf(failed IS NULL, 0, failed = 1, 1, 2), job_label)).2 AS web_url,
      argMin((run_job_id, run_web_url, run_state), (multiIf(failed IS NULL, 0, failed = 1, 1, 2), job_label)).3 AS state,
      min(job_start) AS started_at,
      max(job_end) AS finished_at,
      toInt32(round(max(job_ms) / 1000)) AS duration_secs,
      count() AS jobs,
      max(shard_total) AS shards,
      max(build_commit) AS commit_sha,
      max(build_start) AS build_created_at
    FROM jobs
    GROUP BY build_number, attempt
    ORDER BY build_created_at ASC, started_at ASC
  `, p.values);
  return rows.map((row) => ({
    ...row,
    duration_secs: toNullableNumber(row.duration_secs),
    jobs: toNumber(row.jobs),
    shards: toNullableNumber(row.shards),
  }));
}

// ---------------------------------------------------------------------------
// /api/queue
// ---------------------------------------------------------------------------

export interface OtelQueueResult {
  queueStats: Record<string, unknown>[];
  dailyWaitTime: Record<string, unknown>[];
  queueNames: string[];
}

function queueTimeBucketSeconds(hourSpan: number): number {
  // Epoch-aligned bucket width over j.start_time, mirroring the adaptive
  // bucketing in the Databricks route. Week-ish ranges use 7-day bins
  // (epoch-aligned, which is fine for a trend chart).
  const minute = 60;
  const hour = 60 * minute;
  if (hourSpan <= 6) return 5 * minute;
  if (hourSpan <= 24) return 15 * minute;
  if (hourSpan <= 3 * 24) return hour;
  if (hourSpan <= 7 * 24) return 3 * hour;
  if (hourSpan <= 14 * 24) return 6 * hour;
  if (hourSpan <= 30 * 24) return 24 * hour;
  return 7 * 24 * hour;
}

/** Queue names in the order Postgres's en_US collation sorted them. */
const collator = new Intl.Collator("en-US");

export async function queryQueueFromOtel(
  f: CiFilter & { queue?: string | null },
): Promise<OtelQueueResult> {
  const p = new Params();

  let hourSpan = 14 * 24;
  if (f.startDate && f.endDate) {
    hourSpan = Math.max(
      1,
      Math.round((new Date(f.endDate).getTime() - new Date(f.startDate).getTime()) / 3600000),
    );
  }
  const stride = p.bind(queueTimeBucketSeconds(hourSpan), "UInt32");

  // The queue route filters by pipeline/queue only (no branch), and job spans
  // carry pipeline_slug + start_time, so there is no build join.
  const where = ["span_name = 'buildkite.job'", "job_type = 'script'", ...spanFilters(p, f)];
  if (f.queue) where.push(`agent_queue = ${p.bind(f.queue, "String")}`);
  const columns = "agent_queue, job_wait_time_ms, start_time";
  const waits = (extra: string[]) => `${spans(columns, [...where, ...extra])} AS j
    WHERE j.agent_queue IS NOT NULL AND j.job_wait_time_ms IS NOT NULL`;
  const recency = f.startDate || f.endDate ? [] : ["start_time >= now64(6) - INTERVAL 7 DAY"];

  const statsPromise = queryClickHouse<Record<string, unknown>>(`
    SELECT
      j.agent_queue AS queue,
      count() AS total_jobs,
      toInt32(round(avg(j.job_wait_time_ms / 1000))) AS avg_wait,
      toInt32(round(quantileExactInclusive(0.5)(j.job_wait_time_ms / 1000))) AS p50_wait,
      toInt32(round(quantileExactInclusive(0.9)(j.job_wait_time_ms / 1000))) AS p90_wait,
      toInt32(round(max(j.job_wait_time_ms / 1000))) AS max_wait
    FROM ${waits(recency)}
    GROUP BY queue
    ORDER BY p50_wait DESC
  `, p.values);

  // The trend has no default recency bound, as in the Postgres version.
  const trendPromise = queryClickHouse<Record<string, unknown>>(`
    SELECT
      toDateTime(intDiv(toUnixTimestamp(j.start_time), ${stride}) * ${stride}, 'UTC') AS time_bucket,
      j.agent_queue AS queue,
      toInt32(round(quantileExactInclusive(0.5)(j.job_wait_time_ms / 1000))) AS p50_wait,
      toInt32(round(quantileExactInclusive(0.9)(j.job_wait_time_ms / 1000))) AS p90_wait,
      count() AS total_jobs
    FROM ${waits([])}
    GROUP BY time_bucket, queue
    ORDER BY time_bucket
  `, p.values);

  const namesPromise = queryClickHouse<{ queue: string }>(`
    SELECT DISTINCT agent_queue AS queue
    FROM ci.otel_spans
    WHERE span_name = 'buildkite.job'
      AND agent_queue IS NOT NULL
      AND start_time > now64(6) - INTERVAL 30 DAY
  `);

  const [queueStats, dailyWaitTime, queueNames] = await Promise.all([
    statsPromise,
    trendPromise,
    namesPromise,
  ]);

  const numbers = (row: Record<string, unknown>, keys: string[]) => ({
    ...row,
    ...Object.fromEntries(keys.map((key) => [key, toNullableNumber(row[key])])),
  });
  return {
    queueStats: queueStats.map((row) => numbers(row, ["total_jobs", "avg_wait", "p50_wait", "p90_wait", "max_wait"])),
    dailyWaitTime: dailyWaitTime.map((row) => numbers(row, ["p50_wait", "p90_wait", "total_jobs"])),
    queueNames: queueNames.map((q) => q.queue).sort(collator.compare),
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

/** Postgres's ROUND(SUM(hours)::numeric, digits): half away from zero. */
function roundedHours(digits: number): string {
  return `round(toDecimal128(sum(j.duration_ms / 3600000), 12), ${digits})`;
}

export async function queryCostFromOtel(f: CiFilter): Promise<OtelCostRaw> {
  const p = new Params();
  // Job-span-only filters. Branch is the only filter that lives on the build
  // span, so byQueue/daily/byJob skip the build join unless a branch filter
  // is requested.
  const jobs = `${spans("pipeline_slug, build_number, job_label, agent_queue, start_time, duration_ms", [
    "span_name = 'buildkite.job'",
    "job_type = 'script'",
    ...spanFilters(p, f),
  ])} AS j`;
  const jobWhere = "WHERE j.agent_queue IS NOT NULL";
  const builds = buildSpans(p, f, "pipeline_slug, build_number, start_time, span_attributes");
  const branchJoin = f.branch ? `INNER JOIN ${builds} AS b ON ${BUILD_JOIN}` : "";

  const byQueuePromise = queryClickHouse<Record<string, unknown>>(`
    SELECT
      j.agent_queue AS queue,
      count() AS total_jobs,
      toDecimalString(${roundedHours(2)}, 2) AS total_hours
    FROM ${jobs}
    ${branchJoin}
    ${jobWhere}
    GROUP BY queue
    ORDER BY ${roundedHours(2)} DESC
  `, p.values);

  const dailyPromise = queryClickHouse<Record<string, unknown>>(`
    SELECT
      toDateTime(toDate(j.start_time), 'UTC') AS date,
      j.agent_queue AS queue,
      toDecimalString(${roundedHours(2)}, 2) AS total_hours
    FROM ${jobs}
    ${branchJoin}
    ${jobWhere}
    GROUP BY date, queue
    ORDER BY date
  `, p.values);

  // byBuild needs build-level attributes (url/message/commit/author), so it
  // always joins to the build span. build_id is NULL on Buildkite spans, so
  // group/identify builds by the (pipeline_slug, build_number) pair.
  const byBuildPromise = queryClickHouse<Record<string, unknown>>(`
    SELECT
      concat(j.pipeline_slug, ':', toString(j.build_number)) AS build_id,
      ${attrText("buildkite.build.web_url", "b.span_attributes")} AS build_url,
      ${attrText("buildkite.build.message", "b.span_attributes")} AS message,
      ${attrText("buildkite.build.commit", "b.span_attributes")} AS commit_sha,
      ${attrText("buildkite.build.branch", "b.span_attributes")} AS branch,
      coalesce(
        ${attrText("buildkite.build.creator.name", "b.span_attributes")},
        ${attrText("buildkite.build.creator.email", "b.span_attributes")}
      ) AS author,
      b.start_time AS created_at,
      count() AS total_jobs,
      toDecimalString(${roundedHours(4)}, 4) AS total_hours
    FROM ${jobs}
    INNER JOIN ${builds} AS b ON ${BUILD_JOIN}
    ${jobWhere}
    GROUP BY j.pipeline_slug, j.build_number, b.span_attributes, b.start_time
    ORDER BY ${roundedHours(4)} DESC
    LIMIT 100
  `, p.values);

  const byJobPromise = queryClickHouse<Record<string, unknown>>(`
    SELECT
      j.job_label AS job_name,
      j.agent_queue AS queue,
      count() AS total_runs,
      toDecimalString(${roundedHours(4)}, 4) AS total_hours
    FROM ${jobs}
    ${branchJoin}
    ${jobWhere}
    GROUP BY job_name, queue
  `, p.values);

  const [byQueue, dailyCost, byBuild, byJob] = await Promise.all([
    byQueuePromise,
    dailyPromise,
    byBuildPromise,
    byJobPromise,
  ]);

  return {
    byQueue: byQueue.map((row) => ({ ...row, total_jobs: toNumber(row.total_jobs) })),
    dailyCost,
    byBuild: await enrichBuildAuthors(
      byBuild.map((row): Record<string, unknown> => ({ ...row, total_jobs: toNumber(row.total_jobs) })),
    ),
    byJob: byJob.map((row) => ({ ...row, total_runs: toNumber(row.total_runs) })),
  };
}
