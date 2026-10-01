import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getOrLoadCached } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { queueBucketMinutes } from "@/lib/queue-metrics";

const TTL = 5 * 60_000;
const CDN_CACHE = { maxAge: 300, staleWhileRevalidate: 3_600 };
const MAX_HISTORY_HOURS = 90 * 24;

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const searchParams = request.nextUrl.searchParams;
    const hours = Math.min(
      parseInt(searchParams.get("hours") ?? "24", 10) || 24,
      MAX_HISTORY_HOURS,
    );
    const queue = searchParams.get("queue") || null;
    const latestOnly = searchParams.get("latest") === "1";
    const bucketMinutes = queueBucketMinutes(hours);
    const cacheKey = `metrics:${hours}:${queue ?? "all"}:${latestOnly ? "latest" : "history"}`;
    const { data: result } = await getOrLoadCached(cacheKey, TTL, async () => {
      const cutoff = new Date(Date.now() - hours * 3600 * 1000);
      const latestCutoff = new Date(Date.now() - 2 * 3600 * 1000);

      let snapshotsQuery;
      if (latestOnly) {
        snapshotsQuery = Promise.resolve([]);
      } else if (hours <= 6) {
        snapshotsQuery = queue
          ? db`
              SELECT polled_at AS time_bucket, queue,
                agents_idle, agents_busy, agents_total,
                jobs_scheduled, jobs_running, jobs_waiting, jobs_total,
                p50_wait_secs, p90_wait_secs, p95_wait_secs,
                (to_jsonb(queue_snapshots) ->> 'p99_wait_secs')::real AS p99_wait_secs
              FROM queue_snapshots
              WHERE polled_at >= ${cutoff} AND queue = ${queue}
              ORDER BY polled_at
            `
          : db`
              SELECT polled_at AS time_bucket, queue,
                agents_idle, agents_busy, agents_total,
                jobs_scheduled, jobs_running, jobs_waiting, jobs_total,
                p50_wait_secs, p90_wait_secs, p95_wait_secs,
                (to_jsonb(queue_snapshots) ->> 'p99_wait_secs')::real AS p99_wait_secs
              FROM queue_snapshots
              WHERE polled_at >= ${cutoff}
              ORDER BY polled_at
            `;
      } else {
        // Keep pre-migration schemas readable while allowing large scans to use
        // the covering index instead of converting every row to JSON.
        const { data: hasP99 } = await getOrLoadCached(
          "metrics:has-p99",
          TTL,
          async () => {
            const [row] = await db`
              SELECT EXISTS (
                SELECT 1 FROM pg_attribute
                WHERE attrelid = 'queue_snapshots'::regclass
                  AND attname = 'p99_wait_secs'
                  AND attnum > 0 AND NOT attisdropped
              ) AS has_p99
            `;
            return row.has_p99 === true;
          },
        );
        const p99WaitExpression = hasP99 ? "p99_wait_secs::real" : "NULL::real";
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
                ROUND(AVG(p50_wait_secs) FILTER (WHERE agents_total > 0))::int AS p50_wait_secs,
                ROUND(AVG(p90_wait_secs) FILTER (WHERE agents_total > 0))::int AS p90_wait_secs,
                ROUND(AVG(p95_wait_secs) FILTER (WHERE agents_total > 0))::int AS p95_wait_secs,
                ROUND(AVG(${p99WaitExpression}) FILTER (WHERE agents_total > 0))::int AS p99_wait_secs
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
                ROUND(AVG(p50_wait_secs) FILTER (WHERE agents_total > 0))::int AS p50_wait_secs,
                ROUND(AVG(p90_wait_secs) FILTER (WHERE agents_total > 0))::int AS p90_wait_secs,
                ROUND(AVG(p95_wait_secs) FILTER (WHERE agents_total > 0))::int AS p95_wait_secs,
                ROUND(AVG(${p99WaitExpression}) FILTER (WHERE agents_total > 0))::int AS p99_wait_secs
              FROM queue_snapshots
              WHERE polled_at >= $1
              GROUP BY time_bucket, queue
              ORDER BY time_bucket`,
              [cutoff],
            );
      }

      const [snapshots, latest] = await Promise.all([
        snapshotsQuery,
        db`
          SELECT DISTINCT ON (queue)
            queue, polled_at,
            agents_idle, agents_busy, agents_total,
            jobs_scheduled, jobs_running, jobs_waiting, jobs_total,
            p50_wait_secs, p90_wait_secs, p95_wait_secs,
            (to_jsonb(queue_snapshots) ->> 'p99_wait_secs')::real AS p99_wait_secs
          FROM queue_snapshots
          WHERE polled_at >= ${latestCutoff}
          ORDER BY queue, polled_at DESC
        `,
      ]);

      return {
        query: { hours, queue, bucketMinutes },
        snapshots,
        queues: [...new Set(latest.map((row) => row.queue))].sort(),
        latest,
      };
    });

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch metrics:", error);
    return NextResponse.json(
      { error: "Failed to fetch metrics" },
      { status: 500 },
    );
  }
}
