import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getQueueCost } from "@/lib/queue-costs";
import { getCached, setCache } from "@/lib/api-cache";

export const maxDuration = 55;
const TTL = 60_000;

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const pipeline = searchParams.get("pipeline");
    const branch = searchParams.get("branch");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const cacheKey = `cost:${pipeline}:${branch}:${startDate}:${endDate}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    const conditions = [
      "j._fivetran_deleted = false",
      "j.type = 'script'",
      "j.started_at IS NOT NULL",
      "j.finished_at IS NOT NULL",
      "b._fivetran_deleted = false",
      "r.rule LIKE 'queue=%'",
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

    const joinClause = `
      FROM vllm_data_warehouse.buildkite.build_job AS j
      INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
      INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
      INNER JOIN vllm_data_warehouse.buildkite.build_job_agent_query_rule AS r ON j.id = r.build_job_id
    `;

    const [byQueueResult, dailyCostResult, byBuildResult, byJobResult] = await Promise.allSettled([
      queryDatabricks(`
        SELECT
          SUBSTRING(r.rule, 7) AS queue,
          COUNT(*) AS total_jobs,
          ROUND(SUM(TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at)) / 3600.0, 2) AS total_hours
        ${joinClause}
        WHERE ${where}
        GROUP BY SUBSTRING(r.rule, 7)
        ORDER BY total_hours DESC
      `),
      queryDatabricks(`
        SELECT
          DATE(b.created_at) AS date,
          SUBSTRING(r.rule, 7) AS queue,
          ROUND(SUM(TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at)) / 3600.0, 2) AS total_hours
        ${joinClause}
        WHERE ${where}
        GROUP BY DATE(b.created_at), SUBSTRING(r.rule, 7)
        ORDER BY date
      `),
      // Top 100 builds by compute hours (no queue dimension = fast)
      queryDatabricks(`
        SELECT
          b.id AS build_id,
          b.web_url AS build_url,
          b.message,
          b.commit AS commit_sha,
          b.branch,
          b.github_author_username AS author,
          b.created_at,
          COUNT(*) AS total_jobs,
          ROUND(SUM(TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at)) / 3600.0, 4) AS total_hours
        ${joinClause}
        WHERE ${where}
        GROUP BY b.id, b.web_url, b.message, b.commit, b.branch, b.github_author_username, b.created_at
        ORDER BY total_hours DESC
        LIMIT 100
      `),
      // Cost per job (grouped by job name + queue for accurate costing)
      queryDatabricks(`
        SELECT
          j.name AS job_name,
          SUBSTRING(r.rule, 7) AS queue,
          COUNT(*) AS total_runs,
          ROUND(SUM(TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at)) / 3600.0, 4) AS total_hours
        ${joinClause}
        WHERE ${where}
        GROUP BY j.name, SUBSTRING(r.rule, 7)
      `),
    ]);

    const byQueue = byQueueResult.status === "fulfilled" ? byQueueResult.value : [];
    const dailyCost = dailyCostResult.status === "fulfilled" ? dailyCostResult.value : [];
    const byBuildRaw = byBuildResult.status === "fulfilled" ? byBuildResult.value : [];
    const byJobRaw = byJobResult.status === "fulfilled" ? byJobResult.value : [];

    const queueWithCost = byQueue.map((row) => {
      const q = row as Record<string, string>;
      const pricing = getQueueCost(q.queue);
      const totalHours = parseFloat(q.total_hours) || 0;
      return {
        queue: q.queue,
        total_jobs: q.total_jobs,
        total_hours: totalHours,
        instance_type: pricing?.instanceType ?? null,
        cost_per_hour: pricing?.costPerHour ?? null,
        total_cost: pricing ? Math.round(totalHours * pricing.costPerHour * 100) / 100 : null,
      };
    });

    const dailyCostByQueue = (dailyCost as Record<string, string>[]).map((r) => {
      const hours = parseFloat(r.total_hours) || 0;
      const pricing = getQueueCost(r.queue);
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

    const byBuild = (byBuildRaw as Record<string, string>[])
      .map((r) => {
        const hours = parseFloat(r.total_hours) || 0;
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
          total_jobs: parseInt(r.total_jobs, 10) || 0,
        };
      })
      .sort((a, b) => b.total_cost - a.total_cost);

    // Aggregate cost per job
    const jobAgg = new Map<string, {
      job_name: string; total_runs: number; total_hours: number; total_cost: number;
    }>();
    for (const row of byJobRaw) {
      const r = row as Record<string, string>;
      const hours = parseFloat(r.total_hours) || 0;
      const runs = parseInt(r.total_runs, 10) || 0;
      const pricing = getQueueCost(r.queue);
      const cost = pricing ? hours * pricing.costPerHour : hours * blendedRate;
      if (!jobAgg.has(r.job_name)) {
        jobAgg.set(r.job_name, { job_name: r.job_name, total_runs: 0, total_hours: 0, total_cost: 0 });
      }
      const entry = jobAgg.get(r.job_name)!;
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

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch cost data:", error);
    return NextResponse.json(
      { error: "Failed to fetch cost data" },
      { status: 500 },
    );
  }
}
