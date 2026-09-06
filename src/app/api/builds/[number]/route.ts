import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";

const TTL = 30_000;
const CDN_CACHE = { maxAge: 30, staleWhileRevalidate: 600 };

function parseBuildkiteBuildUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.hostname !== "buildkite.com") return null;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/builds\/(\d+)\/?$/);
    if (!match) return null;
    return {
      organization_slug: decodeURIComponent(match[1]),
      pipeline_slug: decodeURIComponent(match[2]),
      build_number: match[3],
    };
  } catch {
    return null;
  }
}

/** One build by pipeline name and Buildkite build number. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params;
  if (!/^\d{1,9}$/.test(number)) {
    return NextResponse.json({ error: "Invalid build number" }, { status: 400 });
  }
  const pipeline = request.nextUrl.searchParams.get("pipeline") || "CI";

  const cacheKey = `build:${pipeline}:${number}`;
  const cached = getCached(cacheKey);
  if (cached) return cachedJson(cached, CDN_CACHE);

  try {
    const rows = await queryDatabricks(`
      SELECT
        b.id AS id,
        b.number AS build_number,
        b.web_url,
        b.message,
        b.commit AS commit_sha,
        p.name AS pipeline,
        b.branch,
        b.state,
        b.created_at,
        b.started_at,
        b.finished_at,
        b.github_author_username AS author,
        b.pr_number,
        TIMESTAMPDIFF(SECOND, b.started_at, b.finished_at) AS duration_secs
      FROM vllm_data_warehouse.buildkite.build AS b
      INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p
        ON b.pipeline_id = p.id
      WHERE b._fivetran_deleted = false
        AND p.name = '${pipeline.replace(/'/g, "''")}'
        AND b.number = ${Number(number)}
      ORDER BY b.created_at DESC
      LIMIT 1
    `);

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return NextResponse.json({ error: "Build not found" }, { status: 404 });
    }

    const identity = parseBuildkiteBuildUrl(row.web_url);
    let prNumber = (row.pr_number as string | null) ?? null;
    if (!prNumber && typeof row.message === "string") {
      const match = row.message.match(/\(#(\d+)\)/);
      if (match) prNumber = match[1];
    }

    const result = {
      build: {
        ...row,
        pr_number: prNumber,
        organization_slug: identity?.organization_slug ?? null,
        pipeline_slug: identity?.pipeline_slug ?? null,
        build_number: identity?.build_number ?? String(row.build_number),
        duration_secs:
          row.duration_secs === null || row.duration_secs === undefined
            ? null
            : Number(row.duration_secs),
      },
    };
    setCache(cacheKey, result, TTL);
    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch build:", error);
    return NextResponse.json({ error: "Failed to fetch build" }, { status: 500 });
  }
}
