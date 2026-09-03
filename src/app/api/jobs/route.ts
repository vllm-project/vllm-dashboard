import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { queryJobStatsFromOtel } from "@/lib/otel-ci";
import { wilsonLowerBound } from "@/lib/wilson";

const TTL = 60_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const pipeline = searchParams.get("pipeline") || "CI";
    const branch = searchParams.get("branch") || "main";
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const cacheKey = `jobs:${pipeline}:${branch}:${startDate}:${endDate}:${resolveCiDataSource(request)}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    if (resolveCiDataSource(request) === "otel") {
      const hasDateRange = Boolean(startDate || endDate);
      const result = await queryJobStatsFromOtel({
        pipeline,
        branch,
        startDate,
        endDate,
        hasDateRange,
      });
      setCache(cacheKey, result, TTL);
      return cachedJson(result, CDN_CACHE);
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
    // Daily history is capped at the 30 days leading up to the range end so
    // the response stays small; the client slices it to 30 entries too.
    const historyStart = endDate
      ? `DATE_SUB('${endDate.replace(/'/g, "''")}', 30)`
      : "CURRENT_DATE - INTERVAL 30 DAY";

    const [failureRanking, durationStats, dailyHistoryRows] = await Promise.all([
      queryDatabricks(`
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
          MAX(CASE WHEN j.soft_failed = 'true' THEN 1 ELSE 0 END) AS has_soft_fail,
          MIN(CASE WHEN j.state IN ('failed', 'failing', 'broken', 'timed_out') THEN b.created_at END) AS first_failure_at,
          MAX(CASE WHEN j.state IN ('failed', 'failing', 'broken', 'timed_out') THEN b.created_at END) AS last_failure_at,
          MAX(CASE WHEN j.state = 'passed' THEN b.created_at END) AS last_passed_at,
          MAX_BY(j.web_url, b.created_at) AS buildkite_url
        FROM vllm_data_warehouse.buildkite.build_job AS j
        INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
        INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
        WHERE ${where}
          AND j.state IN ('passed', 'failed', 'failing', 'broken', 'timed_out')
        GROUP BY j.name
        HAVING SUM(CASE WHEN j.state IN ('failed', 'failing', 'broken', 'timed_out') THEN 1 ELSE 0 END) > 0${recencyHaving}
        ORDER BY failure_rate DESC, failures DESC
      `),
      queryDatabricks(`
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
      `),
      queryDatabricks(`
        SELECT
          j.name,
          DATE_FORMAT(b.created_at, 'yyyy-MM-dd') AS date,
          SUM(CASE WHEN j.state = 'passed' THEN 1 ELSE 0 END) AS passed,
          SUM(CASE WHEN j.state IN ('failed', 'failing', 'broken', 'timed_out') THEN 1 ELSE 0 END) AS failed
        FROM vllm_data_warehouse.buildkite.build_job AS j
        INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
        INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
        WHERE ${where}
          AND j.state IN ('passed', 'failed', 'failing', 'broken', 'timed_out')
          AND b.created_at >= ${historyStart}
        GROUP BY j.name, DATE_FORMAT(b.created_at, 'yyyy-MM-dd')
      `),
    ]);

    const dailyByJob = new Map<string, { date: string; passed: number; failed: number }[]>();
    for (const row of dailyHistoryRows) {
      const name = String(row.name);
      const list = dailyByJob.get(name) ?? [];
      list.push({
        date: String(row.date),
        passed: Number(row.passed) || 0,
        failed: Number(row.failed) || 0,
      });
      dailyByJob.set(name, list);
    }

    const enrichedFailureRanking = failureRanking.map((row) => {
      const {
        first_failure_at: firstFailureAt,
        last_failure_at: lastFailureAt,
        last_passed_at: lastPassedAt,
        buildkite_url: buildkiteUrl,
        ...rest
      } = row;
      const totalRuns = Number(row.total_runs) || 0;
      const failures = Number(row.failures) || 0;
      const dailyHistory = (dailyByJob.get(String(row.name)) ?? [])
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-30);
      return {
        ...rest,
        wilsonLowerBound:
          Math.round(wilsonLowerBound(failures, totalRuns) * 1000) / 10,
        firstFailureAt: firstFailureAt ?? null,
        lastFailureAt: lastFailureAt ?? null,
        lastPassedAt: lastPassedAt ?? null,
        buildkiteUrl: buildkiteUrl ?? null,
        dailyHistory,
      };
    });

    const result = { failureRanking: enrichedFailureRanking, durationStats };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch job stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch job statistics" },
      { status: 500 }
    );
  }
}
