import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";

const TTL = 60_000;

export async function GET(request: NextRequest) {
  const queue = request.nextUrl.searchParams.get("queue");
  if (!queue) {
    return NextResponse.json({ error: "queue parameter required" }, { status: 400 });
  }

  const cacheKey = `waiting-builds:${queue}`;
  const cached = getCached(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const rows = await queryDatabricks(`
      SELECT
        w.build_number, w.build_url, w.message, w.author,
        w.waiting_jobs, w.max_wait_min,
        t.total_jobs
      FROM (
        SELECT
          b.number AS build_number,
          b.web_url AS build_url,
          b.message,
          b.github_author_name AS author,
          b.id AS build_id,
          COUNT(*) AS waiting_jobs,
          ROUND(MAX(TIMESTAMPDIFF(SECOND, j.runnable_at, current_timestamp())) / 60.0) AS max_wait_min
        FROM vllm_data_warehouse.buildkite.build_job AS j
        INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
        INNER JOIN vllm_data_warehouse.buildkite.build_job_agent_query_rule AS r
          ON j.id = r.build_job_id
        WHERE j._fivetran_deleted = false
          AND b._fivetran_deleted = false
          AND j.type = 'script'
          AND j.runnable_at IS NOT NULL
          AND j.started_at IS NULL
          AND j.state = 'scheduled'
          AND r.rule = 'queue=${queue.replace(/'/g, "''")}'
        GROUP BY b.number, b.web_url, b.message, b.github_author_name, b.id
        ORDER BY waiting_jobs DESC
        LIMIT 5
      ) w
      INNER JOIN (
        SELECT build_id, COUNT(*) AS total_jobs
        FROM vllm_data_warehouse.buildkite.build_job
        WHERE _fivetran_deleted = false AND type = 'script'
        GROUP BY build_id
      ) t ON w.build_id = t.build_id
      ORDER BY w.waiting_jobs DESC
    `);

    const result = { builds: rows };
    setCache(cacheKey, result, TTL);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch waiting builds:", error);
    return NextResponse.json(
      { error: "Failed to fetch waiting builds" },
      { status: 500 },
    );
  }
}
