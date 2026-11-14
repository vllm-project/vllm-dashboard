import { queryClickHouse } from "@/lib/clickhouse";
import { attrText, DEDUPE_SPANS, toDate, toNullableNumber, toNumber } from "@/lib/otel-clickhouse";

// ClickHouse reads for /api/builds/trace. Row shapes match what the route
// used to get from Postgres (Dates, numbers, nulls).

export type TraceRow = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  span_name: string;
  start_time: Date;
  end_time: Date;
  duration_ms: number;
  status_code: number;
  step_key: string | null;
  job_id: string | null;
  job_label: string | null;
  job_state: string | null;
  agent_queue: string | null;
  step_label: string | null;
  group_label: string | null;
  step_outcome: string | null;
  job_passed: string | null;
  job_url: string | null;
  step_url: string | null;
  wait_ms: number | null;
  ci_kind: string | null;
  command_index: number | null;
  command_label: string | null;
  test_nodeid: string | null;
  test_outcome: string | null;
  received_at: Date;
};

export type BuildRef = { organization: string; pipeline: string; buildNumber: string };

const BUILD_FILTER = `organization_slug = {organization:String}
        AND pipeline_slug = {pipeline:String}
        AND build_number = {buildNumber:Int64}`;

function buildParams(build: BuildRef, jobId: string | null) {
  return {
    organization: build.organization,
    pipeline: build.pipeline,
    buildNumber: build.buildNumber,
    ...(jobId === null ? {} : { jobId }),
  };
}

/** One page of a build's job/step/command spans, or of one job's spans. */
export async function traceRows(
  build: BuildRef,
  jobId: string | null,
  limit: number,
  offset: number,
): Promise<TraceRow[]> {
  const scope = jobId === null
    ? `(span_name IN ('buildkite.build', 'buildkite.job', 'buildkite.step')
          OR (span_name = 'ci.command' AND ci_span_kind = 'command'))`
    : `job_id = {jobId:String} AND span_name != 'ci.gpu.samples'`;
  const rows = await queryClickHouse<Record<string, string | null>>(`
    SELECT
      trace_id, span_id, parent_span_id, span_name, start_time, end_time,
      duration_ms, status_code, step_key, job_id, job_label, job_state,
      agent_queue, step_label, group_label, step_outcome, job_passed, job_url,
      step_url, wait_ms, ci_kind, command_index, command_label, test_nodeid,
      test_outcome, received_at
    FROM (
      SELECT
        trace_id, span_id, parent_span_id, span_name, start_time, end_time,
        duration_ms, status_code, step_key, job_id, job_label, job_state,
        agent_queue,
        ${attrText("buildkite.step.label")} AS step_label,
        ${attrText("buildkite.step.group.label")} AS group_label,
        ${attrText("buildkite.step.outcome")} AS step_outcome,
        ${attrText("buildkite.job.passed")} AS job_passed,
        ${attrText("buildkite.job.web_url")} AS job_url,
        ${attrText("buildkite.step.web_url")} AS step_url,
        if(match(ifNull(${attrText("buildkite.job.wait_time_ms")}, ''), '^\\d+(\\.\\d+)?$'),
          toFloat64(${attrText("buildkite.job.wait_time_ms")}), 0) AS wait_ms,
        nullIf(ci_span_kind, '') AS ci_kind,
        if(match(ifNull(${attrText("ci.command.index")}, ''), '^\\d+$'),
          toInt64OrNull(${attrText("ci.command.index")}), NULL) AS command_index,
        ${attrText("ci.command.label")} AS command_label,
        ${attrText("test.nodeid")} AS test_nodeid,
        ${attrText("test.outcome")} AS test_outcome,
        received_at
      FROM ci.otel_spans
      WHERE ${BUILD_FILTER}
        AND ${scope}
      ${DEDUPE_SPANS}
    )
    ORDER BY start_time ASC, duration_ms DESC, span_id ASC
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
  `, { ...buildParams(build, jobId), limit, offset });

  return rows.map((row) => ({
    trace_id: row.trace_id as string,
    span_id: row.span_id as string,
    parent_span_id: row.parent_span_id,
    span_name: row.span_name as string,
    start_time: toDate(row.start_time),
    end_time: toDate(row.end_time),
    duration_ms: toNumber(row.duration_ms),
    status_code: toNumber(row.status_code),
    step_key: row.step_key,
    job_id: row.job_id,
    job_label: row.job_label,
    job_state: row.job_state,
    agent_queue: row.agent_queue,
    step_label: row.step_label,
    group_label: row.group_label,
    step_outcome: row.step_outcome,
    job_passed: row.job_passed,
    job_url: row.job_url,
    step_url: row.step_url,
    wait_ms: toNullableNumber(row.wait_ms),
    ci_kind: row.ci_kind,
    command_index: toNullableNumber(row.command_index),
    command_label: row.command_label,
    test_nodeid: row.test_nodeid,
    test_outcome: row.test_outcome,
    received_at: toDate(row.received_at),
  }));
}

/** Number of test spans under each parent (command) span. */
export async function testCountsByParent(
  build: BuildRef,
  jobId: string | null,
): Promise<{ parent_span_id: string; child_count: number }[]> {
  const rows = await queryClickHouse<{ parent_span_id: string; child_count: string }>(`
    SELECT parent_span_id, uniqExact(trace_id, span_id) AS child_count
    FROM ci.otel_spans
    WHERE ${BUILD_FILTER}
      AND span_name = 'pytest.test'
      AND ci_span_kind = 'test'
      AND parent_span_id IS NOT NULL
      ${jobId === null ? "" : "AND job_id = {jobId:String}"}
    GROUP BY parent_span_id
  `, buildParams(build, jobId));
  return rows.map((row) => ({ parent_span_id: row.parent_span_id, child_count: Number(row.child_count) }));
}

/** Jobs of the build that recorded GPU samples. */
export async function gpuSampledJobIds(build: BuildRef, jobId: string | null): Promise<string[]> {
  const rows = await queryClickHouse<{ job_id: string }>(`
    SELECT DISTINCT job_id
    FROM ci.otel_spans
    WHERE ${BUILD_FILTER}
      AND span_name = 'ci.gpu.samples'
      AND job_id IS NOT NULL
      ${jobId === null ? "" : "AND job_id = {jobId:String}"}
  `, buildParams(build, jobId));
  return rows.map((row) => row.job_id);
}
