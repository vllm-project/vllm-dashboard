import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getOrLoadCached } from "@/lib/api-cache";
import { ServerTiming } from "@/lib/server-timing";
import { cachedJson } from "@/lib/api-response";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { queryJobStatsFromOtel } from "@/lib/otel-ci";

const TTL = 60_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };

export async function GET(request: NextRequest) {
  const timing = new ServerTiming();
  try {
    const source = resolveCiDataSource(request);
    timing.describe("source", source);
    const searchParams = request.nextUrl.searchParams;
    const pipeline = searchParams.get("pipeline") || "CI";
    const branch = searchParams.get("branch") || "main";
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const cacheKey = `jobs:${pipeline}:${branch}:${startDate}:${endDate}:${source}`;
    const { data: result, status } = await getOrLoadCached(cacheKey, TTL, async () => {
      if (source === "otel") {
        return timing.measure("backend", queryJobStatsFromOtel({
          pipeline,
          branch,
          startDate,
          endDate,
          hasDateRange: Boolean(startDate || endDate),
        }, timing));
      }

      const conditions = [
        "j._fivetran_deleted = false",
        "j.type = 'script'",
        "j.name IS NOT NULL",
        "b._fivetran_deleted = false",
      ];
      if (pipeline) {
        conditions.push(`p.name = '${pipeline.replace(/'/g, "''")}'`);
      }
      if (branch) {
        conditions.push(`b.branch = '${branch.replace(/'/g, "''")}'`);
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
        : "\n          AND MAX(b.created_at) >= CURRENT_DATE - INTERVAL 7 DAY";

      const queries = await Promise.allSettled([
        timing.measure("failures", queryDatabricks(`
          SELECT
            j.name,
            COUNT(*) AS total_runs,
            SUM(CASE WHEN j.state IN ('failed', 'failing', 'broken', 'timed_out') THEN 1 ELSE 0 END) AS failures,
            SUM(CASE WHEN j.state = 'passed' THEN 1 ELSE 0 END) AS passes,
            ROUND(
              100.0 * SUM(CASE WHEN j.state IN ('failed', 'failing', 'broken', 'timed_out') THEN 1 ELSE 0 END)
              / NULLIF(SUM(CASE WHEN j.state IN ('passed', 'failed', 'failing', 'broken', 'timed_out') THEN 1 ELSE 0 END), 0),
              1
            ) AS failure_rate,
            MAX(CASE WHEN j.soft_failed = 'true' THEN 1 ELSE 0 END) AS has_soft_fail
          FROM vllm_data_warehouse.buildkite.build_job AS j
          INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
          INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
          WHERE ${where}
            AND j.state IN ('passed', 'failed', 'failing', 'broken', 'timed_out')
          GROUP BY j.name
          HAVING SUM(CASE WHEN j.state IN ('failed', 'failing', 'broken', 'timed_out') THEN 1 ELSE 0 END) > 0${recencyHaving}
          ORDER BY failure_rate DESC, failures DESC
        `)),
        timing.measure("duration", queryDatabricks(`
          SELECT
            j.name,
            COUNT(*) AS total_runs,
            ROUND(AVG(TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at))) AS avg_duration,
            ROUND(PERCENTILE(TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at), 0.5)) AS p50_duration,
            ROUND(PERCENTILE(TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at), 0.9)) AS p90_duration,
            ROUND(MAX(TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at))) AS max_duration
          FROM vllm_data_warehouse.buildkite.build_job AS j
          INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
          INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
          WHERE ${where}
            AND j.started_at IS NOT NULL
            AND j.finished_at IS NOT NULL
            AND j.state = 'passed'
          GROUP BY j.name
          HAVING COUNT(*) > 0${recencyHaving}
          ORDER BY p50_duration DESC
        `)),
      ]);

      // A failed query must not release the shared fill while its sibling
      // still consumes backend capacity, or retries can multiply that work.
      const [failureRanking, durationStats] = queries.map((query) => {
        if (query.status === "rejected") throw query.reason;
        return query.value;
      });
      return { failureRanking, durationStats };
    });
    timing.describe("cache", status);
    const response = cachedJson(result, CDN_CACHE);
    response.headers.set("Server-Timing", timing.header());
    return response;
  } catch (error) {
    timing.describe("cache", "ERROR");
    console.error("Failed to fetch job stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch job statistics" },
      { status: 500, headers: { "Server-Timing": timing.header() } }
    );
  }
}
