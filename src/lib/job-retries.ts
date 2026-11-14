import { queryClickHouse } from "@/lib/clickhouse";
import { attrText } from "@/lib/otel-clickhouse";
import { SHARD_SUFFIX_SQL } from "@/lib/job-shards";

export interface RetryJobRow {
  name: string;
  retries: number;
  total_runs: number;
  has_soft_fail: boolean;
}

export interface RetryStatsRow {
  name: string;
  retries: number | string;
  total_runs: number | string;
  has_soft_fail: boolean | number | string | null;
}

export interface RetryJobRun {
  job_id: string;
  web_url: string | null;
  state: string;
  started_at: string;
  finished_at: string | null;
  duration_secs: number | string | null;
  commit_sha: string | null;
  build_created_at?: string | null;
  build_number: number | string | null;
  is_retry: boolean;
}

export interface RetryFilters {
  pipeline: string;
  branch: string;
  startTime: string | null;
  endTime: string | null;
  rangeKey: string;
}

export class RetryFilterError extends Error {}

function parseDate(value: string, end: boolean): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  if (!dateOnly && !timestamp) {
    throw new RetryFilterError("Dates must be YYYY-MM-DD or an ISO timestamp with a timezone.");
  }
  // Date.parse normalizes impossible dates such as February 30; reject them.
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  const date = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(calendar.getTime()) ||
      calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new RetryFilterError("Invalid date range.");
  }
  // Calendar end dates include the whole UTC day. Timestamp ends are exact,
  // exclusive instants so hour presets do not silently gain another day.
  if (dateOnly && end) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

export function parseRetryFilters(params: URLSearchParams, now = new Date()): RetryFilters {
  const startDate = params.get("startDate") || null;
  const endDate = params.get("endDate") || null;
  let startTime = startDate ? parseDate(startDate, false) : null;
  let endTime = endDate ? parseDate(endDate, true) : null;
  let rangeKey = JSON.stringify([startTime, endTime]);
  const window = params.get("window");
  if (!startDate && !endDate && window !== null) {
    const match = /^(\d{1,3})d$/.exec(window);
    const days = match ? Number(match[1]) : 0;
    if (days < 1 || days > 90) {
      throw new RetryFilterError("Window must be between 1d and 90d.");
    }
    // Match the Jobs page's calendar-day default, with a stable cache key.
    const end = new Date(now.toISOString().slice(0, 10));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - days);
    end.setUTCDate(end.getUTCDate() + 1);
    startTime = start.toISOString();
    endTime = end.toISOString();
    rangeKey = `window:${days}d`;
  }
  if (startTime && endTime && startTime >= endTime) {
    throw new RetryFilterError("Start date must be before the end of the selected range.");
  }
  return {
    pipeline: params.get("pipeline") ?? "CI",
    branch: params.get("branch") ?? "main",
    startTime,
    endTime,
    rangeKey,
  };
}

export function rankRetryJobs(rows: RetryStatsRow[]): RetryJobRow[] {
  return rows.map((row) => ({
    name: row.name,
    retries: Number(row.retries),
    total_runs: Number(row.total_runs),
    has_soft_fail: row.has_soft_fail === true || row.has_soft_fail === 1 ||
      row.has_soft_fail === "1" || row.has_soft_fail === "true",
  })).sort((a, b) => b.retries - a.retries || a.name.localeCompare(b.name));
}

/**
 * Ranking and drilldown share selection, deduplication, and retry
 * classification. These read ClickHouse `ci.otel_spans`, the spans the
 * Postgres `otel_spans` table held, and keep its semantics: one attempt per
 * job UUID (the newest received span), with the same retry rules.
 */
function buildOtelRetryAttempts(filters: RetryFilters, jobName?: string) {
  const parameters: Record<string, string> = {};
  const bind = (name: string, value: string) => {
    parameters[name] = value;
    return `{${name}:String}`;
  };
  const conditions = [
    "j.span_name = 'buildkite.job'",
    "j.job_type = 'script'",
    "j.job_id IS NOT NULL",
    "j.job_label IS NOT NULL",
  ];
  let pipeline = "";
  if (filters.pipeline) {
    const slug = filters.pipeline.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    pipeline = bind("pipeline", slug);
    conditions.push(`j.pipeline_slug = ${pipeline}`);
  }
  // The newest build span of each build, for attributes a job span lacks.
  const latestBuild = (columns: string) => `(
        SELECT organization_slug, pipeline_slug, build_number, ${columns}
        FROM ci.otel_spans
        WHERE span_name = 'buildkite.build'${pipeline ? ` AND pipeline_slug = ${pipeline}` : ""}
        GROUP BY organization_slug, pipeline_slug, build_number
      )`;
  // organization_slug is nullable: match NULL to NULL, as IS NOT DISTINCT FROM.
  const sameBuild = (build: string, job: string) => `${build}.pipeline_slug = ${job}.pipeline_slug
        AND ${build}.build_number = ${job}.build_number
        AND isNotDistinctFrom(${build}.organization_slug, ${job}.organization_slug)`;
  let branchJoin = "";
  if (filters.branch) {
    // Buildkite exports branch on job spans too. Older records may need their
    // build span; one row per build avoids multiplying jobs by duplicates.
    branchJoin = `
      LEFT JOIN ${latestBuild(`argMax(tuple(${attrText("buildkite.build.branch")}), received_at).1 AS branch`)} AS bb
        ON ${sameBuild("bb", "j")}`;
    // build_branch is the materialized attribute ('' when absent).
    conditions.push(`coalesce(nullIf(j.build_branch, ''), bb.branch) = ${bind("branch", filters.branch)}`);
  }
  if (filters.startTime) {
    conditions.push(`j.start_time >= parseDateTime64BestEffort(${bind("startTime", filters.startTime)}, 6, 'UTC')`);
  }
  if (filters.endTime) {
    conditions.push(`j.start_time < parseDateTime64BestEffort(${bind("endTime", filters.endTime)}, 6, 'UTC')`);
  }
  if (jobName !== undefined) {
    // The job, or a runtime shard of the step (see job-shards.ts).
    const name = bind("jobName", jobName);
    conditions.push(`(j.job_label = ${name} OR (j.job_label LIKE concat(${name}, ' _hard %')
      AND replaceRegexpOne(j.job_label, '${SHARD_SUFFIX_SQL}', '') = ${name}))`);
  }
  const retriesCount = "a.retries_count";
  return {
    parameters,
    latestBuild,
    sameBuild,
    statement: `
      WITH selected_attempts AS (
        SELECT
          j.job_id AS job_id, replaceRegexpOne(j.job_label, '${SHARD_SUFFIX_SQL}', '') AS name,
          j.organization_slug AS organization_slug, j.pipeline_slug AS pipeline_slug,
          j.build_number AS build_number,
          ${attrText("buildkite.job.retries_count", "j.span_attributes")} AS retries_count,
          ${attrText("buildkite.job.retry_source.job_id", "j.span_attributes")} AS retry_source,
          j.job_soft_failed = 'true' AS has_soft_fail
          ${jobName === undefined ? "" : `, j.span_attributes AS span_attributes,
          j.start_time AS started_at, j.end_time AS finished_at,
          toInt32(round(j.duration_ms / 1000)) AS duration_secs,
          CASE WHEN j.job_state = 'finished' AND j.job_passed = 'true' THEN 'passed'
            WHEN j.job_state = 'finished' THEN 'failed'
            ELSE coalesce(j.job_state, 'unknown') END AS state`}
        FROM ci.otel_spans AS j${branchJoin}
        WHERE ${conditions.join("\n          AND ")}
        ORDER BY j.received_at DESC
        LIMIT 1 BY j.job_id
      ), legacy_retry_targets AS (
        -- Older spans expose only a link to the next attempt. Read those links
        -- straight from job spans: job ids are globally unique, so no build
        -- join is needed. Predecessors may start before the window; retries
        -- of one build happen within hours, so a two-day margin covers them.
        SELECT DISTINCT ${attrText("buildkite.job.retried_in_job_id", "previous.span_attributes")} AS target_job_id
        FROM ci.otel_spans AS previous
        WHERE previous.span_name = 'buildkite.job' AND previous.job_type = 'script'${pipeline ? `
          AND previous.pipeline_slug = ${pipeline}` : ""}${filters.startTime ? `
          AND previous.start_time >= parseDateTime64BestEffort({startTime:String}, 6, 'UTC') - INTERVAL 2 DAY` : ""}${filters.endTime ? `
          AND previous.start_time < parseDateTime64BestEffort({endTime:String}, 6, 'UTC')` : ""}
          AND ${attrText("buildkite.job.retried_in_job_id", "previous.span_attributes")} IS NOT NULL
      ), attempts AS (
        SELECT a.*, (
          coalesce(match(${retriesCount}, '^0*[1-9][0-9]*$'), 0)
          OR a.retry_source IS NOT NULL
          OR (NOT coalesce(match(${retriesCount}, '^[0-9]+$'), 0) AND legacy.target_job_id IS NOT NULL)
        ) AS is_retry
        FROM selected_attempts AS a
        LEFT JOIN legacy_retry_targets AS legacy ON legacy.target_job_id = a.job_id
      )`,
  };
}

// Plain CTEs: ClickHouse inlines each reference. Materialized CTEs would scan
// the selected job spans once, but enable_materialized_cte is experimental in
// ClickHouse 26.x, and this path only serves ?source=otel.
const SETTINGS = "join_use_nulls = 1";

/** Parameterized SQL is exported so the actual queries can be exercised locally. */
export function buildOtelRetryQuery(filters: RetryFilters) {
  const { parameters, statement } = buildOtelRetryAttempts(filters);
  return { parameters, statement: `${statement}
      SELECT name, count() AS total_runs,
        countIf(is_retry) AS retries,
        coalesce(max(has_soft_fail), 0) AS has_soft_fail
      FROM attempts
      GROUP BY name
      SETTINGS ${SETTINGS}
    `,
  };
}

export function buildOtelRetryRunsQuery(filters: RetryFilters, jobName: string) {
  const { parameters, statement, latestBuild, sameBuild } = buildOtelRetryAttempts(filters, jobName);
  const latest = (expr: string) => `argMax(tuple(${expr}), received_at).1`;
  return { parameters, statement: `${statement}
      SELECT a.job_id AS job_id,
        coalesce(${attrText("buildkite.job.web_url", "a.span_attributes")},
          if(a.organization_slug IS NOT NULL AND a.pipeline_slug IS NOT NULL AND a.build_number IS NOT NULL,
            concat('https://buildkite.com/', a.organization_slug, '/', a.pipeline_slug, '/builds/',
              toString(a.build_number), '#', a.job_id),
            NULL)) AS web_url,
        a.state AS state, a.started_at AS started_at, a.finished_at AS finished_at,
        a.duration_secs AS duration_secs,
        coalesce(${attrText("buildkite.build.commit", "a.span_attributes")}, build.commit_sha) AS commit_sha,
        build.build_created_at AS build_created_at, a.build_number AS build_number, a.is_retry AS is_retry
      FROM attempts AS a
      LEFT JOIN ${latestBuild(`${latest(attrText("buildkite.build.commit"))} AS commit_sha,
          ${latest("start_time")} AS build_created_at`)} AS build
        ON ${sameBuild("build", "a")}
      ORDER BY started_at ASC, job_id ASC
      SETTINGS ${SETTINGS}
    ` };
}

/** How long before a window's start a build can still have jobs start in it. */
const BUILD_LOOKBACK_DAYS = 30;

function buildWarehouseRetryAttempts(filters: RetryFilters, jobName?: string) {
  const parameters: Record<string, string> = {};
  const bind = (name: string, value: string) => {
    parameters[name] = value;
    return `{${name}:String}`;
  };
  const buildConditions = ["NOT _fivetran_deleted"];
  if (filters.pipeline) {
    buildConditions.push(`pipeline_id IN (SELECT id FROM buildkite.pipeline FINAL
            WHERE NOT _fivetran_deleted AND name = ${bind("pipeline", filters.pipeline)})`);
  }
  if (filters.branch) buildConditions.push(`branch = ${bind("branch", filters.branch)}`);
  const conditions = [
    "j.build_id IN (SELECT id FROM builds)", "NOT j._fivetran_deleted",
    "j.type = 'script'", "j.name IS NOT NULL", "j.started_at IS NOT NULL",
  ];
  if (filters.startTime) {
    const start = `parseDateTime64BestEffort(${bind("startTime", filters.startTime)}, 3, 'UTC')`;
    conditions.push(`j.started_at >= ${start}`);
    // Prune builds, which jobs start within hours of (a day at most in
    // practice), without scanning every older build's jobs.
    buildConditions.push(`created_at >= ${start} - INTERVAL ${BUILD_LOOKBACK_DAYS} DAY`);
  }
  if (filters.endTime) {
    const end = `parseDateTime64BestEffort(${bind("endTime", filters.endTime)}, 3, 'UTC')`;
    conditions.push(`j.started_at < ${end}`);
    // A job starts after its build is created, so this only prunes builds.
    buildConditions.push(`created_at < ${end}`);
  }
  if (jobName !== undefined) {
    // The job, or a runtime shard of the step (see job-shards.ts).
    const name = bind("jobName", jobName);
    conditions.push(`(j.name = ${name} OR (j.name LIKE concat(${name}, ' _hard %')
      AND replaceRegexpOne(j.name, '${SHARD_SUFFIX_SQL}', '') = ${name}))`);
  }
  return {
    parameters,
    // retries_count is an ordinal (0, 1, 2...), so count each retry UUID once;
    // summing ordinals overcounts a chain. State never determines retry status.
    // Builds are filtered first: build_job is sorted by build_id, so the IN
    // list prunes it before FINAL deduplicates the Fivetran versions.
    statement: `
      WITH builds AS (
        SELECT id, number, commit, created_at
        FROM buildkite.build FINAL
        WHERE ${buildConditions.join("\n          AND ")}
      ),
      attempts AS (
        SELECT j.id AS id, replaceRegexpOne(j.name, '${SHARD_SUFFIX_SQL}', '') AS name,
          max(if(coalesce(j.retries_count, 0) > 0
            OR nullIf(j.retry_source_job_id, '') IS NOT NULL, 1, 0)) AS is_retry,
          max(if(coalesce(j.soft_failed, false), 1, 0)) AS has_soft_fail
          ${jobName === undefined ? "" : `, max(j.web_url) AS web_url,
          coalesce(max(j.state), 'unknown') AS state, max(j.started_at) AS started_at,
          max(j.finished_at) AS finished_at, max(b.commit) AS commit_sha,
          max(b.created_at) AS build_created_at, max(b.number) AS build_number`}
        FROM buildkite.build_job AS j FINAL
        INNER JOIN builds AS b ON j.build_id = b.id
        WHERE ${conditions.join("\n          AND ")}
        GROUP BY j.id, j.name
      )`,
  };
}

export function buildWarehouseRetryQuery(filters: RetryFilters) {
  const query = buildWarehouseRetryAttempts(filters);
  return { ...query, statement: `${query.statement}
      SELECT name, count() AS total_runs, sum(is_retry) AS retries,
        max(has_soft_fail) AS has_soft_fail
      FROM attempts
      GROUP BY name
    `,
  };
}

export function buildWarehouseRetryRunsQuery(filters: RetryFilters, jobName: string) {
  const query = buildWarehouseRetryAttempts(filters, jobName);
  return { ...query, statement: `${query.statement}
      SELECT id AS job_id, web_url, state, started_at, finished_at,
        intDiv(toUnixTimestamp64Milli(finished_at) - toUnixTimestamp64Milli(started_at), 1000) AS duration_secs,
        commit_sha, build_created_at, build_number, is_retry
      FROM attempts
      ORDER BY started_at ASC, job_id ASC
    ` };
}

export async function queryRetriesFromOtel(filters: RetryFilters): Promise<RetryStatsRow[]> {
  const { statement, parameters } = buildOtelRetryQuery(filters);
  return queryClickHouse<RetryStatsRow>(statement, parameters);
}

export async function queryRetriesFromWarehouse(filters: RetryFilters): Promise<RetryStatsRow[]> {
  const { statement, parameters } = buildWarehouseRetryQuery(filters);
  return queryClickHouse<RetryStatsRow>(statement, parameters);
}

export async function queryRetryRunsFromOtel(filters: RetryFilters, jobName: string): Promise<RetryJobRun[]> {
  const { statement, parameters } = buildOtelRetryRunsQuery(filters, jobName);
  const rows = await queryClickHouse<Omit<RetryJobRun, "is_retry"> & { is_retry: number | string }>(statement, parameters);
  return rows.map((row) => ({
    ...row,
    duration_secs: row.duration_secs === null ? null : Number(row.duration_secs),
    is_retry: row.is_retry === 1 || row.is_retry === "1" || row.is_retry === "true",
  }));
}

export async function queryRetryRunsFromWarehouse(filters: RetryFilters, jobName: string): Promise<RetryJobRun[]> {
  const { statement, parameters } = buildWarehouseRetryRunsQuery(filters, jobName);
  const rows = await queryClickHouse<Omit<RetryJobRun, "is_retry"> & { is_retry: number | string }>(statement, parameters);
  return rows.map((row) => ({ ...row, is_retry: row.is_retry === 1 || row.is_retry === "1" }));
}
