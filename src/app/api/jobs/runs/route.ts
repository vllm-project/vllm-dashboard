import { NextRequest, NextResponse } from "next/server";
import { queryClickHouse } from "@/lib/clickhouse";
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

    const params: Record<string, string> = { jobName };
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

    // One run per build and attempt: a sharded step's shards are one run
    // that links to its first failing shard, else to shard 1, and lasts as
    // long as its slowest shard. argMin over a tuple keeps the picked job's
    // NULL web_url instead of skipping to another job's.
    const runs = await queryClickHouse(`
      WITH builds AS (
        SELECT id, commit, created_at
        FROM buildkite.build FINAL
        WHERE ${buildConditions.join("\n          AND ")}
      ),
      jobs AS (
        SELECT
          j.id AS job,
          j.web_url AS job_web_url,
          j.state AS job_state,
          j.started_at AS job_started_at,
          j.finished_at AS job_finished_at,
          intDiv(toUnixTimestamp64Milli(j.finished_at) - toUnixTimestamp64Milli(j.started_at), 1000) AS secs,
          j.build_id AS build_id,
          b.commit AS build_commit,
          b.created_at AS build_created,
          toInt32OrNull(extract(j.name, '${SHARD_TOTAL_SQL}')) AS shard_total,
          concat(if(j.state = 'passed', '1', '0'), j.name) AS pick,
          row_number() OVER (PARTITION BY j.build_id, j.name ORDER BY j.started_at ASC NULLS FIRST, j.id) AS attempt
        FROM buildkite.build_job AS j FINAL
        INNER JOIN builds AS b ON j.build_id = b.id
        WHERE j.build_id IN (SELECT id FROM builds)
          AND NOT j._fivetran_deleted
          AND j.type = 'script'
          -- The job itself, or a runtime shard of the step (see job-shards.ts).
          -- LIKE only narrows the scan: a wildcard in the name over-matches,
          -- and the exact comparison decides.
          AND (j.name = {jobName:String} OR (j.name LIKE concat({jobName:String}, ' _hard %')
            AND replaceRegexpOne(j.name, '${SHARD_SUFFIX_SQL}', '') = {jobName:String}))
          AND j.state IN ('passed', 'failed', 'failing', 'broken', 'timed_out')
      )
      SELECT
        argMin((job, job_web_url, job_state), pick).1 AS job_id,
        argMin((job, job_web_url, job_state), pick).2 AS web_url,
        argMin((job, job_web_url, job_state), pick).3 AS state,
        min(job_started_at) AS started_at,
        max(job_finished_at) AS finished_at,
        max(secs) AS duration_secs,
        count() AS jobs,
        max(shard_total) AS shards,
        max(build_commit) AS commit_sha,
        max(build_created) AS build_created_at
      FROM jobs
      GROUP BY build_id, attempt
      ORDER BY build_created_at ASC NULLS FIRST, started_at ASC NULLS FIRST
    `, params);

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
