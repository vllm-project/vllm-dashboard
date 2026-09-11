import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { parseGpuEvents } from "@/lib/job-gpu";

export const runtime = "nodejs";
const MAX_SAMPLES = 16_000;
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const organization = params.get("organization") ?? "";
  const pipeline = params.get("pipeline") ?? "";
  const buildNumber = params.get("buildNumber") ?? "";
  const jobId = params.get("jobId") ?? "";
  const start = Date.parse(params.get("start") ?? "");
  const end = Date.parse(params.get("end") ?? "");
  if (!SLUG.test(organization) || !SLUG.test(pipeline) || !/^\d{1,12}$/.test(buildNumber) || !UUID.test(jobId)
    || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 7 * 86400_000) {
    return NextResponse.json({ error: "Invalid GPU trace interval or job identity" }, { status: 400 });
  }
  try {
    const db = getDb();
    const rows = await db<{ sample: unknown }[]>`
      SELECT event.value AS sample FROM otel_spans
      CROSS JOIN LATERAL jsonb_array_elements(span_events) WITH ORDINALITY AS event(value, position)
      WHERE organization_slug = ${organization}
        AND pipeline_slug = ${pipeline}
        AND build_number = ${buildNumber}::bigint
        AND job_id = ${jobId}
        AND span_name = 'ci.gpu.samples'
        AND start_time < ${new Date(end)}
        AND end_time >= ${new Date(start)}
        AND event.value->>'name' = 'ci.gpu.sample'
        AND CASE WHEN event.value->>'timeUnixNano' ~ '^[0-9]{1,20}$'
          THEN (event.value->>'timeUnixNano')::numeric >= ${start}::numeric * 1000000
            AND (event.value->>'timeUnixNano')::numeric < ${end}::numeric * 1000000
          ELSE false END
      ORDER BY start_time, span_id, event.position
      LIMIT ${MAX_SAMPLES + 1}
    `;
    return NextResponse.json({
      samples: parseGpuEvents(rows.slice(0, MAX_SAMPLES).map((row) => row.sample), start, end),
      intervalMs: 1000,
      truncated: rows.length > MAX_SAMPLES,
    }, { headers: { "Cache-Control": "private, max-age=5" } });
  } catch (error) {
    console.error("Failed to load job GPU samples:", error);
    return NextResponse.json({ error: "Failed to load GPU samples" }, { status: 500 });
  }
}
