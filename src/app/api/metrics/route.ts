import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCached, setCache } from "@/lib/api-cache";

const TTL = 15_000;

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const searchParams = request.nextUrl.searchParams;
    const hours = Math.min(
      parseInt(searchParams.get("hours") ?? "24", 10) || 24,
      720,
    );
    const queue = searchParams.get("queue") || null;
    const cacheKey = `metrics:${hours}:${queue ?? "all"}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    const cutoff = new Date(Date.now() - hours * 3600 * 1000);
    const latestCutoff = new Date(Date.now() - 2 * 3600 * 1000);

    let snapshotsQuery;
    if (hours <= 6) {
      snapshotsQuery = queue
        ? db`
            SELECT polled_at AS time_bucket, queue,
              agents_idle, agents_busy, agents_total,
              jobs_scheduled, jobs_running, jobs_waiting, jobs_total,
              p50_wait_secs, p90_wait_secs, p95_wait_secs
            FROM queue_snapshots
            WHERE polled_at >= ${cutoff} AND queue = ${queue}
            ORDER BY polled_at
          `
        : db`
            SELECT polled_at AS time_bucket, queue,
              agents_idle, agents_busy, agents_total,
              jobs_scheduled, jobs_running, jobs_waiting, jobs_total,
              p50_wait_secs, p90_wait_secs, p95_wait_secs
            FROM queue_snapshots
            WHERE polled_at >= ${cutoff}
            ORDER BY polled_at
          `;
    } else {
      const bucketMinutes = hours <= 24 ? 15 : hours <= 168 ? 60 : 360;
      const epochBucket = `to_timestamp(FLOOR(EXTRACT(epoch FROM polled_at) / ${bucketMinutes * 60}) * ${bucketMinutes * 60})`;

      snapshotsQuery = queue
        ? db.unsafe(
            `SELECT ${epochBucket} AS time_bucket, queue,
              ROUND(AVG(agents_idle))::int AS agents_idle,
              ROUND(AVG(agents_busy))::int AS agents_busy,
              ROUND(AVG(agents_total))::int AS agents_total,
              ROUND(AVG(jobs_scheduled))::int AS jobs_scheduled,
              ROUND(AVG(jobs_running))::int AS jobs_running,
              ROUND(AVG(jobs_waiting))::int AS jobs_waiting,
              ROUND(AVG(jobs_total))::int AS jobs_total,
              ROUND(AVG(p50_wait_secs))::int AS p50_wait_secs,
              ROUND(AVG(p90_wait_secs))::int AS p90_wait_secs,
              ROUND(AVG(p95_wait_secs))::int AS p95_wait_secs
            FROM queue_snapshots
            WHERE polled_at >= $1 AND queue = $2
            GROUP BY time_bucket, queue
            ORDER BY time_bucket`,
            [cutoff, queue],
          )
        : db.unsafe(
            `SELECT ${epochBucket} AS time_bucket, queue,
              ROUND(AVG(agents_idle))::int AS agents_idle,
              ROUND(AVG(agents_busy))::int AS agents_busy,
              ROUND(AVG(agents_total))::int AS agents_total,
              ROUND(AVG(jobs_scheduled))::int AS jobs_scheduled,
              ROUND(AVG(jobs_running))::int AS jobs_running,
              ROUND(AVG(jobs_waiting))::int AS jobs_waiting,
              ROUND(AVG(jobs_total))::int AS jobs_total,
              ROUND(AVG(p50_wait_secs))::int AS p50_wait_secs,
              ROUND(AVG(p90_wait_secs))::int AS p90_wait_secs,
              ROUND(AVG(p95_wait_secs))::int AS p95_wait_secs
            FROM queue_snapshots
            WHERE polled_at >= $1
            GROUP BY time_bucket, queue
            ORDER BY time_bucket`,
            [cutoff],
          );
    }

    const [snapshots, queueRows, latest] = await Promise.all([
      snapshotsQuery,
      db`
        SELECT DISTINCT queue FROM queue_snapshots
        WHERE polled_at >= ${cutoff}
        ORDER BY queue
      `,
      db`
        SELECT
          a.queue, a.polled_at,
          a.agents_idle, a.agents_busy, a.agents_total,
          a.jobs_scheduled, a.jobs_running, a.jobs_waiting, a.jobs_total,
          CASE WHEN a.jobs_scheduled + a.jobs_waiting > 0 THEN w.p50_wait_secs ELSE NULL END AS p50_wait_secs,
          CASE WHEN a.jobs_scheduled + a.jobs_waiting > 0 THEN w.p90_wait_secs ELSE NULL END AS p90_wait_secs,
          CASE WHEN a.jobs_scheduled + a.jobs_waiting > 0 THEN w.p95_wait_secs ELSE NULL END AS p95_wait_secs
        FROM (
          SELECT DISTINCT ON (queue) *
          FROM queue_snapshots
          WHERE polled_at >= ${latestCutoff}
          ORDER BY queue, polled_at DESC
        ) a
        LEFT JOIN (
          SELECT DISTINCT ON (queue) queue, p50_wait_secs, p90_wait_secs, p95_wait_secs
          FROM queue_snapshots
          WHERE polled_at >= ${latestCutoff} AND p90_wait_secs IS NOT NULL
          ORDER BY queue, polled_at DESC
        ) w ON a.queue = w.queue
      `,
    ]);

    const result = {
      snapshots,
      queues: queueRows.map((r) => r.queue),
      latest,
    };
    setCache(cacheKey, result, TTL);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch metrics:", error);
    return NextResponse.json(
      { error: "Failed to fetch metrics" },
      { status: 500 },
    );
  }
}
