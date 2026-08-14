import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { resolveGroupsToJobConditions } from "@/lib/test-groups";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";

const PAGE_SIZE = 50;
const TTL = 30_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };

function parseBuildkiteBuildUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.hostname !== "buildkite.com") return null;
    const match = url.pathname.match(
      /^\/([^/]+)\/([^/]+)\/builds\/(\d+)\/?$/,
    );
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

function buildJobFilterSubquery(jobGroups: string[], jobNames: string[]): string {
  const nameConditions: string[] = [];

  if (jobNames.length > 0) {
    const escaped = jobNames.map((n) => `'${n.replace(/'/g, "''")}'`);
    nameConditions.push(`jf.name IN (${escaped.join(",")})`);
  }

  if (jobGroups.length > 0) {
    const { exactNames, regexPatterns } = resolveGroupsToJobConditions(jobGroups);
    if (exactNames.length > 0) {
      const escaped = exactNames.map((n) => `'${n.replace(/'/g, "''")}'`);
      nameConditions.push(`jf.name IN (${escaped.join(",")})`);
    }
    for (const pattern of regexPatterns) {
      nameConditions.push(`jf.name RLIKE '${pattern.replace(/'/g, "''")}'`);
    }
  }

  if (nameConditions.length === 0) return "";

  return `AND b.id IN (
    SELECT DISTINCT jf.build_id
    FROM vllm_data_warehouse.buildkite.build_job AS jf
    WHERE jf._fivetran_deleted = false
      AND jf.type = 'script'
      AND jf.name IS NOT NULL
      AND jf.state NOT IN ('blocked', 'skipped', 'not_run', 'canceled', 'canceling')
      AND (${nameConditions.join(" OR ")})
  )`;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const pipeline = searchParams.get("pipeline");
    const branch = searchParams.get("branch");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const page = Math.max(0, parseInt(searchParams.get("page") ?? "0", 10));
    const jobGroups = searchParams.get("jobGroups")?.split(",").filter(Boolean) ?? [];
    const jobNames = searchParams.get("jobNames")?.split(",").filter(Boolean) ?? [];

    const cacheKey = `builds:${pipeline}:${branch}:${startDate}:${endDate}:${page}:${jobGroups.join(",")}:${jobNames.join(",")}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    // Build WHERE clauses
    const conditions = ["b._fivetran_deleted = false"];
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
    const jobFilter = buildJobFilterSubquery(jobGroups, jobNames);

    // First: fetch the page of builds + total count + daily stats
    const [builds, countResult, buildDurations] = await Promise.all([
      queryDatabricks(`
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
          b.pr_number
        FROM vllm_data_warehouse.buildkite.build AS b
        INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p
          ON b.pipeline_id = p.id
        WHERE ${where}
        ${jobFilter}
        ORDER BY b.created_at DESC
        LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}
      `),
      queryDatabricks(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN b.state = 'passed' THEN 1 ELSE 0 END) AS passed,
          SUM(CASE WHEN b.state IN ('failed', 'failing') THEN 1 ELSE 0 END) AS failed
        FROM vllm_data_warehouse.buildkite.build AS b
        INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p
          ON b.pipeline_id = p.id
        WHERE ${where}
        ${jobFilter}
      `),
      queryDatabricks(`
        SELECT
          b.id,
          b.state,
          b.created_at,
          b.started_at,
          b.finished_at,
          TIMESTAMPDIFF(MINUTE, b.started_at, b.finished_at) AS duration_mins
        FROM vllm_data_warehouse.buildkite.build AS b
        INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p
          ON b.pipeline_id = p.id
        WHERE ${where}
          ${jobFilter}
          AND b.started_at IS NOT NULL
          AND b.finished_at IS NOT NULL
        ORDER BY b.created_at ASC
      `),
    ]);

    // Keep the bootstrap response focused on the chart, summary, and build
    // rows. Group summaries and expanded job details are normalized behind
    // dedicated endpoints so the first screen does not carry 10k+ nested jobs.
    const buildsWithMetadata = builds.map((build) => {
      const b = build as Record<string, unknown>;
      const traceIdentity = parseBuildkiteBuildUrl(b.web_url);
      // Parse PR number from commit message if not set (e.g. main branch)
      let prNumber = b.pr_number as string | null;
      if (!prNumber && b.message) {
        const match = (b.message as string).match(/\(#(\d+)\)/);
        if (match) prNumber = match[1];
      }
      return {
        ...b,
        pr_number: prNumber,
        organization_slug: traceIdentity?.organization_slug ?? null,
        pipeline_slug: traceIdentity?.pipeline_slug ?? null,
        build_number:
          traceIdentity?.build_number ??
          (b.build_number === null || b.build_number === undefined
            ? null
            : String(b.build_number)),
      };
    });

    const counts = countResult[0] as Record<string, string> ?? { total: "0", passed: "0", failed: "0" };
    const total = parseInt(counts.total, 10);
    const passed = parseInt(counts.passed, 10);
    const failed = parseInt(counts.failed, 10);
    const passRate =
      passed + failed > 0 ? Math.round((passed / (passed + failed)) * 100) : 0;

    const result = {
      builds: buildsWithMetadata,
      buildDurations,
      summary: { total, passed, failed, passRate },
      pagination: { page, pageSize: PAGE_SIZE, totalPages: Math.ceil(total / PAGE_SIZE) },
    };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch builds:", error);
    return NextResponse.json(
      { error: "Failed to fetch build data" },
      { status: 500 }
    );
  }
}
