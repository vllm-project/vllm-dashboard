import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";

const TTL = 60_000;
const CDN_CACHE = { maxAge: 30, staleWhileRevalidate: 3_600 };

export async function GET(request: NextRequest) {
  const queue = request.nextUrl.searchParams.get("queue");
  if (!queue) {
    return NextResponse.json({ error: "queue parameter required" }, { status: 400 });
  }

  const cacheKey = `waiting-builds:${queue}`;
  const cached = getCached(cacheKey);
  if (cached) return cachedJson(cached, CDN_CACHE);

  try {
    const rows = await queryDatabricks(`
      WITH waiting AS (
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
      )
      SELECT
        w.build_number,
        w.build_url,
        w.message,
        w.author,
        w.waiting_jobs,
        w.max_wait_min,
        COUNT(t.id) AS total_jobs
      FROM waiting AS w
      INNER JOIN vllm_data_warehouse.buildkite.build_job AS t
        ON w.build_id = t.build_id
       AND t._fivetran_deleted = false
       AND t.type = 'script'
      GROUP BY
        w.build_number,
        w.build_url,
        w.message,
        w.author,
        w.waiting_jobs,
        w.max_wait_min
      ORDER BY w.waiting_jobs DESC
    `);

    const result = { builds: rows };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch waiting builds:", error);
    return NextResponse.json(
      { error: "Failed to fetch waiting builds" },
      { status: 500 },
    );
  }
}
