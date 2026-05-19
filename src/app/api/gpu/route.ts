import { NextRequest, NextResponse } from "next/server";
import { getDb, initSchema } from "@/lib/db";

let schemaInitialized = false;

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

    const latestResult = await db`
      SELECT DISTINCT ON (hostname, gpu_index)
        hostname, gpu_index, gpu_name, gpu_util, mem_used_mb, mem_total_mb,
        temperature_c, power_draw_w, power_limit_w, reported_at
      FROM gpu_snapshots
      WHERE reported_at > NOW() - INTERVAL '10 minutes'
      ORDER BY hostname, gpu_index, reported_at DESC
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
