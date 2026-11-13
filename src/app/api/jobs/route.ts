import { NextRequest, NextResponse } from "next/server";
import { queryClickHouse } from "@/lib/clickhouse";
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

      const params: Record<string, string> = {};
      const buildConditions = ["NOT _fivetran_deleted"];
      if (pipeline) {
        params.pipeline = pipeline;
        buildConditions.push(`pipeline_id IN (
            SELECT id FROM buildkite.pipeline FINAL
            WHERE NOT _fivetran_deleted AND name = {pipeline:String})`);
      }
      if (branch) {
        params.branch = branch;
        buildConditions.push("branch = {branch:String}");
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
      const hasDateRange = startDate || endDate;
      const recencyHaving = hasDateRange
        ? ""
        : "\n          AND max(build_created_at) >= toStartOfDay(now('UTC')) - INTERVAL 7 DAY";

      // One row per run of a step: a job, or the shards of a runtime-sharded
      // step in one build (see job-shards.ts). Attempt k of a step is the k-th
      // attempt of each of its jobs, so a retried shard is another run, as a
      // retried job is. A run fails if any of its jobs failed; its duration is
      // its slowest job's (shards wait for agents apart, so first start to
      // last finish would count queue time), kept only when every shard ran.
      // Builds are filtered first: build_job is sorted by build_id, so the IN
      // list prunes it before FINAL deduplicates the Fivetran versions.
      // Durations truncate to whole seconds, like TIMESTAMPDIFF did.
      const stepRuns = `
        WITH builds AS (
          SELECT id, created_at
          FROM buildkite.build FINAL
          WHERE ${buildConditions.join("\n            AND ")}
        ),
        jobs AS (
          SELECT
            j.build_id AS build_id,
            b.created_at AS build_created_at,
            replaceRegexpOne(j.name, '${SHARD_SUFFIX_SQL}', '') AS name,
            toInt32OrNull(extract(j.name, '${SHARD_TOTAL_SQL}')) AS shard_total,
            j.state AS state,
            j.soft_failed AS soft_failed,
            j.started_at AS started_at,
            j.finished_at AS finished_at,
            row_number() OVER (PARTITION BY j.build_id, j.name ORDER BY j.started_at ASC NULLS FIRST, j.id) AS attempt
          FROM buildkite.build_job AS j FINAL
          INNER JOIN builds AS b ON j.build_id = b.id
          WHERE j.build_id IN (SELECT id FROM builds)
            AND NOT j._fivetran_deleted
            AND j.type = 'script'
            AND j.name IS NOT NULL
            AND j.state IN ('passed', 'failed', 'failing', 'broken', 'timed_out')
        ),
        step_runs AS (
          SELECT
            name,
            max(build_created_at) AS build_created_at,
            max(if(state IN ('failed', 'failing', 'broken', 'timed_out'), 1, 0)) AS failed,
            max(if(coalesce(soft_failed, false), 1, 0)) AS step_soft_failed,
            if(count() = coalesce(max(shard_total), 1)
              AND count(started_at) = count() AND count(finished_at) = count(),
              max(intDiv(toUnixTimestamp64Milli(finished_at) - toUnixTimestamp64Milli(started_at), 1000)),
              NULL) AS whole_duration
          FROM jobs
          GROUP BY build_id, name, attempt
        )`;

      // ROUND in Databricks rounded half up; ClickHouse rounds floats half to
      // even, so round through Decimal.
      const roundWhole = (expr: string) => `toInt64(round(toDecimal128(${expr}, 9), 0))`;
      const queries = await Promise.allSettled([
        timing.measure("failures", queryClickHouse(`${stepRuns}
          SELECT
            name,
            count() AS total_runs,
            sum(failed) AS failures,
            sum(1 - failed) AS passes,
            toDecimalString(round(toDecimal128(100 * sum(failed), 9) / count(), 1), 1) AS failure_rate,
            max(step_soft_failed) AS has_soft_fail
          FROM step_runs
          GROUP BY name
          HAVING sum(failed) > 0${recencyHaving}
          ORDER BY round(toDecimal128(100 * sum(failed), 9) / count(), 1) DESC, failures DESC
        `, params)),
        timing.measure("duration", queryClickHouse(`${stepRuns}
          SELECT
            name,
            count() AS total_runs,
            ${roundWhole("avg(whole_duration)")} AS avg_duration,
            ${roundWhole("quantileExactInclusive(0.5)(whole_duration)")} AS p50_duration,
            ${roundWhole("quantileExactInclusive(0.9)(whole_duration)")} AS p90_duration,
            max(whole_duration) AS max_duration
          FROM step_runs
          WHERE failed = 0 AND whole_duration IS NOT NULL
          GROUP BY name
          HAVING count() > 0${recencyHaving}
          ORDER BY p50_duration DESC
        `, params)),
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
