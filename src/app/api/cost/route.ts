import { NextRequest, NextResponse } from "next/server";
import { queryClickHouse } from "@/lib/clickhouse";
import { getQueueCost } from "@/lib/queue-costs";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { enrichBuildAuthors } from "@/lib/github-build-authors";
import { queryCostFromOtel } from "@/lib/otel-ci";

export const maxDuration = 55;
const TTL = 60_000;
const CDN_CACHE = { maxAge: 120, staleWhileRevalidate: 3_600 };

// ClickHouse returns numeric columns as strings; Postgres returns numbers.
function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const pipeline = searchParams.get("pipeline");
    const branch = searchParams.get("branch");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const cacheKey = `cost:${pipeline}:${branch}:${startDate}:${endDate}:${resolveCiDataSource(request)}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    let byQueue: Record<string, unknown>[];
    let dailyCost: Record<string, unknown>[];
    let byBuildRaw: Record<string, unknown>[];
    let byJobRaw: Record<string, unknown>[];

    if (resolveCiDataSource(request) === "otel") {
      const raw = await queryCostFromOtel({ pipeline, branch, startDate, endDate });
      byQueue = raw.byQueue;
      dailyCost = raw.dailyCost;
      byBuildRaw = raw.byBuild;
      byJobRaw = raw.byJob;
    } else {
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

    // Builds, then their jobs, then those jobs' queue rules: each table is
    // sorted by its parent's id, so every IN list prunes the next scan.
    // Run time truncates to whole seconds, like TIMESTAMPDIFF did.
    const runs = (buildColumns: string) => `
      WITH builds AS (
        SELECT ${buildColumns}
        FROM buildkite.build FINAL
        WHERE ${buildConditions.join("\n          AND ")}
      ),
      jobs AS (
        SELECT j.id AS id, j.build_id AS build_id, j.name AS job_name,
          intDiv(toUnixTimestamp64Milli(j.finished_at) - toUnixTimestamp64Milli(j.started_at), 1000) AS secs
        FROM buildkite.build_job AS j FINAL
        WHERE j.build_id IN (SELECT id FROM builds)
          AND NOT j._fivetran_deleted
          AND j.type = 'script'
          AND j.started_at IS NOT NULL
          AND j.finished_at IS NOT NULL
      ),
      runs AS (
        SELECT j.id AS id, j.build_id AS build_id, j.job_name AS job_name, j.secs AS secs,
          substring(r.rule, 7) AS queue
        FROM buildkite.build_job_agent_query_rule AS r FINAL
        INNER JOIN jobs AS j ON r.build_job_id = j.id
        WHERE r.build_job_id IN (SELECT id FROM jobs)
          AND NOT r._fivetran_deleted
          AND r.rule LIKE 'queue=%'
      )`;
    // ROUND in Databricks rounded half up; ClickHouse rounds floats half to
    // even, so round the exact Decimal hours.
    const hours = (digits: number) => `toFloat64(round(toDecimal128(sum(secs), 6) / 3600, ${digits}))`;

    const [byQueueResult, dailyCostResult, byBuildResult, byJobResult] = await Promise.allSettled([
      queryClickHouse(`${runs("id")}
        SELECT
          queue,
          count() AS total_jobs,
          ${hours(2)} AS total_hours
        FROM runs
        GROUP BY queue
        ORDER BY total_hours DESC
      `, params),
      queryClickHouse(`${runs("id, created_at")}
        SELECT
          toDate(b.created_at) AS date,
          queue,
          ${hours(2)} AS total_hours
        FROM runs
        INNER JOIN builds AS b ON runs.build_id = b.id
        GROUP BY date, queue
        ORDER BY date
      `, params),
      // Top 100 builds by compute hours (no queue dimension = fast)
      queryClickHouse(`${runs("id, web_url, message, commit, branch, github_author_username, created_at")}
        SELECT
          b.id AS build_id,
          any(b.web_url) AS build_url,
          any(b.message) AS message,
          any(b.commit) AS commit_sha,
          any(b.branch) AS branch,
          any(b.github_author_username) AS author,
          any(b.created_at) AS created_at,
          count() AS total_jobs,
          ${hours(4)} AS total_hours
        FROM runs
        INNER JOIN builds AS b ON runs.build_id = b.id
        GROUP BY b.id
        ORDER BY total_hours DESC
        LIMIT 100
      `, params),
      // Cost per job (grouped by job name + queue for accurate costing)
      queryClickHouse(`${runs("id")}
        SELECT
          job_name,
          queue,
          count() AS total_runs,
          ${hours(4)} AS total_hours
        FROM runs
        GROUP BY job_name, queue
      `, params),
    ]);

    byQueue = byQueueResult.status === "fulfilled" ? byQueueResult.value : [];
    dailyCost = dailyCostResult.status === "fulfilled" ? dailyCostResult.value : [];
    byBuildRaw = await enrichBuildAuthors(
      byBuildResult.status === "fulfilled" ? byBuildResult.value : [],
    );
    byJobRaw = byJobResult.status === "fulfilled" ? byJobResult.value : [];
    }

    const queueWithCost = byQueue.map((row) => {
      const q = row as Record<string, unknown>;
      const pricing = getQueueCost(q.queue as string);
      const totalHours = toNumber(q.total_hours);
      return {
        queue: q.queue,
        total_jobs: q.total_jobs,
        total_hours: totalHours,
        instance_type: pricing?.instanceType ?? null,
        cost_per_hour: pricing?.costPerHour ?? null,
        total_cost: pricing ? Math.round(totalHours * pricing.costPerHour * 100) / 100 : null,
      };
    });

    const dailyCostByQueue = (dailyCost as Record<string, unknown>[]).map((r) => {
      const hours = toNumber(r.total_hours);
      const pricing = getQueueCost(r.queue as string);
      return {
        date: r.date,
        queue: r.queue,
        total_hours: Math.round(hours * 100) / 100,
        total_cost: pricing ? Math.round(hours * pricing.costPerHour * 100) / 100 : 0,
      };
    });

    // Compute blended cost rate from byQueue data for build cost estimation
    const pricedHours = queueWithCost.reduce(
      (s, q) => s + (q.total_cost !== null ? q.total_hours : 0), 0
    );
    const pricedCost = queueWithCost.reduce(
      (s, q) => s + (q.total_cost ?? 0), 0
    );
    const blendedRate = pricedHours > 0 ? pricedCost / pricedHours : 0;

    const byBuild = (byBuildRaw as Record<string, unknown>[])
      .map((r) => {
        const hours = toNumber(r.total_hours);
        return {
          build_id: r.build_id,
          build_url: r.build_url,
          message: r.message,
          commit_sha: r.commit_sha,
          branch: r.branch,
          author: r.author,
          created_at: r.created_at,
          total_hours: Math.round(hours * 100) / 100,
          total_cost: Math.round(hours * blendedRate * 100) / 100,
          total_jobs: toNumber(r.total_jobs),
        };
      })
      .sort((a, b) => b.total_cost - a.total_cost);

    // Aggregate cost per job
    const jobAgg = new Map<string, {
      job_name: string; total_runs: number; total_hours: number; total_cost: number;
    }>();
    for (const row of byJobRaw) {
      const r = row as Record<string, unknown>;
      const hours = toNumber(r.total_hours);
      const runs = toNumber(r.total_runs);
      const pricing = getQueueCost(r.queue as string);
      const cost = pricing ? hours * pricing.costPerHour : hours * blendedRate;
      if (!jobAgg.has(r.job_name as string)) {
        jobAgg.set(r.job_name as string, { job_name: r.job_name as string, total_runs: 0, total_hours: 0, total_cost: 0 });
      }
      const entry = jobAgg.get(r.job_name as string)!;
      entry.total_runs += runs;
      entry.total_hours += hours;
      entry.total_cost += cost;
    }
    const byJob = [...jobAgg.values()]
      .map((j) => ({
        ...j,
        total_hours: Math.round(j.total_hours * 100) / 100,
        total_cost: Math.round(j.total_cost * 100) / 100,
        avg_cost: j.total_runs > 0 ? Math.round((j.total_cost / j.total_runs) * 100) / 100 : 0,
      }))
      .sort((a, b) => b.total_cost - a.total_cost);

    const result = {
      byQueue: queueWithCost,
      dailyCostByQueue,
      byBuild,
      byJob,
    };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch cost data:", error);
    return NextResponse.json(
      { error: "Failed to fetch cost data" },
      { status: 500 },
    );
  }
}
