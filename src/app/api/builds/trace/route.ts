import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

const MAX_BUILD_SPANS = 5_000;
const JOB_DETAIL_PAGE_SIZE = 2_000;
const COMPLETION_CLOCK_SKEW_MS = 30_000;
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TraceRow = {
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

type LaneKind = "job" | "step" | "command" | "test";

type Lane = {
  id: string;
  parentId: string | null;
  traceId: string;
  kind: LaneKind;
  label: string;
  group: string | null;
  stepKey: string | null;
  jobId: string | null;
  queue: string | null;
  startTime: string;
  endTime: string;
  durationMs: number;
  waitMs: number;
  status: "passed" | "failed" | "skipped" | "unknown";
  outcome: string | null;
  url: string | null;
  critical: boolean;
  childCount: number;
};

type DetailCountRow = {
  parent_span_id: string;
  child_count: number;
};

function laneStatus(row: TraceRow): Lane["status"] {
  if (row.test_outcome === "skipped") return "skipped";
  if (
    row.status_code === 2 ||
    row.job_passed === "false" ||
    row.step_outcome === "failed" ||
    row.test_outcome === "failed"
  ) {
    return "failed";
  }
  if (
    row.status_code === 1 ||
    row.job_passed === "true" ||
    row.step_outcome === "passed" ||
    row.test_outcome === "passed"
  ) {
    return "passed";
  }
  return "unknown";
}

function markCompletionFrontier(lanes: Lane[]) {
  const ordered = [...lanes].sort((a, b) => {
    const start = Date.parse(a.startTime) - Date.parse(b.startTime);
    if (start !== 0) return start;
    return Date.parse(b.endTime) - Date.parse(a.endTime);
  });
  let furthestEnd = Number.NEGATIVE_INFINITY;
  const frontier = new Set<string>();
  for (const lane of ordered) {
    const end = Date.parse(lane.endTime);
    if (end > furthestEnd + 1) {
      frontier.add(lane.id);
      furthestEnd = end;
    }
  }
  return lanes.map((lane) => ({
    ...lane,
    critical: frontier.has(lane.id),
  }));
}

function error(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function jobLane(row: TraceRow, id = row.span_id): Lane {
  return {
    id,
    parentId: row.parent_span_id,
    traceId: row.trace_id,
    kind: row.span_name === "buildkite.step" ? "step" : "job",
    label: row.job_label ?? row.step_label ?? row.span_name,
    group: row.group_label,
    stepKey: row.step_key,
    jobId: row.job_id,
    queue: row.agent_queue,
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    durationMs: Number(row.duration_ms),
    waitMs: Math.max(0, Number(row.wait_ms ?? 0)),
    status: laneStatus(row),
    outcome: row.job_state ?? row.step_outcome,
    url: row.job_url ?? row.step_url,
    critical: false,
    childCount: 0,
  };
}

function detailKind(row: TraceRow): "command" | "test" | null {
  if (row.ci_kind === "command") return "command";
  if (row.ci_kind === "test") return "test";
  return null;
}

function detailLabel(row: TraceRow, kind: "command" | "test"): string {
  if (kind === "test") return row.test_nodeid ?? row.span_name;
  const prefix = row.command_index ? `${row.command_index}. ` : "";
  return `${prefix}${row.command_label ?? row.span_name}`;
}

export async function GET(request: NextRequest) {
  const organization = request.nextUrl.searchParams.get("organization") ?? "";
  const pipeline = request.nextUrl.searchParams.get("pipeline") ?? "";
  const buildNumber = request.nextUrl.searchParams.get("buildNumber") ?? "";
  const jobId = request.nextUrl.searchParams.get("jobId");
  const pageValue = request.nextUrl.searchParams.get("page") ?? "0";

  if (!SLUG.test(organization) || !SLUG.test(pipeline)) {
    return error("Invalid Buildkite organization or pipeline", 400);
  }
  if (!/^\d{1,12}$/.test(buildNumber)) {
    return error("Invalid Buildkite build number", 400);
  }
  if (jobId !== null && !JOB_ID.test(jobId)) {
    return error("Invalid Buildkite job ID", 400);
  }
  if (
    !/^\d{1,4}$/.test(pageValue) ||
    (jobId === null && pageValue !== "0")
  ) {
    return error("Invalid trace page", 400);
  }

  try {
    const db = getDb();
    const page = Number(pageValue);
    const pageSize = jobId === null ? MAX_BUILD_SPANS : JOB_DETAIL_PAGE_SIZE;
    const requestedJobId = jobId ?? null;
    const offset = page * pageSize;
    const fetchedRows = await db<TraceRow[]>`
      SELECT
        trace_id,
        span_id,
        parent_span_id,
        span_name,
        start_time,
        end_time,
        duration_ms,
        status_code,
        step_key,
        job_id,
        job_label,
        job_state,
        agent_queue,
        NULLIF(span_attributes->>'buildkite.step.label', '') AS step_label,
        NULLIF(span_attributes->>'buildkite.step.group.label', '') AS group_label,
        NULLIF(span_attributes->>'buildkite.step.outcome', '') AS step_outcome,
        NULLIF(span_attributes->>'buildkite.job.passed', '') AS job_passed,
        NULLIF(span_attributes->>'buildkite.job.web_url', '') AS job_url,
        NULLIF(span_attributes->>'buildkite.step.web_url', '') AS step_url,
        CASE
          WHEN span_attributes->>'buildkite.job.wait_time_ms' ~ '^\d+(\.\d+)?$'
          THEN (span_attributes->>'buildkite.job.wait_time_ms')::double precision
          ELSE 0
        END AS wait_ms,
        NULLIF(span_attributes->>'ci.span.kind', '') AS ci_kind,
        CASE
          WHEN span_attributes->>'ci.command.index' ~ '^\d+$'
          THEN (span_attributes->>'ci.command.index')::integer
          ELSE NULL
        END AS command_index,
        NULLIF(span_attributes->>'ci.command.label', '') AS command_label,
        NULLIF(span_attributes->>'test.nodeid', '') AS test_nodeid,
        NULLIF(span_attributes->>'test.outcome', '') AS test_outcome,
        received_at
      FROM otel_spans
      WHERE organization_slug = ${organization}
        AND pipeline_slug = ${pipeline}
        AND build_number = ${buildNumber}::bigint
        AND (
          (
            ${requestedJobId}::text IS NULL
            AND (
              span_name IN ('buildkite.build', 'buildkite.job', 'buildkite.step')
              OR span_attributes->>'ci.span.kind' = 'command'
            )
          )
          OR (
            ${requestedJobId}::text IS NOT NULL
            AND job_id = ${requestedJobId}
          )
        )
      ORDER BY start_time ASC, duration_ms DESC, span_id ASC
      LIMIT ${pageSize + 1}
      OFFSET ${offset}
    `;
    const hasMore = fetchedRows.length > pageSize;
    const rows = hasMore ? fetchedRows.slice(0, pageSize) : fetchedRows;

    if (rows.length === 0) {
      return NextResponse.json(
        {
          available: false,
          complete: false,
          truncated: false,
          nextPage: null,
          lanes: [],
          summary: null,
        },
        { headers: { "Cache-Control": "private, max-age=5" } },
      );
    }

    const detailCounts = await db<DetailCountRow[]>`
      SELECT
        parent_span_id,
        COUNT(*)::integer AS child_count
      FROM otel_spans
      WHERE organization_slug = ${organization}
        AND pipeline_slug = ${pipeline}
        AND build_number = ${buildNumber}::bigint
        AND span_attributes->>'ci.span.kind' = 'test'
        AND parent_span_id IS NOT NULL
        AND (${requestedJobId}::text IS NULL OR job_id = ${requestedJobId})
      GROUP BY parent_span_id
    `;
    const childCountByParent = new Map(
      detailCounts.map((row) => [row.parent_span_id, Number(row.child_count)]),
    );

    const childJobParents = new Set(
      rows
        .filter((row) => row.span_name === "buildkite.job")
        .map((row) => row.parent_span_id)
        .filter((value): value is string => Boolean(value)),
    );
    const controlRows = rows.filter(
      (row) =>
        row.span_name === "buildkite.job" ||
        (row.span_name === "buildkite.step" &&
          !childJobParents.has(row.span_id)),
    );
    const details = rows.filter((row) => detailKind(row) !== null);

    const baseJobLanes = controlRows.map((row) => jobLane(row));
    const jobLaneByJobId = new Map(
      baseJobLanes
        .filter((lane) => lane.jobId)
        .map((lane) => [lane.jobId as string, lane]),
    );

    const detailRowsByJobId = new Map<string, TraceRow[]>();
    for (const row of details) {
      if (!row.job_id) continue;
      const jobRows = detailRowsByJobId.get(row.job_id) ?? [];
      jobRows.push(row);
      detailRowsByJobId.set(row.job_id, jobRows);
    }
    for (const [jobId, jobRows] of detailRowsByJobId) {
      if (jobLaneByJobId.has(jobId)) continue;
      const first = jobRows[0];
      const start = Math.min(...jobRows.map((row) => row.start_time.getTime()));
      const end = Math.max(...jobRows.map((row) => row.end_time.getTime()));
      const synthetic = jobLane(first, `job:${jobId}`);
      synthetic.parentId = null;
      synthetic.startTime = new Date(start).toISOString();
      synthetic.endTime = new Date(end).toISOString();
      synthetic.durationMs = Math.max(0, end - start);
      synthetic.waitMs = 0;
      synthetic.status = jobRows.some((row) => laneStatus(row) === "failed")
        ? "failed"
        : "unknown";
      baseJobLanes.push(synthetic);
      jobLaneByJobId.set(jobId, synthetic);
    }

    const jobLanes = markCompletionFrontier(baseJobLanes);
    const detailLanes = details.map((row): Lane => {
      const kind = detailKind(row) as "command" | "test";
      const jobParent = row.job_id
        ? (jobLaneByJobId.get(row.job_id)?.id ?? null)
        : null;
      const parentId =
        kind === "test" && row.parent_span_id
          ? row.parent_span_id
          : jobParent;
      return {
        id: row.span_id,
        parentId,
        traceId: row.trace_id,
        kind,
        label: detailLabel(row, kind),
        group: row.group_label,
        stepKey: row.step_key,
        jobId: row.job_id,
        queue: row.agent_queue,
        startTime: row.start_time.toISOString(),
        endTime: row.end_time.toISOString(),
        durationMs: Number(row.duration_ms),
        waitMs: 0,
        status: laneStatus(row),
        outcome: kind === "test" ? row.test_outcome : null,
        url: null,
        critical: false,
        childCount: kind === "command"
          ? (childCountByParent.get(row.span_id) ?? 0)
          : 0,
      };
    });
    const lanes = [...jobLanes, ...detailLanes];

    const buildSpans = rows.filter(
      (row) => row.span_name === "buildkite.build",
    );
    const laneStarts = lanes.map(
      (lane) => Date.parse(lane.startTime) - lane.waitMs,
    );
    const laneEnds = lanes.map((lane) => Date.parse(lane.endTime));
    const buildStarts = buildSpans.map((row) => row.start_time.getTime());
    const buildEnds = buildSpans.map((row) => row.end_time.getTime());
    const observedStart = Math.min(
      ...(buildStarts.length > 0
        ? buildStarts
        : rows.map((row) => row.start_time.getTime())),
      ...laneStarts,
    );
    const observedEnd = Math.max(
      ...(buildEnds.length > 0
        ? buildEnds
        : rows.map((row) => row.end_time.getTime())),
      ...laneEnds,
    );
    const latestBuildEnd =
      buildEnds.length > 0 ? Math.max(...buildEnds) : Number.NEGATIVE_INFINITY;
    // A Buildkite retry keeps the same build number. The previous attempt's
    // completed build span can therefore coexist with newer job/detail spans.
    // Treat the trace as live until a build span covers those newer lanes.
    const complete =
      buildSpans.length > 0 &&
      latestBuildEnd >= observedEnd - COMPLETION_CLOCK_SKEW_MS;
    const latestReceived = Math.max(
      ...rows.map((row) => row.received_at.getTime()),
    );
    const commandCount = detailLanes.filter(
      (lane) => lane.kind === "command",
    ).length;
    const testCount = jobId === null
      ? [...childCountByParent.values()].reduce((sum, count) => sum + count, 0)
      : detailLanes.filter((lane) => lane.kind === "test").length;

    return NextResponse.json(
      {
        available: true,
        complete,
        truncated: hasMore,
        nextPage: hasMore ? page + 1 : null,
        lanes,
        summary: {
          observedStart: new Date(observedStart).toISOString(),
          observedEnd: new Date(observedEnd).toISOString(),
          observedDurationMs: Math.max(0, observedEnd - observedStart),
          spanCount: jobId === null ? rows.length + testCount : rows.length,
          laneCount: jobLanes.length,
          commandCount,
          testCount,
          traceCount: new Set(rows.map((row) => row.trace_id)).size,
          queueCount: new Set(
            jobLanes.map((lane) => lane.queue).filter(Boolean),
          ).size,
          criticalCount: jobLanes.filter((lane) => lane.critical).length,
          latestReceivedAt: new Date(latestReceived).toISOString(),
        },
      },
      { headers: { "Cache-Control": "private, max-age=5" } },
    );
  } catch (cause) {
    console.error("Failed to load build trace:", cause);
    return error("Failed to load build trace", 500);
  }
}
