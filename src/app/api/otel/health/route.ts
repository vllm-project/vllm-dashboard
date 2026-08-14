import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isOtlpAuthorized, isOtlpConfigured } from "@/lib/otel-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isOtlpConfigured()) {
    return NextResponse.json(
      { ok: false, error: "OTLP ingestion is not configured" },
      { status: 503 },
    );
  }
  if (!isOtlpAuthorized(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getDb();
    const [stats] = await db<
      Array<{
        spans_24h: string;
        traces_24h: string;
        latest_received_at: Date | null;
        latest_span_start: Date | null;
      }>
    >`
      SELECT
        COUNT(*) FILTER (WHERE received_at >= NOW() - INTERVAL '24 hours')::text
          AS spans_24h,
        COUNT(DISTINCT trace_id) FILTER (
          WHERE received_at >= NOW() - INTERVAL '24 hours'
        )::text AS traces_24h,
        MAX(received_at) AS latest_received_at,
        MAX(start_time) AS latest_span_start
      FROM otel_spans
    `;

    return NextResponse.json({
      ok: true,
      spans_24h: Number(stats.spans_24h),
      traces_24h: Number(stats.traces_24h),
      latest_received_at: stats.latest_received_at?.toISOString() ?? null,
      latest_span_start: stats.latest_span_start?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("OTLP health check failed:", error);
    return NextResponse.json(
      { ok: false, error: "OTLP storage is unavailable" },
      { status: 503 },
    );
  }
}
