import { NextRequest, NextResponse } from "next/server";
import { queryClickHouse } from "@/lib/clickhouse";
import { attrText, DEDUPE_SPANS } from "@/lib/otel-clickhouse";
import { compactGpuSummary, parseGpuEvents } from "@/lib/job-gpu";

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
    // Each ci.gpu.samples span carries its readings as ci.gpu.sample events
    // (span_events, a JSON array). Unnest them in span then event order.
    const events = await queryClickHouse<{ sample: string }>(`
      SELECT ev AS sample
      FROM (
        SELECT trace_id, span_id, start_time, span_events
        FROM ci.otel_spans
        WHERE span_name = 'ci.gpu.samples'
          AND job_id = {jobId:String}
          AND organization_slug = {organization:String}
          AND pipeline_slug = {pipeline:String}
          AND build_number = {buildNumber:Int64}
          AND start_time < fromUnixTimestamp64Milli({end:Int64}, 'UTC')
          AND end_time >= fromUnixTimestamp64Milli({start:Int64}, 'UTC')
        ${DEDUPE_SPANS}
      )
      ARRAY JOIN
        JSONExtractArrayRaw(span_events) AS ev,
        arrayEnumerate(JSONExtractArrayRaw(span_events)) AS position
      WHERE JSONExtractString(ev, 'name') = 'ci.gpu.sample'
        AND match(ifNull(${attrText("timeUnixNano", "ev")}, ''), '^[0-9]{1,20}$')
        AND toUInt64OrZero(${attrText("timeUnixNano", "ev")}) >= {start:UInt64} * 1000000
        AND toUInt64OrZero(${attrText("timeUnixNano", "ev")}) < {end:UInt64} * 1000000
      ORDER BY start_time, span_id, position
      LIMIT {limit:UInt32}
    `, { organization, pipeline, buildNumber, jobId, start, end, limit: MAX_SAMPLES + 1 });
    const rows = events.map((row) => ({ sample: JSON.parse(row.sample) as unknown }));
    const samples = parseGpuEvents(rows.slice(0, MAX_SAMPLES).map((row) => row.sample), start, end);
    return NextResponse.json({
      ...(params.get("summary") === "1" ? {
        schemaVersion: 1, source: "otel-gpu-samples", fetchedAt: new Date().toISOString(),
        organization, pipeline, buildNumber, jobId,
        start: new Date(start).toISOString(), end: new Date(end).toISOString(),
        available: samples.length > 0, devices: compactGpuSummary(samples, start, end, 1000),
        note: "Device activity shared by overlapping tests. Missing samples are unknown, not idle. Samples expire after seven days. Truncated summaries describe only returned samples.",
      } : { samples }),
      intervalMs: 1000,
      truncated: rows.length > MAX_SAMPLES,
    }, { headers: { "Cache-Control": "private, max-age=5" } });
  } catch (error) {
    console.error("Failed to load job GPU samples:", error);
    return NextResponse.json({ error: "Failed to load GPU samples" }, { status: 500 });
  }
}
