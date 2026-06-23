import { NextRequest, NextResponse } from "next/server";
import { getDb, initSchema } from "@/lib/db";

let schemaInitialized = false;

// The host roster (latest snapshot per host) is decoupled from the chart's
// selected time window: a node that stopped reporting should still appear in
// the Host Summary table (badged Offline) instead of silently vanishing once
// its last report ages past the chart window. Anything seen within this
// lookback is shown; longer-dead/decommissioned nodes eventually drop off.
const LATEST_LOOKBACK_HOURS = 720; // 30 days

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const hours = Math.min(parseInt(searchParams.get("hours") ?? "24", 10) || 24, 720);
  const hostname = searchParams.get("hostname") ?? "";

  try {
    const db = getDb();

    if (!schemaInitialized) {
      await initSchema();
      schemaInitialized = true;
    }

    const bucketMinutes = hours <= 1 ? 1 : hours <= 6 ? 2 : hours <= 24 ? 5 : hours <= 168 ? 30 : 60;

    const snapshots = hostname
      ? await db`
          SELECT
            date_trunc('hour', reported_at)
              + INTERVAL '1 minute' * (FLOOR(EXTRACT(MINUTE FROM reported_at) / ${bucketMinutes}) * ${bucketMinutes})
              AS time_bucket,
            hostname,
            gpu_index,
            gpu_name,
            ROUND(AVG(gpu_util)::numeric, 1) AS gpu_util,
            ROUND(AVG(mem_used_mb)::numeric, 0) AS mem_used_mb,
            MAX(mem_total_mb) AS mem_total_mb,
            ROUND(AVG(temperature_c)::numeric, 0) AS temperature_c,
            ROUND(AVG(power_draw_w)::numeric, 0) AS power_draw_w,
            MAX(power_limit_w) AS power_limit_w
          FROM gpu_snapshots
          WHERE reported_at > NOW() - INTERVAL '1 hour' * ${hours}
            AND hostname = ${hostname}
          GROUP BY time_bucket, hostname, gpu_index, gpu_name
          ORDER BY time_bucket ASC, gpu_index ASC
        `
      : await db`
          SELECT
            date_trunc('hour', reported_at)
              + INTERVAL '1 minute' * (FLOOR(EXTRACT(MINUTE FROM reported_at) / ${bucketMinutes}) * ${bucketMinutes})
              AS time_bucket,
            hostname,
            gpu_index,
            gpu_name,
            ROUND(AVG(gpu_util)::numeric, 1) AS gpu_util,
            ROUND(AVG(mem_used_mb)::numeric, 0) AS mem_used_mb,
            MAX(mem_total_mb) AS mem_total_mb,
            ROUND(AVG(temperature_c)::numeric, 0) AS temperature_c,
            ROUND(AVG(power_draw_w)::numeric, 0) AS power_draw_w,
            MAX(power_limit_w) AS power_limit_w
          FROM gpu_snapshots
          WHERE reported_at > NOW() - INTERVAL '1 hour' * ${hours}
          GROUP BY time_bucket, hostname, gpu_index, gpu_name
          ORDER BY time_bucket ASC, gpu_index ASC
        `;

    const hostnamesResult = await db`
      SELECT DISTINCT hostname FROM gpu_snapshots
      WHERE reported_at > NOW() - INTERVAL '1 hour' * ${hours}
      ORDER BY hostname
    `;

    // Latest snapshot per (hostname, gpu_index) over the 30-day roster window.
    // A plain DISTINCT ON here forces Postgres to read+dedup every row in the
    // window (millions, at a 30s report cadence) before keeping one per GPU.
    // Instead, enumerate the distinct GPU keys (index-only scan over
    // idx_gpu_snapshots_host_gpu_reported), then fetch just the single newest
    // row per key via a lateral lookup — bounding heap fetches to ~one per GPU.
    const latestResult = await db`
      SELECT l.hostname, l.gpu_index, l.gpu_name, l.gpu_util, l.mem_used_mb,
             l.mem_total_mb, l.temperature_c, l.power_draw_w, l.power_limit_w,
             l.reported_at
      FROM (
        SELECT DISTINCT hostname, gpu_index
        FROM gpu_snapshots
        WHERE reported_at > NOW() - INTERVAL '1 hour' * ${LATEST_LOOKBACK_HOURS}
      ) k
      CROSS JOIN LATERAL (
        SELECT hostname, gpu_index, gpu_name, gpu_util, mem_used_mb, mem_total_mb,
               temperature_c, power_draw_w, power_limit_w, reported_at
        FROM gpu_snapshots s
        WHERE s.hostname = k.hostname AND s.gpu_index = k.gpu_index
        ORDER BY s.reported_at DESC
        LIMIT 1
      ) l
      ORDER BY l.hostname, l.gpu_index
    `;

    return NextResponse.json({
      snapshots,
      hostnames: hostnamesResult.map((r) => r.hostname),
      latest: latestResult,
    });
  } catch (error) {
    console.error("GPU metrics query failed:", error);
    return NextResponse.json(
      { error: "Failed to query GPU metrics" },
      { status: 500 },
    );
  }
}
