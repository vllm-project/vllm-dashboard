import { NextRequest, NextResponse } from "next/server";
import { queryClickHouse, type ClickHouseParam } from "@/lib/clickhouse";
import {
  aggregateJobsByGroup,
  foldRuntimeShards,
  resolveGroupsToJobConditions,
} from "@/lib/test-groups";
import { SHARD_SUFFIX_SQL } from "@/lib/job-shards";
import {
  ensureTestAreaMapping,
  getTestAreaMappingForCommit,
} from "@/lib/test-areas";
import { getCached, setCache } from "@/lib/api-cache";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { enrichBuildAuthors } from "@/lib/github-build-authors";
import { queryBuildJobsFromOtel, queryBuildsFromOtel } from "@/lib/otel-ci";

const MAX_PER_PAGE = 30;
const DEFAULT_PER_PAGE = 10;
const TTL = 30_000;

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
    state: string | null;
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
    // The end date is inclusive.
    conditions.push(
      "b.created_at < toStartOfDay(parseDateTime64BestEffort({endDate:String}, 3, 'UTC')) + INTERVAL 1 DAY",
    );
  }
  if (filters.state) {
    params.state = filters.state;
    conditions.push("b.state = {state:String}");
  }
  return conditions.join(" AND ");
}

interface BuildRow {
  id: string;
  web_url: string;
  message: string;
  commit_sha: string;
  pipeline: string;
  branch: string;
  state: string;
  created_at: string;
  started_at: string;
  finished_at: string;
  author: string | null;
  pr_number: string | null;
  duration_mins: string | null;
}

interface JobRow {
  build_id: string;
  name: string;
  state: string;
}

function stateIcon(state: string): string {
  switch (state) {
    case "passed": return "PASS";
    case "failed":
    case "failing":
    case "broken":
    case "timed_out": return "FAIL";
    case "running":
    case "scheduled":
    case "reserved": return "RUNNING";
    case "blocked": return "BLOCKED";
    case "canceled":
    case "canceling": return "CANCELED";
    case "not_run":
    case "skipped": return "SKIPPED";
    default: return state.toUpperCase();
  }
}

function groupIcon(state: string): string {
  switch (state) {
    case "passed": return "ok";
    case "failed": return "FAIL";
    case "running": return "..";
    case "blocked": return "--";
    default: return "??";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function formatText(
  builds: (BuildRow & { testGroups: ReturnType<typeof aggregateJobsByGroup>; matchedJobs?: { name: string; state: string }[] })[],
  summary: { total: number; passed: number; failed: number; passRate: number },
  filters: { pipeline: string | null; branch: string | null; startDate: string | null; endDate: string | null },
  pagination: { page: number; perPage: number; totalPages: number },
  includeJobs: boolean,
  filteredJobNames: string[],
): string {
  const lines: string[] = [];

  // Header
  const parts: string[] = [];
  if (filters.pipeline) parts.push(`Pipeline: ${filters.pipeline}`);
  if (filters.branch) parts.push(`Branch: ${filters.branch}`);
  if (filters.startDate || filters.endDate) {
    parts.push(`Date: ${filters.startDate ?? "..."} to ${filters.endDate ?? "now"}`);
  }
  if (parts.length > 0) lines.push(parts.join(" | "));
  if (filteredJobNames.length > 0) {
    lines.push(`Jobs: ${filteredJobNames.join(", ")}`);
  }

  lines.push(
    `${summary.total} builds | ${summary.passed} passed | ${summary.failed} failed | ${summary.passRate}% pass rate`
  );
  lines.push(
    `Page ${pagination.page + 1}/${pagination.totalPages} (${pagination.perPage}/page)`
  );
  lines.push("");

  for (const build of builds) {
    const date = build.created_at?.slice(0, 16) ?? "?";
    const sha = build.commit_sha?.slice(0, 7) ?? "?";
    const author = build.author ?? "?";
    const msg = truncate((build.message ?? "").split("\n")[0], 60);
    const dur = build.duration_mins ? `${build.duration_mins}m` : "?";
    const pr = build.pr_number ? `#${build.pr_number}` : "";
    const buildNum = build.web_url?.match(/builds\/(\d+)/)?.[1] ?? "?";

    lines.push(
      `#${buildNum} ${stateIcon(build.state).padEnd(8)} ${date}  ${sha}  ${author}  ${dur}  ${pr}`
    );
    lines.push(`  ${msg}`);

    if (filteredJobNames.length > 0 && build.matchedJobs) {
      for (const job of build.matchedJobs) {
        lines.push(`  ${job.name}: ${stateIcon(job.state)}`);
      }
    } else {
      if (build.testGroups.length > 0) {
        const groupParts = build.testGroups.map((g) => {
          let detail = groupIcon(g.state);
          if (g.state === "failed") {
            detail = `${g.failed}F/${g.total}`;
          }
          return `${g.group}:${detail}`;
        });
        lines.push(`  [${groupParts.join("  ")}]`);
      }

      if (includeJobs && build.testGroups.length > 0) {
        for (const group of build.testGroups) {
          if (group.state === "failed") {
            const failedJobs = group.jobs
              .filter((j) => ["failed", "failing", "broken", "timed_out"].includes(j.state))
              .map((j) => j.name);
            if (failedJobs.length > 0) {
              lines.push(`    ${group.group} failures: ${failedJobs.join(", ")}`);
            }
          }
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const pipeline = searchParams.get("pipeline");
    const branch = searchParams.get("branch");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const state = searchParams.get("state");
    const page = Math.max(0, parseInt(searchParams.get("page") ?? "0", 10) || 0);
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, parseInt(searchParams.get("per_page") ?? `${DEFAULT_PER_PAGE}`, 10) || DEFAULT_PER_PAGE));
    const format = searchParams.get("format") === "json" ? "json" : "text";
    const includeJobs = searchParams.get("jobs") !== "false";
    const jobGroups = searchParams.get("jobGroups")?.split(",").filter(Boolean) ?? [];
    const jobNames = searchParams.get("jobNames")?.split(",").filter(Boolean) ?? [];

    const cacheKey = `builds-summary:${pipeline}:${branch}:${startDate}:${endDate}:${state}:${page}:${perPage}:${format}:${includeJobs}:${jobGroups.join(",")}:${jobNames.join(",")}:${resolveCiDataSource(request)}`;
    const cached = getCached<{ text?: string; json?: unknown }>(cacheKey);
    if (cached) {
      if (cached.text) {
        return new NextResponse(cached.text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      return NextResponse.json(cached.json);
    }

    if (resolveCiDataSource(request) === "otel") {
      await ensureTestAreaMapping();
      const { builds, summary: summaryData, total } = await queryBuildsFromOtel({
        pipeline,
        branch,
        startDate,
        endDate,
        page,
        pageSize: perPage,
        jobGroups,
        jobNames,
        state,
      });

      const buildIds = builds.map((b) => b.id as string);
      const jobRows = await queryBuildJobsFromOtel(buildIds);
      const jobsByBuild = new Map<string, { name: string; state: string }[]>();
      for (const j of jobRows) {
        const buildId = j.build_id as string;
        if (!jobsByBuild.has(buildId)) jobsByBuild.set(buildId, []);
        jobsByBuild.get(buildId)!.push({ name: j.name as string, state: j.state as string });
      }

      const buildsWithGroups = builds.map((b) => {
        const buildJobs = jobsByBuild.get(b.id as string) ?? [];
        const testGroups = aggregateJobsByGroup(buildJobs);
        const matchedJobs = jobNames.length > 0
          ? foldRuntimeShards(buildJobs).filter((j) => jobNames.includes(j.name))
          : undefined;
        return {
          ...(b as unknown as BuildRow),
          duration_mins: null,
          testGroups,
          matchedJobs,
        };
      });

      const pagination = { page, perPage, totalPages: Math.ceil(total / perPage) };

      if (format === "text") {
        const text = formatText(buildsWithGroups, summaryData, { pipeline, branch, startDate, endDate }, pagination, includeJobs, jobNames);
        setCache(cacheKey, { text }, TTL);
        return new NextResponse(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }

      const jsonResult = {
        summary: summaryData,
        pagination,
        builds: buildsWithGroups.map((b) => ({
          number: (b.web_url as string)?.match(/builds\/(\d+)/)?.[1] ?? null,
          state: b.state,
          pipeline: b.pipeline,
          branch: b.branch,
          commit: (b.commit_sha as string)?.slice(0, 7) ?? null,
          author: b.author,
          pr: b.pr_number,
          message: ((b.message as string) ?? "").split("\n")[0].slice(0, 80),
          created_at: (b.created_at as string)?.slice(0, 16) ?? null,
          duration_mins: null,
          ...(jobNames.length > 0 && b.matchedJobs ? {
            jobs: b.matchedJobs.map((j) => ({ name: j.name, state: j.state })),
          } : {
            groups: b.testGroups.map((g) => ({
              name: g.group,
              state: g.state,
              passed: g.passed,
              failed: g.failed,
              total: g.total,
              ...(g.state === "failed" ? {
                failed_jobs: g.jobs
                  .filter((j) => ["failed", "failing", "broken", "timed_out"].includes(j.state))
                  .map((j) => j.name),
              } : {}),
            })),
          }),
        })),
      };

      setCache(cacheKey, { json: jsonResult }, TTL);
      return NextResponse.json(jsonResult);
    }

    const params: QueryParams = {};
    const where = buildWhereClause({ pipeline, branch, startDate, endDate, state }, params);
    await ensureTestAreaMapping();
    const jobFilter = buildJobFilterSubquery(jobGroups, jobNames, where, params);
    const pipelineJoin = `INNER JOIN (
          SELECT id, name FROM buildkite.pipeline FINAL WHERE NOT _fivetran_deleted
        ) AS p ON b.pipeline_id = p.id`;

    const [builds, countResult] = await Promise.all([
      queryClickHouse<BuildRow>(`
        SELECT
          b.id AS id,
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
          b.pr_number AS pr_number,
          -- Whole elapsed minutes, truncated (Spark TIMESTAMPDIFF semantics).
          toInt64((toUnixTimestamp64Milli(b.finished_at) - toUnixTimestamp64Milli(b.started_at)) / 60000) AS duration_mins
        FROM buildkite.build AS b FINAL
        ${pipelineJoin}
        WHERE ${where}
        ${jobFilter}
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      `, { ...params, limit: perPage, offset: page * perPage }),
      queryClickHouse<{ total: string; passed: string; failed: string }>(`
        SELECT
          count() AS total,
          countIf(b.state = 'passed') AS passed,
          countIf(b.state IN ('failed', 'failing')) AS failed
        FROM buildkite.build AS b FINAL
        ${pipelineJoin}
        WHERE ${where}
        ${jobFilter}
      `, params),
    ]);

    const enrichedBuilds = await enrichBuildAuthors(builds);
    const buildIds = enrichedBuilds.map((b) => b.id);
    const jobsByBuild = new Map<string, { name: string; state: string }[]>();

    if (buildIds.length > 0) {
      const jobs = await queryClickHouse<JobRow>(`
        SELECT
          j.build_id AS build_id,
          j.name AS name,
          j.state AS state
        FROM buildkite.build_job AS j FINAL
        WHERE j.build_id IN {buildIds:Array(String)}
          AND NOT j._fivetran_deleted
          AND j.type = 'script'
          AND j.name IS NOT NULL
      `, { buildIds });

      for (const j of jobs) {
        if (!jobsByBuild.has(j.build_id)) jobsByBuild.set(j.build_id, []);
        jobsByBuild.get(j.build_id)!.push({ name: j.name, state: j.state });
      }
    }

    const mappingsByCommit = new Map<
      string,
      ReturnType<typeof getTestAreaMappingForCommit>
    >();
    for (const build of enrichedBuilds) {
      const mappingKey = `${build.branch}:${build.commit_sha}`;
      if (!mappingsByCommit.has(mappingKey)) {
        mappingsByCommit.set(
          mappingKey,
          getTestAreaMappingForCommit(build.commit_sha, build.branch),
        );
      }
    }
    const buildsWithGroups = await Promise.all(enrichedBuilds.map(async (b) => {
      const buildJobs = jobsByBuild.get(b.id) ?? [];
      const mapping = await mappingsByCommit.get(
        `${b.branch}:${b.commit_sha}`,
      )!;
      const testGroups = aggregateJobsByGroup(buildJobs, mapping);
      let prNumber = b.pr_number;
      if (!prNumber && b.message) {
        const match = b.message.match(/\(#(\d+)\)/);
        if (match) prNumber = match[1];
      }
      const matchedJobs = jobNames.length > 0
        ? foldRuntimeShards(buildJobs).filter((j) => jobNames.includes(j.name))
        : undefined;
      return { ...b, pr_number: prNumber, testGroups, matchedJobs };
    }));

    const counts = countResult[0] ?? { total: "0", passed: "0", failed: "0" };
    const total = parseInt(counts.total, 10);
    const passed = parseInt(counts.passed, 10);
    const failed = parseInt(counts.failed, 10);
    const passRate = passed + failed > 0 ? Math.round((passed / (passed + failed)) * 100) : 0;

    const summaryData = { total, passed, failed, passRate };
    const pagination = { page, perPage, totalPages: Math.ceil(total / perPage) };

    if (format === "text") {
      const text = formatText(buildsWithGroups, summaryData, { pipeline, branch, startDate, endDate }, pagination, includeJobs, jobNames);
      setCache(cacheKey, { text }, TTL);
      return new NextResponse(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    const jsonResult = {
      summary: summaryData,
      pagination,
      builds: buildsWithGroups.map((b) => ({
        number: b.web_url?.match(/builds\/(\d+)/)?.[1] ?? null,
        state: b.state,
        pipeline: b.pipeline,
        branch: b.branch,
        commit: b.commit_sha?.slice(0, 7) ?? null,
        author: b.author,
        pr: b.pr_number,
        message: (b.message ?? "").split("\n")[0].slice(0, 80),
        created_at: b.created_at?.slice(0, 16) ?? null,
        duration_mins: b.duration_mins ? parseInt(b.duration_mins, 10) : null,
        ...(jobNames.length > 0 && b.matchedJobs ? {
          jobs: b.matchedJobs.map((j) => ({ name: j.name, state: j.state })),
        } : {
          groups: b.testGroups.map((g) => ({
            name: g.group,
            state: g.state,
            passed: g.passed,
            failed: g.failed,
            total: g.total,
            ...(g.state === "failed" ? {
              failed_jobs: g.jobs
                .filter((j) => ["failed", "failing", "broken", "timed_out"].includes(j.state))
                .map((j) => j.name),
            } : {}),
          })),
        }),
      })),
    };

    setCache(cacheKey, { json: jsonResult }, TTL);
    return NextResponse.json(jsonResult);
  } catch (error) {
    console.error("Failed to fetch build summary:", error);
    return NextResponse.json(
      { error: "Failed to fetch build summary" },
      { status: 500 }
    );
  }
}
