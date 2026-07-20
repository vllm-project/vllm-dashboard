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

    const bucketMinutes = hours <= 1
      ? 1
      : hours <= 6
        ? 2
        : hours <= 24
          ? 5
          : hours <= 168
            ? 30
            : hours <= 336
              ? 60
              : 120;

    const snapshotsQuery = hostname
      ? db`
          SELECT
            date_bin(
              INTERVAL '1 minute' * ${bucketMinutes},
              reported_at,
              TIMESTAMPTZ 'epoch'
            ) AS time_bucket,
            hostname,
            gpu_name,
            ROUND(SUM(CASE
              WHEN mem_total_mb > 0 THEN mem_used_mb / mem_total_mb * 100
              ELSE 0
            END)::numeric, 2) AS mem_pct_sum,
            COUNT(*)::int AS sample_count
          FROM gpu_snapshots
          WHERE reported_at > NOW() - INTERVAL '1 hour' * ${hours}
            AND hostname = ${hostname}
          GROUP BY time_bucket, hostname, gpu_name
          ORDER BY time_bucket ASC, hostname ASC, gpu_name ASC
        `
      : db`
          SELECT
            date_bin(
              INTERVAL '1 minute' * ${bucketMinutes},
              reported_at,
              TIMESTAMPTZ 'epoch'
            ) AS time_bucket,
            hostname,
            gpu_name,
            ROUND(SUM(CASE
              WHEN mem_total_mb > 0 THEN mem_used_mb / mem_total_mb * 100
              ELSE 0
            END)::numeric, 2) AS mem_pct_sum,
            COUNT(*)::int AS sample_count
          FROM gpu_snapshots
          WHERE reported_at > NOW() - INTERVAL '1 hour' * ${hours}
          GROUP BY time_bucket, hostname, gpu_name
          ORDER BY time_bucket ASC, hostname ASC, gpu_name ASC
        `;

    // Walk the composite index from one (hostname, gpu_index) key to the next.
    // SELECT DISTINCT would scan every retained snapshot just to enumerate this
    // small roster; the recursive lateral lookup performs one index seek per GPU.
    const latestQuery = db`
      WITH RECURSIVE gpu_keys(hostname, gpu_index) AS (
        (
          SELECT hostname, gpu_index
          FROM gpu_snapshots
          WHERE reported_at > NOW() - INTERVAL '1 hour' * ${LATEST_LOOKBACK_HOURS}
          ORDER BY hostname, gpu_index
          LIMIT 1
        )
        UNION ALL
        SELECT next_key.hostname, next_key.gpu_index
        FROM gpu_keys current_key
        CROSS JOIN LATERAL (
          SELECT hostname, gpu_index
          FROM gpu_snapshots
          WHERE (hostname, gpu_index) > (current_key.hostname, current_key.gpu_index)
            AND reported_at > NOW() - INTERVAL '1 hour' * ${LATEST_LOOKBACK_HOURS}
          ORDER BY hostname, gpu_index
          LIMIT 1
        ) next_key
      )
      SELECT l.hostname, l.gpu_index, l.gpu_name, l.gpu_util, l.mem_used_mb,
             l.mem_total_mb, l.temperature_c, l.power_draw_w, l.power_limit_w,
             l.reported_at
      FROM gpu_keys k
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

    const [snapshots, latestResult] = await Promise.all([
      snapshotsQuery,
      latestQuery,
    ]);

    return NextResponse.json(
      { snapshots, latest: latestResult },
      {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "Vercel-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    console.error("GPU metrics query failed:", error);
    return NextResponse.json(
      { error: "Failed to query GPU metrics" },
      { status: 500 },
    );
  }
}
