import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";

const TTL = 60_000;

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

    const cacheKey = `jobs:runs:${jobName}:${pipeline}:${branch}:${startDate}:${endDate}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    const conditions = [
      "j._fivetran_deleted = false",
      "j.type = 'script'",
      `j.name = '${jobName.replace(/'/g, "''")}'`,
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

    const runs = await queryDatabricks(`
      SELECT
        j.id AS job_id,
        j.web_url,
        j.state,
        j.started_at,
        j.finished_at,
        TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at) AS duration_secs,
        b.commit AS commit_sha,
        b.created_at AS build_created_at
      FROM vllm_data_warehouse.buildkite.build_job AS j
      INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
      INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
      WHERE ${conditions.join(" AND ")}
        AND j.state IN ('passed', 'failed', 'failing', 'broken', 'timed_out')
      ORDER BY b.created_at ASC
    `);

    const result = { runs };
    setCache(cacheKey, result, TTL);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch job runs:", error);
    return NextResponse.json(
      { error: "Failed to fetch job runs" },
      { status: 500 }
    );
  }
}
