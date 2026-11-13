import { NextRequest, NextResponse } from "next/server";
import { queryClickHouse } from "@/lib/clickhouse";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { queryQueueFromOtel } from "@/lib/otel-ci";

const TTL = 60_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const pipeline = searchParams.get("pipeline");
    const queue = searchParams.get("queue");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const cacheKey = `queue:${pipeline}:${queue}:${startDate}:${endDate}:${resolveCiDataSource(request)}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    if (resolveCiDataSource(request) === "otel") {
      const result = await queryQueueFromOtel({ pipeline, queue, startDate, endDate });
      setCache(cacheKey, result, TTL);
      return cachedJson(result, CDN_CACHE);
    }

    const params: Record<string, string> = {};
    const buildConditions = ["NOT _fivetran_deleted"];
    if (pipeline) {
      params.pipeline = pipeline;
      buildConditions.push(`pipeline_id IN (
          SELECT id FROM buildkite.pipeline FINAL
          WHERE NOT _fivetran_deleted AND name = {pipeline:String})`);
    }
    if (startDate) {
      params.startDate = startDate;
      buildConditions.push("created_at >= parseDateTime64BestEffort({startDate:String}, 3, 'UTC')");
    }
    if (endDate) {
      params.endDate = endDate;
      buildConditions.push(
        "created_at < toStartOfDay(parseDateTime64BestEffort({endDate:String}, 3, 'UTC')) + INTERVAL 1 DAY",
      );
    }
    const ruleConditions = ["NOT r._fivetran_deleted", "r.rule LIKE 'queue=%'"];
    if (queue) {
      params.queue = queue;
      ruleConditions.push("substring(r.rule, 7) = {queue:String}");
    }
    const hasDateRange = startDate || endDate;
    const recencyHaving = hasDateRange
      ? ""
      : "\n        HAVING max(build_created_at) >= toStartOfDay(now('UTC')) - INTERVAL 7 DAY";

    // Builds, then their jobs, then those jobs' queue rules: each table is
    // sorted by its parent's id, so every IN list prunes the next scan.
    // Waits truncate to whole seconds, like TIMESTAMPDIFF did.
    const waits = `
      WITH builds AS (
        SELECT id, created_at
        FROM buildkite.build FINAL
        WHERE ${buildConditions.join("\n          AND ")}
      ),
      jobs AS (
        SELECT j.id AS id, j.started_at AS started_at, b.created_at AS build_created_at,
          intDiv(toUnixTimestamp64Milli(j.started_at) - toUnixTimestamp64Milli(j.runnable_at), 1000) AS wait
        FROM buildkite.build_job AS j FINAL
        INNER JOIN builds AS b ON j.build_id = b.id
        WHERE j.build_id IN (SELECT id FROM builds)
          AND NOT j._fivetran_deleted
          AND j.type = 'script'
          AND j.runnable_at IS NOT NULL
          AND j.started_at IS NOT NULL
      ),
      waits AS (
        SELECT substring(r.rule, 7) AS queue, j.started_at AS started_at,
          j.build_created_at AS build_created_at, j.wait AS wait
        FROM buildkite.build_job_agent_query_rule AS r FINAL
        INNER JOIN jobs AS j ON r.build_job_id = j.id
        WHERE r.build_job_id IN (SELECT id FROM jobs)
          AND ${ruleConditions.join("\n          AND ")}
      )`;

    // Pick interval based on date range span
    let hourSpan = 14 * 24;
    if (startDate && endDate) {
      hourSpan = Math.max(1, Math.round(
        (new Date(endDate).getTime() - new Date(startDate).getTime()) / 3600000
      ));
    }

    // Buckets are UTC and aligned as Databricks' DATE_TRUNC arithmetic was.
    let timeBucketExpr: string;
    if (hourSpan <= 6) {
      timeBucketExpr = "toStartOfInterval(started_at, INTERVAL 5 MINUTE)";
    } else if (hourSpan <= 24) {
      timeBucketExpr = "toStartOfInterval(started_at, INTERVAL 15 MINUTE)";
    } else if (hourSpan <= 3 * 24) {
      timeBucketExpr = "toStartOfHour(started_at)";
    } else if (hourSpan <= 7 * 24) {
      timeBucketExpr = "toStartOfInterval(started_at, INTERVAL 3 HOUR)";
    } else if (hourSpan <= 14 * 24) {
      timeBucketExpr = "toStartOfInterval(started_at, INTERVAL 6 HOUR)";
    } else if (hourSpan <= 30 * 24) {
      timeBucketExpr = "toStartOfDay(started_at)";
    } else {
      // Weeks start on Monday.
      timeBucketExpr = "toDateTime(toMonday(started_at), 'UTC')";
    }

    // ROUND in Databricks rounded half up; ClickHouse rounds floats half to
    // even, so round through Decimal.
    const roundWhole = (expr: string) => `toInt64(round(toDecimal128(${expr}, 9), 0))`;

    const [queueStats, dailyWaitTime, queueNames] = await Promise.all([
      // Per-queue summary
      queryClickHouse(`${waits}
        SELECT
          queue,
          count() AS total_jobs,
          ${roundWhole("avg(wait)")} AS avg_wait,
          ${roundWhole("quantileExactInclusive(0.5)(wait)")} AS p50_wait,
          ${roundWhole("quantileExactInclusive(0.9)(wait)")} AS p90_wait,
          max(wait) AS max_wait
        FROM waits
        GROUP BY queue${recencyHaving}
        ORDER BY p50_wait DESC
      `, params),
      // Wait time trend with adaptive intervals (per queue)
      queryClickHouse(`${waits}
        SELECT
          ${timeBucketExpr} AS time_bucket,
          queue,
          ${roundWhole("quantileExactInclusive(0.5)(wait)")} AS p50_wait,
          ${roundWhole("quantileExactInclusive(0.9)(wait)")} AS p90_wait,
          count() AS total_jobs
        FROM waits
        GROUP BY time_bucket, queue
        ORDER BY time_bucket
      `, params),
      // Distinct queue names for filter
      queryClickHouse(`
        SELECT DISTINCT substring(rule, 7) AS queue
        FROM buildkite.build_job_agent_query_rule FINAL
        WHERE NOT _fivetran_deleted AND rule LIKE 'queue=%'
        ORDER BY queue
      `),
    ]);

    const result = {
      queueStats,
      dailyWaitTime,
      queueNames: queueNames.map((q) => (q as Record<string, string>).queue),
    };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch queue data:", error);
    return NextResponse.json(
      { error: "Failed to fetch queue data" },
      { status: 500 }
    );
  }
}
