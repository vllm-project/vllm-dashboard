import { getDb } from "@/lib/db";
import { queryDatabricks } from "@/lib/databricks";

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

/** Ranking and drilldown share selection, deduplication, and retry classification. */
function buildOtelRetryAttempts(filters: RetryFilters, jobName?: string) {
  const parameters: string[] = [];
  const bind = (value: string) => `$${parameters.push(value)}`;
  const conditions = [
    "j.span_name = 'buildkite.job'",
    "j.job_type = 'script'",
    "j.job_id IS NOT NULL",
    "j.job_label IS NOT NULL",
  ];
  if (filters.pipeline) {
    const slug = filters.pipeline.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    conditions.push(`j.pipeline_slug = ${bind(slug)}`);
  }
  if (filters.branch) {
    // Buildkite exports branch on job spans too. Older records may need their
    // build span; a scalar lookup avoids multiplying jobs by duplicate spans.
    conditions.push(`COALESCE(j.span_attributes->>'buildkite.build.branch', (
      SELECT b.span_attributes->>'buildkite.build.branch'
      FROM otel_spans b
      WHERE b.span_name = 'buildkite.build'
        AND b.pipeline_slug = j.pipeline_slug AND b.build_number = j.build_number
        AND b.organization_slug IS NOT DISTINCT FROM j.organization_slug
      ORDER BY b.received_at DESC LIMIT 1
    )) = ${bind(filters.branch)}`);
  }
  if (filters.startTime) conditions.push(`j.start_time >= ${bind(filters.startTime)}::timestamptz`);
  if (filters.endTime) conditions.push(`j.start_time < ${bind(filters.endTime)}::timestamptz`);
  if (jobName !== undefined) conditions.push(`j.job_label = ${bind(jobName)}`);
  return {
    parameters,
    statement: `
      WITH selected_attempts AS (
        SELECT DISTINCT ON (j.job_id)
          j.job_id, j.job_label AS name, j.organization_slug, j.pipeline_slug, j.build_number,
          j.span_attributes->>'buildkite.job.retries_count' AS retries_count,
          NULLIF(j.span_attributes->>'buildkite.job.retry_source.job_id', '') AS retry_source,
          j.job_soft_failed = 'true' AS has_soft_fail
          ${jobName === undefined ? "" : `, j.span_attributes,
          j.start_time AS started_at, j.end_time AS finished_at,
          ROUND(j.duration_ms / 1000.0)::int AS duration_secs,
          CASE WHEN j.job_state = 'finished' AND j.job_passed = 'true' THEN 'passed'
            WHEN j.job_state = 'finished' THEN 'failed'
            ELSE COALESCE(j.job_state, 'unknown') END AS state`}
        FROM otel_spans j
        WHERE ${conditions.join("\n          AND ")}
        ORDER BY j.job_id, j.received_at DESC
      ), legacy_builds AS (
        SELECT DISTINCT organization_slug, pipeline_slug, build_number
        FROM selected_attempts
        WHERE NOT COALESCE(retries_count ~ '^[0-9]+$', false)
          AND retry_source IS NULL
      ), legacy_retry_targets AS MATERIALIZED (
        -- Older spans expose only a link to the next attempt. Read those
        -- links once per selected build, including predecessors before the
        -- time window, rather than rescanning a build for every job/shard.
        -- Split nullable organization IDs so each branch can use the full
        -- (organization_slug, pipeline_slug, build_number) index prefix.
        SELECT previous.span_attributes->>'buildkite.job.retried_in_job_id' AS job_id
        FROM legacy_builds legacy
        INNER JOIN otel_spans previous
          ON previous.organization_slug = legacy.organization_slug
          AND previous.pipeline_slug = legacy.pipeline_slug
          AND previous.build_number = legacy.build_number
        WHERE previous.span_name = 'buildkite.job' AND previous.job_type = 'script'
          AND NULLIF(previous.span_attributes->>'buildkite.job.retried_in_job_id', '') IS NOT NULL
        UNION
        SELECT previous.span_attributes->>'buildkite.job.retried_in_job_id' AS job_id
        FROM legacy_builds legacy
        INNER JOIN otel_spans previous
          ON previous.organization_slug IS NULL
          AND previous.pipeline_slug = legacy.pipeline_slug
          AND previous.build_number = legacy.build_number
        WHERE legacy.organization_slug IS NULL
          AND previous.span_name = 'buildkite.job' AND previous.job_type = 'script'
          AND NULLIF(previous.span_attributes->>'buildkite.job.retried_in_job_id', '') IS NOT NULL
      ), attempts AS (
        SELECT a.*, (
          COALESCE(a.retries_count ~ '^0*[1-9][0-9]*$', false)
          OR a.retry_source IS NOT NULL
          OR (NOT COALESCE(a.retries_count ~ '^[0-9]+$', false) AND legacy.job_id IS NOT NULL)
        ) AS is_retry
        FROM selected_attempts a
        LEFT JOIN legacy_retry_targets legacy ON legacy.job_id = a.job_id
      )`,
  };
}

/** Parameterized SQL is exported so the actual queries can be exercised locally. */
export function buildOtelRetryQuery(filters: RetryFilters) {
  const query = buildOtelRetryAttempts(filters);
  return { ...query, statement: `${query.statement}
      SELECT name, COUNT(*)::int AS total_runs,
        COUNT(*) FILTER (WHERE is_retry)::int AS retries,
        COALESCE(BOOL_OR(has_soft_fail), false) AS has_soft_fail
      FROM attempts
      GROUP BY name
    `,
  };
}

export function buildOtelRetryRunsQuery(filters: RetryFilters, jobName: string) {
  const query = buildOtelRetryAttempts(filters, jobName);
  return { ...query, statement: `${query.statement}
      SELECT a.job_id,
        COALESCE(NULLIF(a.span_attributes->>'buildkite.job.web_url', ''),
          CASE WHEN a.organization_slug IS NOT NULL AND a.pipeline_slug IS NOT NULL AND a.build_number IS NOT NULL
            THEN 'https://buildkite.com/' || a.organization_slug || '/' || a.pipeline_slug || '/builds/' || a.build_number || '#' || a.job_id
            ELSE NULL END) AS web_url,
        a.state, a.started_at, a.finished_at, a.duration_secs,
        COALESCE(NULLIF(a.span_attributes->>'buildkite.build.commit', ''), build.commit_sha) AS commit_sha,
        build.build_created_at, a.build_number, a.is_retry
      FROM attempts a
      LEFT JOIN LATERAL (
        SELECT b.span_attributes->>'buildkite.build.commit' AS commit_sha, b.start_time AS build_created_at
        FROM otel_spans b
        WHERE b.span_name = 'buildkite.build'
          AND b.pipeline_slug = a.pipeline_slug AND b.build_number = a.build_number
          AND b.organization_slug IS NOT DISTINCT FROM a.organization_slug
        ORDER BY b.received_at DESC LIMIT 1
      ) build ON true
      ORDER BY a.started_at ASC, a.job_id ASC
    ` };
}

function buildWarehouseRetryAttempts(filters: RetryFilters, jobName?: string) {
  const parameters: { name: string; value: string; type: string }[] = [];
  const bind = (name: string, value: string) => {
    parameters.push({ name, value, type: "STRING" });
    return `:${name}`;
  };
  const conditions = [
    "j._fivetran_deleted = false", "b._fivetran_deleted = false",
    "j.type = 'script'", "j.name IS NOT NULL", "j.started_at IS NOT NULL",
  ];
  if (filters.pipeline) conditions.push(`p.name = ${bind("pipeline", filters.pipeline)}`);
  if (filters.branch) conditions.push(`b.branch = ${bind("branch", filters.branch)}`);
  if (filters.startTime) conditions.push(`j.started_at >= CAST(${bind("startTime", filters.startTime)} AS TIMESTAMP)`);
  if (filters.endTime) conditions.push(`j.started_at < CAST(${bind("endTime", filters.endTime)} AS TIMESTAMP)`);
  if (jobName !== undefined) conditions.push(`j.name = ${bind("jobName", jobName)}`);
  return {
    parameters,
    // retries_count is an ordinal (0, 1, 2...), so count each retry UUID once;
    // summing ordinals overcounts a chain. State never determines retry status.
    statement: `
      WITH attempts AS (
        SELECT j.id, j.name,
          MAX(CASE WHEN COALESCE(j.retries_count, 0) > 0
            OR NULLIF(j.retry_source_job_id, '') IS NOT NULL THEN 1 ELSE 0 END) AS is_retry,
          MAX(CASE WHEN j.soft_failed = 'true' THEN 1 ELSE 0 END) AS has_soft_fail
          ${jobName === undefined ? "" : `, MAX(j.web_url) AS web_url,
          COALESCE(MAX(j.state), 'unknown') AS state, MAX(j.started_at) AS started_at,
          MAX(j.finished_at) AS finished_at, MAX(b.commit) AS commit_sha,
          MAX(b.created_at) AS build_created_at, MAX(b.number) AS build_number`}
        FROM vllm_data_warehouse.buildkite.build_job j
        INNER JOIN vllm_data_warehouse.buildkite.build b ON j.build_id = b.id
        INNER JOIN vllm_data_warehouse.buildkite.pipeline p ON b.pipeline_id = p.id
        WHERE ${conditions.join("\n          AND ")}
        GROUP BY j.id, j.name
      )`,
  };
}

export function buildWarehouseRetryQuery(filters: RetryFilters) {
  const query = buildWarehouseRetryAttempts(filters);
  return { ...query, statement: `${query.statement}
      SELECT name, COUNT(*) AS total_runs, SUM(is_retry) AS retries,
        MAX(has_soft_fail) AS has_soft_fail
      FROM attempts
      GROUP BY name
    `,
  };
}

export function buildWarehouseRetryRunsQuery(filters: RetryFilters, jobName: string) {
  const query = buildWarehouseRetryAttempts(filters, jobName);
  return { ...query, statement: `${query.statement}
      SELECT id AS job_id, web_url, state, started_at, finished_at,
        TIMESTAMPDIFF(SECOND, started_at, finished_at) AS duration_secs,
        commit_sha, build_created_at, build_number, is_retry
      FROM attempts
      ORDER BY started_at ASC, job_id ASC
    ` };
}

export async function queryRetriesFromOtel(filters: RetryFilters): Promise<RetryStatsRow[]> {
  const { statement, parameters } = buildOtelRetryQuery(filters);
  return getDb().unsafe<RetryStatsRow[]>(statement, parameters);
}

export async function queryRetriesFromWarehouse(filters: RetryFilters): Promise<RetryStatsRow[]> {
  const { statement, parameters } = buildWarehouseRetryQuery(filters);
  return queryDatabricks<RetryStatsRow>(statement, parameters);
}

export async function queryRetryRunsFromOtel(filters: RetryFilters, jobName: string): Promise<RetryJobRun[]> {
  const { statement, parameters } = buildOtelRetryRunsQuery(filters, jobName);
  return getDb().unsafe<RetryJobRun[]>(statement, parameters);
}

export async function queryRetryRunsFromWarehouse(filters: RetryFilters, jobName: string): Promise<RetryJobRun[]> {
  const { statement, parameters } = buildWarehouseRetryRunsQuery(filters, jobName);
  const rows = await queryDatabricks<Omit<RetryJobRun, "is_retry"> & { is_retry: number | string }>(statement, parameters);
  return rows.map((row) => ({ ...row, is_retry: row.is_retry === 1 || row.is_retry === "1" }));
}
