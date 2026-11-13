import { NextRequest, NextResponse } from "next/server";
import { queryClickHouse, type ClickHouseParam } from "@/lib/clickhouse";
import { resolveGroupsToJobConditions } from "@/lib/test-groups";
import { ensureTestAreaMapping } from "@/lib/test-areas";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { SHARD_SUFFIX_SQL } from "@/lib/job-shards";
import { enrichBuildAuthors } from "@/lib/github-build-authors";
import { queryBuildsFromOtel } from "@/lib/otel-ci";

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

type QueryParams = Record<string, ClickHouseParam>;

/**
 * A ClickHouse `match()` condition for a group regex. ClickHouse uses RE2,
 * which has no lookaround, so a negative lookahead `P(?!N)R` is rewritten as
 * `match(PR) AND NOT match(PN)`.
 */
function regexCondition(
  expr: string,
  pattern: string,
  name: string,
  params: QueryParams,
): string {
  const lookahead = /^(.*?)\(\?!([^()]*)\)(.*)$/.exec(pattern);
  if (!lookahead) {
    params[name] = pattern;
    return `match(${expr}, {${name}:String})`;
  }
  const [, prefix, negative, rest] = lookahead;
  params[name] = prefix + rest;
  params[`${name}_not`] = prefix + negative;
  return `(match(${expr}, {${name}:String}) AND NOT match(${expr}, {${name}_not:String}))`;
}

/**
 * Restrict builds (alias `b`, already filtered by `buildWhere`) to those that
 * ran a job matching the selected groups/names. The job scan is scoped to the
 * filtered build ids so it uses build_job's (build_id, id) sort key.
 */
function buildJobFilterSubquery(
  jobGroups: string[],
  jobNames: string[],
  buildWhere: string,
  params: QueryParams,
): string {
  const nameConditions: string[] = [];
  // Match a runtime-sharded step by its shards too (see job-shards.ts).
  const step = `replaceRegexpAll(jf.name, '${SHARD_SUFFIX_SQL}', '')`;

  if (jobNames.length > 0) {
    params.jobNames = jobNames;
    nameConditions.push(`${step} IN {jobNames:Array(String)}`);
  }

  if (jobGroups.length > 0) {
    const { exactNames, regexPatterns } = resolveGroupsToJobConditions(jobGroups);
    if (exactNames.length > 0) {
      params.groupJobNames = exactNames;
      nameConditions.push(`${step} IN {groupJobNames:Array(String)}`);
    }
    regexPatterns.forEach((pattern, index) => {
      nameConditions.push(regexCondition(step, pattern, `jobRegex${index}`, params));
    });
  }

  if (nameConditions.length === 0) return "";

  return `AND b.id IN (
    SELECT DISTINCT jf.build_id
    FROM buildkite.build_job AS jf FINAL
    WHERE jf.build_id IN (SELECT b.id FROM buildkite.build AS b FINAL WHERE ${buildWhere})
      AND NOT jf._fivetran_deleted
      AND jf.type = 'script'
      AND jf.name IS NOT NULL
      AND jf.state NOT IN ('blocked', 'skipped', 'not_run', 'canceled', 'canceling')
      AND (${nameConditions.join(" OR ")})
  )`;
}

/** WHERE conditions on `b` (buildkite.build) for the shared build filters. */
function buildWhereClause(
  filters: {
    pipeline: string | null;
    branch: string | null;
    startDate: string | null;
    endDate: string | null;
  },
  params: QueryParams,
): string {
  const conditions = ["NOT b._fivetran_deleted"];
  if (filters.pipeline) {
    params.pipeline = filters.pipeline;
    conditions.push(`b.pipeline_id IN (
      SELECT id FROM buildkite.pipeline FINAL
      WHERE NOT _fivetran_deleted AND name = {pipeline:String}
    )`);
  }
  if (filters.branch) {
    params.branch = filters.branch;
    conditions.push("b.branch = {branch:String}");
  }
  if (filters.startDate) {
    params.startDate = filters.startDate;
    conditions.push("b.created_at >= parseDateTime64BestEffort({startDate:String}, 3, 'UTC')");
  }
  if (filters.endDate) {
    params.endDate = filters.endDate;
    // A date is inclusive; a full timestamp (from a drag-zoom on the
    // chart) is the exact, exclusive end.
    conditions.push(
      filters.endDate.includes("T")
        ? "b.created_at < parseDateTime64BestEffort({endDate:String}, 3, 'UTC')"
        : "b.created_at < toStartOfDay(parseDateTime64BestEffort({endDate:String}, 3, 'UTC')) + INTERVAL 1 DAY",
    );
  }
  return conditions.join(" AND ");
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const pipeline = searchParams.get("pipeline");
    const branch = searchParams.get("branch");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const page = Math.max(0, parseInt(searchParams.get("page") ?? "0", 10) || 0);
    const jobGroups = searchParams.get("jobGroups")?.split(",").filter(Boolean) ?? [];
    const jobNames = searchParams.get("jobNames")?.split(",").filter(Boolean) ?? [];

    const cacheKey = `builds:${pipeline}:${branch}:${startDate}:${endDate}:${page}:${jobGroups.join(",")}:${jobNames.join(",")}:${resolveCiDataSource(request)}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    if (resolveCiDataSource(request) === "otel") {
      if (jobGroups.length > 0) {
        await ensureTestAreaMapping();
      }
      const { builds, buildDurations, summary, total } = await queryBuildsFromOtel({
        pipeline,
        branch,
        startDate,
        endDate,
        page,
        pageSize: PAGE_SIZE,
        jobGroups,
        jobNames,
      });

      const result = {
        builds,
        buildDurations,
        summary,
        pagination: { page, pageSize: PAGE_SIZE, totalPages: Math.ceil(total / PAGE_SIZE) },
      };
      setCache(cacheKey, result, TTL);
      return cachedJson(result, CDN_CACHE);
    }

    const params: QueryParams = {};
    const where = buildWhereClause({ pipeline, branch, startDate, endDate }, params);
    if (jobGroups.length > 0) {
      await ensureTestAreaMapping();
    }
    const jobFilter = buildJobFilterSubquery(jobGroups, jobNames, where, params);
    const pipelineJoin = `INNER JOIN (
          SELECT id, name FROM buildkite.pipeline FINAL WHERE NOT _fivetran_deleted
        ) AS p ON b.pipeline_id = p.id`;

    // First: fetch the page of builds + total count + daily stats
    const [builds, countResult, buildDurations] = await Promise.all([
      queryClickHouse(`
        SELECT
          b.id AS id,
          b.number AS build_number,
          b.web_url AS web_url,
          b.message AS message,
          b.commit AS commit_sha,
          p.name AS pipeline,
          b.branch AS branch,
          b.state AS state,
          b.created_at AS created_at,
          b.started_at AS started_at,
          b.finished_at AS finished_at,
          b.github_author_username AS author,
          b.pr_number AS pr_number
        FROM buildkite.build AS b FINAL
        ${pipelineJoin}
        WHERE ${where}
        ${jobFilter}
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      `, { ...params, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
      queryClickHouse(`
        SELECT
          count() AS total,
          countIf(b.state = 'passed') AS passed,
          countIf(b.state IN ('failed', 'failing')) AS failed
        FROM buildkite.build AS b FINAL
        ${pipelineJoin}
        WHERE ${where}
        ${jobFilter}
      `, params),
      queryClickHouse(`
        SELECT
          b.id AS id,
          b.state AS state,
          b.created_at AS created_at,
          b.started_at AS started_at,
          b.finished_at AS finished_at,
          -- Whole elapsed minutes, truncated (Spark TIMESTAMPDIFF semantics;
          -- dateDiff('minute') would count minute boundaries instead).
          toInt64((toUnixTimestamp64Milli(b.finished_at) - toUnixTimestamp64Milli(b.started_at)) / 60000) AS duration_mins
        FROM buildkite.build AS b FINAL
        ${pipelineJoin}
        WHERE ${where}
          ${jobFilter}
          AND b.started_at IS NOT NULL
          AND b.finished_at IS NOT NULL
        ORDER BY b.created_at ASC, b.id ASC
      `, params),
    ]);

    // Keep the bootstrap response focused on the chart, summary, and build
    // rows. Group summaries and expanded job details are normalized behind
    // dedicated endpoints so the first screen does not carry 10k+ nested jobs.
    const buildsWithMetadata = (await enrichBuildAuthors(builds)).map((build) => {
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
