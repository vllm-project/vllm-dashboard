import { NextRequest, NextResponse } from "next/server";
import { queryClickHouse } from "@/lib/clickhouse";
import { authorizeOtlpRequest, isOtlpConfigured } from "@/lib/otel-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isOtlpConfigured()) {
    return NextResponse.json(
      { ok: false, error: "OTLP ingestion is not configured" },
      { status: 503 },
    );
  }
  const principal = await authorizeOtlpRequest(request.headers);
  if (principal?.kind !== "shared-token") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Spans are deduplicated per (trace_id, span_id); a retried export must
    // not inflate the 24-hour count.
    const [stats] = await queryClickHouse<{
      spans_24h: string;
      traces_24h: string;
      latest_received_at: string | null;
      latest_span_start: string | null;
    }>(`
      SELECT
        (SELECT uniqExact(trace_id, span_id) FROM ci.otel_spans
          WHERE received_at >= now64(3) - INTERVAL 24 HOUR) AS spans_24h,
        (SELECT uniqExact(trace_id) FROM ci.otel_spans
          WHERE received_at >= now64(3) - INTERVAL 24 HOUR) AS traces_24h,
        nullIf((SELECT max(received_at) FROM ci.otel_spans), toDateTime64(0, 3, 'UTC')) AS latest_received_at,
        nullIf((SELECT max(start_time) FROM ci.otel_spans), toDateTime64(0, 6, 'UTC')) AS latest_span_start
    `);
    const iso = (value: string | null) => (value ? new Date(value).toISOString() : null);

    return NextResponse.json({
      ok: true,
      spans_24h: Number(stats.spans_24h),
      traces_24h: Number(stats.traces_24h),
      latest_received_at: iso(stats.latest_received_at),
      latest_span_start: iso(stats.latest_span_start),
    });
  } catch (error) {
    console.error("OTLP health check failed:", error);
    return NextResponse.json(
      { ok: false, error: "OTLP storage is unavailable" },
      { status: 503 },
    );
  }
}
