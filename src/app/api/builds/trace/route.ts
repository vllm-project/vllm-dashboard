import { NextRequest, NextResponse } from "next/server";
import { gpuSampledJobIds, testCountsByParent, traceRows, type TraceRow } from "@/lib/build-trace-clickhouse";
import { criticalPathIds } from "@/lib/build-critical-path";

export const runtime = "nodejs";

const MAX_BUILD_SPANS = 5_000;
const JOB_DETAIL_PAGE_SIZE = 2_000;
const COMPLETION_CLOCK_SKEW_MS = 30_000;
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


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

function markCriticalPath(lanes: Lane[]) {
  const chain = criticalPathIds(lanes);
  return lanes.map((lane) => ({
    ...lane,
    critical: chain.has(lane.id),
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
    const page = Number(pageValue);
    const pageSize = jobId === null ? MAX_BUILD_SPANS : JOB_DETAIL_PAGE_SIZE;
    const requestedJobId = jobId ?? null;
    const offset = page * pageSize;
    const build = { organization, pipeline, buildNumber };
    const fetchedRows = await traceRows(build, requestedJobId, pageSize + 1, offset);
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

    const detailCounts = await testCountsByParent(build, requestedJobId);
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

    const jobLanes = markCriticalPath(baseJobLanes);
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
    const gpuJobIds = new Set(await gpuSampledJobIds(build, requestedJobId));
    const lanes = [...jobLanes, ...detailLanes].map((lane) => ({
      ...lane,
      gpuAvailable: lane.jobId !== null && gpuJobIds.has(lane.jobId),
    }));

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
