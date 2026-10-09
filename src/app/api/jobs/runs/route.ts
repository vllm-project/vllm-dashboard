import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { queryJobRunsFromOtel } from "@/lib/otel-ci";
import { SHARD_SUFFIX_SQL, SHARD_TOTAL_SQL } from "@/lib/job-shards";

const TTL = 60_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const jobName = searchParams.get("jobName");
    const pipeline = searchParams.get("pipeline") || "CI";
    const branch = searchParams.get("branch") || "main";
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    if (!jobName) {
      return NextResponse.json({ error: "jobName is required" }, { status: 400 });
    }

    const cacheKey = `jobs:runs:${jobName}:${pipeline}:${branch}:${startDate}:${endDate}:${resolveCiDataSource(request)}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    if (resolveCiDataSource(request) === "otel") {
      const runs = await queryJobRunsFromOtel({
        jobName,
        pipeline,
        branch,
        startDate,
        endDate,
      });
      const result = { runs };
      setCache(cacheKey, result, TTL);
      return cachedJson(result, CDN_CACHE);
    }

    const name = jobName.replace(/'/g, "''");
    const conditions = [
      "j._fivetran_deleted = false",
      "j.type = 'script'",
      // The job itself, or a runtime shard of the step (see job-shards.ts).
      // LIKE only narrows the scan: a wildcard in the name over-matches, and
      // the exact comparison decides.
      `(j.name = '${name}' OR (j.name LIKE '${name} shard %'
        AND regexp_replace(j.name, '${SHARD_SUFFIX_SQL}', '') = '${name}'))`,
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

    // One run per build and attempt: a sharded step's shards are one run
    // that links to its first failing shard, else to shard 1, and lasts as
    // long as its slowest shard.
    const runs = await queryDatabricks(`
      WITH jobs AS (
        SELECT
          j.id,
          j.web_url,
          j.state,
          j.started_at,
          j.finished_at,
          b.id AS build_id,
          b.commit,
          b.created_at,
          CAST(NULLIF(regexp_extract(j.name, '${SHARD_TOTAL_SQL}', 1), '') AS INT) AS shard_total,
          CONCAT(CASE WHEN j.state = 'passed' THEN '1' ELSE '0' END, j.name) AS pick,
          ROW_NUMBER() OVER (PARTITION BY b.id, j.name ORDER BY j.started_at, j.id) AS attempt
        FROM vllm_data_warehouse.buildkite.build_job AS j
        INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
        INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
        WHERE ${conditions.join(" AND ")}
          AND j.state IN ('passed', 'failed', 'failing', 'broken', 'timed_out')
      )
      SELECT
        MIN_BY(id, pick) AS job_id,
        MIN_BY(web_url, pick) AS web_url,
        MIN_BY(state, pick) AS state,
        MIN(started_at) AS started_at,
        MAX(finished_at) AS finished_at,
        MAX(TIMESTAMPDIFF(SECOND, started_at, finished_at)) AS duration_secs,
        COUNT(*) AS jobs,
        MAX(shard_total) AS shards,
        MAX(commit) AS commit_sha,
        MAX(created_at) AS build_created_at
      FROM jobs
      GROUP BY build_id, attempt
      ORDER BY build_created_at ASC, started_at ASC
    `);

    const result = { runs };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch job runs:", error);
    return NextResponse.json(
      { error: "Failed to fetch job runs" },
      { status: 500 }
    );
  }
}
