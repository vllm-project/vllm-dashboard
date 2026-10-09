import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getOrLoadCached } from "@/lib/api-cache";
import { ServerTiming } from "@/lib/server-timing";
import { cachedJson } from "@/lib/api-response";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { queryJobStatsFromOtel } from "@/lib/otel-ci";
import { SHARD_SUFFIX_SQL, SHARD_TOTAL_SQL } from "@/lib/job-shards";
import {
  ensureOptionalJobMatcher,
  ensureSoftFailJobMatcher,
  isOptionalJob,
  isSoftFailJob,
} from "@/lib/test-areas";

const TTL = 60_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };

// A relative window (window=14d) keeps the default view's URL stable across
// days, so CDN entries survive the midnight date rollover and
// stale-while-revalidate serves every request instantly. Explicit start/end
// dates take precedence and keep the old per-day cache keys.
function parseWindowDays(value: string | null): number | null {
  const match = value?.match(/^(\d{1,3})d$/);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  return days >= 1 && days <= 90 ? days : null;
}

export async function GET(request: NextRequest) {
  const timing = new ServerTiming();
  try {
    const source = resolveCiDataSource(request);
    timing.describe("source", source);
    const searchParams = request.nextUrl.searchParams;
    const pipeline = searchParams.get("pipeline") || "CI";
    const branch = searchParams.get("branch") || "main";
    let startDate = searchParams.get("startDate");
    let endDate = searchParams.get("endDate");
    const windowDays =
      startDate || endDate ? null : parseWindowDays(searchParams.get("window"));
    if (windowDays !== null) {
      const end = new Date();
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - windowDays);
      startDate = start.toISOString().slice(0, 10);
      endDate = end.toISOString().slice(0, 10);
    }
    const rangeKey =
      windowDays !== null ? `window:${windowDays}d` : `${startDate}:${endDate}`;

    const cacheKey = `jobs:${pipeline}:${branch}:${rangeKey}:${source}`;
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
        : "\n          AND MAX(build_created_at) >= CURRENT_DATE - INTERVAL 7 DAY";

      // One row per run of a step: a job, or the shards of a runtime-sharded
      // step in one build (see job-shards.ts). Attempt k of a step is the k-th
      // attempt of each of its jobs, so a retried shard is another run, as a
      // retried job is. A run fails if any of its jobs failed; its duration is
      // its slowest job's (shards wait for agents apart, so first start to
      // last finish would count queue time), kept only when every shard ran.
      const stepRuns = `
        WITH jobs AS (
          SELECT
            b.id AS build_id,
            b.created_at AS build_created_at,
            regexp_replace(j.name, '${SHARD_SUFFIX_SQL}', '') AS name,
            CAST(NULLIF(regexp_extract(j.name, '${SHARD_TOTAL_SQL}', 1), '') AS INT) AS shard_total,
            j.state,
            j.soft_failed,
            j.started_at,
            j.finished_at,
            ROW_NUMBER() OVER (PARTITION BY b.id, j.name ORDER BY j.started_at, j.id) AS attempt
          FROM vllm_data_warehouse.buildkite.build_job AS j
          INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
          INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
          WHERE ${where}
            AND j.state IN ('passed', 'failed', 'failing', 'broken', 'timed_out')
        ),
        step_runs AS (
          SELECT
            name,
            MAX(build_created_at) AS build_created_at,
            MAX(CASE WHEN state IN ('failed', 'failing', 'broken', 'timed_out') THEN 1 ELSE 0 END) AS failed,
            MAX(CASE WHEN soft_failed = 'true' THEN 1 ELSE 0 END) AS soft_failed,
            CASE WHEN COUNT(*) = COALESCE(MAX(shard_total), 1)
              AND COUNT(started_at) = COUNT(*) AND COUNT(finished_at) = COUNT(*)
              THEN MAX(TIMESTAMPDIFF(SECOND, started_at, finished_at)) END AS whole_duration
          FROM jobs
          GROUP BY build_id, name, attempt
        )`;

      const queries = await Promise.allSettled([
        timing.measure("failures", queryDatabricks(`${stepRuns}
          SELECT
            name,
            COUNT(*) AS total_runs,
            SUM(failed) AS failures,
            SUM(1 - failed) AS passes,
            ROUND(100.0 * SUM(failed) / NULLIF(COUNT(*), 0), 1) AS failure_rate,
            MAX(soft_failed) AS has_soft_fail
          FROM step_runs
          GROUP BY name
          HAVING SUM(failed) > 0${recencyHaving}
          ORDER BY failure_rate DESC, failures DESC
        `)),
        timing.measure("duration", queryDatabricks(`${stepRuns}
          SELECT
            name,
            COUNT(*) AS total_runs,
            ROUND(AVG(whole_duration)) AS avg_duration,
            ROUND(PERCENTILE(whole_duration, 0.5)) AS p50_duration,
            ROUND(PERCENTILE(whole_duration, 0.9)) AS p90_duration,
            ROUND(MAX(whole_duration)) AS max_duration
          FROM step_runs
          WHERE failed = 0 AND whole_duration IS NOT NULL
          GROUP BY name
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
    // Annotate rows from the pipeline YAML's `optional` and `soft_fail` steps.
    // Done per request (not cached) so the 1h matcher refresh applies without
    // waiting for the job-stats cache to expire, and so it covers both data
    // sources.
    const [optionalMatcher, softFailMatcher] = await Promise.all([
      ensureOptionalJobMatcher(),
      ensureSoftFailJobMatcher(),
    ]);
    const annotate = (rows: Record<string, unknown>[]) =>
      rows.map((row) => {
        const name = typeof row.name === "string" ? row.name : null;
        return {
          ...row,
          is_optional: name && isOptionalJob(name, optionalMatcher) ? "1" : "0",
          is_soft_fail: name && isSoftFailJob(name, softFailMatcher) ? "1" : "0",
        };
      });
    const data = {
      failureRanking: annotate(result.failureRanking),
      durationStats: annotate(result.durationStats),
    };
    const response = cachedJson(data, CDN_CACHE);
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
