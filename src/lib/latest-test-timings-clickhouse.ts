import { queryClickHouse } from "@/lib/clickhouse";

// ClickHouse reads for /api/timings/latest over `ci.otel_spans`, the same
// spans as the Postgres table. Each function returns rows shaped exactly like
// its Postgres counterpart in latest-test-timings.ts so the timing math is
// shared. The table is a ReplacingMergeTree, so a retried OTLP export or a
// backfill overlap can leave duplicate rows until a merge. Every read keeps
// one row per (trace_id, span_id), the newest, so no duration is doubled.
// FINAL would do the same but reads the whole job-span range (seconds);
// LIMIT 1 BY dedupes only the rows that pass the filter. Test and command
// spans also filter on span_name, the sort key's first column.

export interface ClickHousePassingBuild {
  build_number: string;
  commit: string | null;
  finished_at: Date;
  job_ids: string[];
  job_ms: number[];
}

type QueryOptions = { timeoutMs?: number };

function settings({ timeoutMs }: QueryOptions): Record<string, string> | undefined {
  if (timeoutMs === undefined) return undefined;
  return {
    max_execution_time: String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    timeout_overflow_mode: "throw",
  };
}

const JOB_SPAN_FILTER = `
    span_name = 'buildkite.job'
    AND job_type = 'script'
    AND pipeline_slug = 'ci'
    AND build_branch = {branch:String}
    AND step_key = {stepKey:String}`;

const DEDUPE = "ORDER BY received_at DESC LIMIT 1 BY trace_id, span_id";

/**
 * Builds of `main` (or the treatment branch) in which every script job of the
 * step finished and passed, newest first, keeping only builds with at least
 * one test span. Mirrors passingBuilds() in latest-test-timings.ts.
 */
export async function clickHousePassingBuilds(
  treatment: boolean,
  stepKey: string,
  days: number | null,
  queue: string | null,
  limit: number,
  options: QueryOptions = {},
): Promise<ClickHousePassingBuild[]> {
  const params: Record<string, string | number> = {
    branch: treatment ? "khluu/otel" : "main",
    stepKey,
  };
  let filters = "";
  if (queue !== null) {
    filters += "\n    AND agent_queue = {queue:String}";
    params.queue = queue;
  }
  if (days !== null) {
    filters += "\n    AND start_time >= now64(6) - toIntervalDay({days:UInt32})";
    params.days = days;
  }
  const rows = await queryClickHouse<{
    build_number: string; commit: string | null; finished_at: string; jobs: string;
  }>(`
    SELECT
      build_number,
      nullIf(max(build_commit), '') AS commit,
      max(end_time) AS finished_at,
      toJSONString(arraySort(x -> x.1, groupArray((job_id, duration_ms)))) AS jobs
    FROM (
      SELECT build_number, build_commit, end_time, job_id, duration_ms, job_state, job_passed
      FROM ci.otel_spans
      WHERE ${JOB_SPAN_FILTER}${filters}
      ${DEDUPE}
    )
    GROUP BY build_number
    HAVING min(job_state = 'finished' AND job_passed = 'true') = 1
    ORDER BY build_number DESC
  `, params, settings(options));

  const builds = rows.map((row) => {
    const jobs = JSON.parse(row.jobs) as [string, number | string][];
    return {
      build_number: row.build_number,
      commit: row.commit,
      finished_at: new Date(row.finished_at),
      job_ids: jobs.map(([jobId]) => jobId),
      job_ms: jobs.map(([, ms]) => Number(ms)),
    };
  });
  if (builds.length === 0) return [];

  // A passing build whose test spans were lost in ingestion is skipped, so the
  // previous build is used instead. Check newest first, in pages, and stop
  // once enough builds have tests.
  const kept: ClickHousePassingBuild[] = [];
  const PAGE = 50;
  for (let offset = 0; offset < builds.length && kept.length < limit; offset += PAGE) {
    const page = builds.slice(offset, offset + PAGE);
    const timed = new Set((await queryClickHouse<{ job_id: string }>(`
      SELECT DISTINCT job_id
      FROM ci.otel_spans
      WHERE span_name = 'pytest.test' AND ci_span_kind = 'test' AND job_id IN {jobIds:Array(String)}
    `, { jobIds: page.flatMap((build) => build.job_ids) }, settings(options)))
      .map((row) => row.job_id));
    for (const build of page) {
      if (build.job_ids.some((jobId) => timed.has(jobId))) kept.push(build);
      if (kept.length === limit) break;
    }
  }
  return kept;
}

export interface ClickHouseTestSpanRow {
  job_id: string;
  command_span_id: string | null;
  command_label: string | null;
  nodeid: string | null;
  outcome: string | null;
  duration_ms: number;
}

export interface ClickHouseCommandSpanRow {
  job_id: string;
  label: string | null;
  duration_ms: number;
}

/** Test spans with their parent command, and the command spans, of jobs. */
export async function clickHouseTimingSpans(
  jobIds: string[],
  options: QueryOptions = {},
): Promise<{ rows: ClickHouseTestSpanRow[]; commands: ClickHouseCommandSpanRow[] }> {
  if (jobIds.length === 0) return { rows: [], commands: [] };
  const [rows, commands] = await Promise.all([
    queryClickHouse<Omit<ClickHouseTestSpanRow, "duration_ms"> & { duration_ms: string }>(`
      SELECT
        t.job_id AS job_id,
        t.duration_ms AS duration_ms,
        nullIf(JSONExtractString(t.span_attributes, 'test.nodeid'), '') AS nodeid,
        nullIf(JSONExtractString(t.span_attributes, 'test.outcome'), '') AS outcome,
        c.span_id AS command_span_id,
        c.label AS command_label
      FROM (
        SELECT trace_id, parent_span_id, job_id, duration_ms, span_attributes, start_time, span_id
        FROM ci.otel_spans
        WHERE span_name = 'pytest.test' AND ci_span_kind = 'test' AND job_id IN {jobIds:Array(String)}
        ${DEDUPE}
      ) AS t
      LEFT JOIN (
        SELECT trace_id, span_id,
          nullIf(JSONExtractString(span_attributes, 'ci.command.label'), '') AS label
        FROM ci.otel_spans
        WHERE span_name = 'ci.command' AND ci_span_kind = 'command' AND job_id IN {jobIds:Array(String)}
        ${DEDUPE}
      ) AS c
        ON c.trace_id = t.trace_id AND c.span_id = t.parent_span_id
      -- Run order, as Postgres returns them; a file's tests keep first-seen order.
      ORDER BY t.start_time, t.span_id
      SETTINGS join_use_nulls = 1
    `, { jobIds }, settings(options)),
    queryClickHouse<{ job_id: string; label: string | null; duration_ms: string }>(`
      SELECT job_id, duration_ms,
        nullIf(JSONExtractString(span_attributes, 'ci.command.label'), '') AS label
      FROM ci.otel_spans
      WHERE span_name = 'ci.command' AND ci_span_kind = 'command' AND job_id IN {jobIds:Array(String)}
      ${DEDUPE}
    `, { jobIds }, settings(options)),
  ]);
  return {
    rows: rows.map((row) => ({ ...row, duration_ms: Number(row.duration_ms) })),
    commands: commands.map((row) => ({ ...row, duration_ms: Number(row.duration_ms) })),
  };
}

/** Whether main has ever recorded a test span for the step (any build/queue). */
export async function clickHouseMainEverTimed(
  stepKey: string,
  options: QueryOptions = {},
): Promise<boolean> {
  const [row] = await queryClickHouse<{ timed: string }>(`
    SELECT count() > 0 AS timed
    FROM ci.otel_spans
    WHERE span_name = 'pytest.test' AND ci_span_kind = 'test'
      AND job_id IN (SELECT job_id FROM ci.otel_spans WHERE ${JOB_SPAN_FILTER})
    LIMIT 1
  `, { branch: "main", stepKey }, settings(options));
  return row?.timed === "true" || row?.timed === "1";
}
