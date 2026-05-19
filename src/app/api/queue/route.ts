import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";

const TTL = 60_000;

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const pipeline = searchParams.get("pipeline");
    const queue = searchParams.get("queue");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const cacheKey = `queue:${pipeline}:${queue}:${startDate}:${endDate}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    const conditions = [
      "j._fivetran_deleted = false",
      "j.type = 'script'",
      "j.runnable_at IS NOT NULL",
      "j.started_at IS NOT NULL",
      "b._fivetran_deleted = false",
      "r.rule LIKE 'queue=%'",
    ];
    if (pipeline) {
      conditions.push(`p.name = '${pipeline.replace(/'/g, "''")}'`);
    }
    if (queue) {
      conditions.push(`SUBSTRING(r.rule, 7) = '${queue.replace(/'/g, "''")}'`);
    }
    if (startDate) {
      conditions.push(`b.created_at >= '${startDate.replace(/'/g, "''")}'`);
    }
    if (endDate) {
      conditions.push(`b.created_at < DATE_ADD('${endDate.replace(/'/g, "''")}', 1)`);
    }
    const where = conditions.join(" AND ");
    const hasDateRange = startDate || endDate;
    const recencyHaving = hasDateRange
      ? ""
      : "\n        HAVING MAX(b.created_at) >= CURRENT_DATE - INTERVAL 7 DAY";

    const joinClause = `
      FROM vllm_data_warehouse.buildkite.build_job AS j
      INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
      INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
      INNER JOIN vllm_data_warehouse.buildkite.build_job_agent_query_rule AS r ON j.id = r.build_job_id
    `;

    // Pick interval based on date range span
    let hourSpan = 14 * 24;
    if (startDate && endDate) {
      hourSpan = Math.max(1, Math.round(
        (new Date(endDate).getTime() - new Date(startDate).getTime()) / 3600000
      ));
    }

    let timeBucketExpr: string;
    if (hourSpan <= 6) {
      // 5-minute buckets
      timeBucketExpr = `DATE_TRUNC('MINUTE', j.started_at) - MAKE_INTERVAL(0, 0, 0, 0, 0, MINUTE(j.started_at) % 5, 0)`;
    } else if (hourSpan <= 24) {
      // 15-minute buckets
      timeBucketExpr = `DATE_TRUNC('MINUTE', j.started_at) - MAKE_INTERVAL(0, 0, 0, 0, 0, MINUTE(j.started_at) % 15, 0)`;
    } else if (hourSpan <= 3 * 24) {
      // 1-hour buckets
      timeBucketExpr = `DATE_TRUNC('HOUR', j.started_at)`;
    } else if (hourSpan <= 7 * 24) {
      // 3-hour buckets
      timeBucketExpr = `DATE_TRUNC('HOUR', j.started_at) - MAKE_INTERVAL(0, 0, 0, 0, HOUR(j.started_at) % 3, 0, 0)`;
    } else if (hourSpan <= 14 * 24) {
      // 6-hour buckets
      timeBucketExpr = `DATE_TRUNC('HOUR', j.started_at) - MAKE_INTERVAL(0, 0, 0, 0, HOUR(j.started_at) % 6, 0, 0)`;
    } else if (hourSpan <= 30 * 24) {
      // 1-day buckets
      timeBucketExpr = `DATE_TRUNC('DAY', j.started_at)`;
    } else {
      // 1-week buckets
      timeBucketExpr = `DATE_TRUNC('WEEK', j.started_at)`;
    }

    const [queueStats, dailyWaitTime, queueNames] = await Promise.all([
      // Per-queue summary
      queryDatabricks(`
        SELECT
          SUBSTRING(r.rule, 7) AS queue,
          COUNT(*) AS total_jobs,
          ROUND(AVG(TIMESTAMPDIFF(SECOND, j.runnable_at, j.started_at))) AS avg_wait,
          ROUND(PERCENTILE(TIMESTAMPDIFF(SECOND, j.runnable_at, j.started_at), 0.5)) AS p50_wait,
          ROUND(PERCENTILE(TIMESTAMPDIFF(SECOND, j.runnable_at, j.started_at), 0.9)) AS p90_wait,
          ROUND(MAX(TIMESTAMPDIFF(SECOND, j.runnable_at, j.started_at))) AS max_wait
        ${joinClause}
        WHERE ${where}
        GROUP BY SUBSTRING(r.rule, 7)${recencyHaving}
        ORDER BY p50_wait DESC
      `),
      // Wait time trend with adaptive intervals (per queue)
      queryDatabricks(`
        SELECT
          ${timeBucketExpr} AS time_bucket,
          SUBSTRING(r.rule, 7) AS queue,
          ROUND(PERCENTILE(TIMESTAMPDIFF(SECOND, j.runnable_at, j.started_at), 0.5)) AS p50_wait,
          ROUND(PERCENTILE(TIMESTAMPDIFF(SECOND, j.runnable_at, j.started_at), 0.9)) AS p90_wait,
          COUNT(*) AS total_jobs
        ${joinClause}
        WHERE ${where}
        GROUP BY time_bucket, SUBSTRING(r.rule, 7)
        ORDER BY time_bucket
      `),
      // Distinct queue names for filter
      queryDatabricks(`
        SELECT DISTINCT SUBSTRING(r.rule, 7) AS queue
        FROM vllm_data_warehouse.buildkite.build_job_agent_query_rule AS r
        WHERE r._fivetran_deleted = false AND r.rule LIKE 'queue=%'
        ORDER BY queue
      `),
    ]);

    const result = {
      queueStats,
      dailyWaitTime,
      queueNames: queueNames.map((q) => (q as Record<string, string>).queue),
    };
    setCache(cacheKey, result, TTL);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch queue data:", error);
    return NextResponse.json(
      { error: "Failed to fetch queue data" },
      { status: 500 }
    );
  }
}
