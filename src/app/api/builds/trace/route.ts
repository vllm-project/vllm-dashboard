import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

const MAX_SPANS = 2_000;
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;

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
  received_at: Date;
};

type Lane = {
  id: string;
  parentId: string | null;
  traceId: string;
  kind: "job" | "step";
  label: string;
  group: string | null;
  stepKey: string | null;
  jobId: string | null;
  queue: string | null;
  startTime: string;
  endTime: string;
  durationMs: number;
  waitMs: number;
  status: "passed" | "failed" | "unknown";
  url: string | null;
  critical: boolean;
};

function laneStatus(row: TraceRow): Lane["status"] {
  if (
    row.status_code === 2 ||
    row.job_passed === "false" ||
    row.step_outcome === "failed"
  ) {
    return "failed";
  }
  if (
    row.status_code === 1 ||
    row.job_passed === "true" ||
    row.step_outcome === "passed"
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

export async function GET(request: NextRequest) {
  const organization = request.nextUrl.searchParams.get("organization") ?? "";
  const pipeline = request.nextUrl.searchParams.get("pipeline") ?? "";
  const buildNumber = request.nextUrl.searchParams.get("buildNumber") ?? "";

  if (!SLUG.test(organization) || !SLUG.test(pipeline)) {
    return error("Invalid Buildkite organization or pipeline", 400);
  }
  if (!/^\d{1,12}$/.test(buildNumber)) {
    return error("Invalid Buildkite build number", 400);
  }

  try {
    const db = getDb();
    const rows = await db<TraceRow[]>`
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
          WHEN span_attributes->>'buildkite.job.wait_time_ms' ~ '^\\d+(\\.\\d+)?$'
          THEN (span_attributes->>'buildkite.job.wait_time_ms')::double precision
          ELSE 0
        END AS wait_ms,
        received_at
      FROM otel_spans
      WHERE organization_slug = ${organization}
        AND pipeline_slug = ${pipeline}
        AND build_number = ${buildNumber}::bigint
      ORDER BY start_time ASC, duration_ms DESC
      LIMIT ${MAX_SPANS}
    `;

    if (rows.length === 0) {
      return NextResponse.json(
        {
          available: false,
          complete: false,
          truncated: false,
          lanes: [],
          summary: null,
        },
        { headers: { "Cache-Control": "private, max-age=5" } },
      );
    }

    const childJobParents = new Set(
      rows
        .filter((row) => row.span_name === "buildkite.job")
        .map((row) => row.parent_span_id)
        .filter((value): value is string => Boolean(value)),
    );
    const displayRows = rows.filter(
      (row) =>
        row.span_name === "buildkite.job" ||
        (row.span_name === "buildkite.step" &&
          !childJobParents.has(row.span_id)),
    );

    const lanes = markCompletionFrontier(
      displayRows.map((row) => ({
        id: row.span_id,
        parentId: row.parent_span_id,
        traceId: row.trace_id,
        kind: row.span_name === "buildkite.job" ? "job" : "step",
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
        url: row.job_url ?? row.step_url,
        critical: false,
      })),
    );

    const buildSpan = rows.find((row) => row.span_name === "buildkite.build");
    const laneStarts = lanes.map(
      (lane) => Date.parse(lane.startTime) - lane.waitMs,
    );
    const laneEnds = lanes.map((lane) => Date.parse(lane.endTime));
    const observedStart = buildSpan
      ? buildSpan.start_time.getTime()
      : laneStarts.length > 0
        ? Math.min(...laneStarts)
        : Math.min(...rows.map((row) => row.start_time.getTime()));
    const observedEnd = buildSpan
      ? buildSpan.end_time.getTime()
      : laneEnds.length > 0
        ? Math.max(...laneEnds)
        : Math.max(...rows.map((row) => row.end_time.getTime()));
    const latestReceived = Math.max(
      ...rows.map((row) => row.received_at.getTime()),
    );

    return NextResponse.json(
      {
        available: true,
        complete: Boolean(buildSpan),
        truncated: rows.length === MAX_SPANS,
        lanes,
        summary: {
          observedStart: new Date(observedStart).toISOString(),
          observedEnd: new Date(observedEnd).toISOString(),
          observedDurationMs: Math.max(0, observedEnd - observedStart),
          spanCount: rows.length,
          laneCount: lanes.length,
          traceCount: new Set(rows.map((row) => row.trace_id)).size,
          queueCount: new Set(
            lanes.map((lane) => lane.queue).filter(Boolean),
          ).size,
          criticalCount: lanes.filter((lane) => lane.critical).length,
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
