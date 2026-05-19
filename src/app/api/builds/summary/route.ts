import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { aggregateJobsByGroup, resolveGroupsToJobConditions } from "@/lib/test-groups";
import { getCached, setCache } from "@/lib/api-cache";

const MAX_PER_PAGE = 30;
const DEFAULT_PER_PAGE = 10;
const TTL = 30_000;

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
  author: string;
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
    const page = Math.max(0, parseInt(searchParams.get("page") ?? "0", 10));
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, parseInt(searchParams.get("per_page") ?? `${DEFAULT_PER_PAGE}`, 10)));
    const format = searchParams.get("format") === "json" ? "json" : "text";
    const includeJobs = searchParams.get("jobs") !== "false";
    const jobGroups = searchParams.get("jobGroups")?.split(",").filter(Boolean) ?? [];
    const jobNames = searchParams.get("jobNames")?.split(",").filter(Boolean) ?? [];

    const cacheKey = `builds-summary:${pipeline}:${branch}:${startDate}:${endDate}:${state}:${page}:${perPage}:${format}:${includeJobs}:${jobGroups.join(",")}:${jobNames.join(",")}`;
    const cached = getCached<{ text?: string; json?: unknown }>(cacheKey);
    if (cached) {
      if (cached.text) {
        return new NextResponse(cached.text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      return NextResponse.json(cached.json);
    }

    const conditions = ["b._fivetran_deleted = false"];
    if (pipeline) conditions.push(`p.name = '${pipeline.replace(/'/g, "''")}'`);
    if (branch) conditions.push(`b.branch = '${branch.replace(/'/g, "''")}'`);
    if (startDate) conditions.push(`b.created_at >= '${startDate.replace(/'/g, "''")}'`);
    if (endDate) conditions.push(`b.created_at < DATE_ADD('${endDate.replace(/'/g, "''")}', 1)`);
    if (state) conditions.push(`b.state = '${state.replace(/'/g, "''")}'`);
    const where = conditions.join(" AND ");
    const jobFilter = buildJobFilterSubquery(jobGroups, jobNames);

    const [builds, countResult] = await Promise.all([
      queryDatabricks<BuildRow>(`
        SELECT
          b.id,
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
          TIMESTAMPDIFF(MINUTE, b.started_at, b.finished_at) AS duration_mins
        FROM vllm_data_warehouse.buildkite.build AS b
        INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p
          ON b.pipeline_id = p.id
        WHERE ${where}
        ${jobFilter}
        ORDER BY b.created_at DESC
        LIMIT ${perPage} OFFSET ${page * perPage}
      `),
      queryDatabricks<{ total: string; passed: string; failed: string }>(`
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
    ]);

    const buildIds = builds.map((b) => b.id);
    const jobsByBuild = new Map<string, { name: string; state: string }[]>();

    if (buildIds.length > 0) {
      const idList = buildIds.map((id) => `'${id}'`).join(",");
      const jobs = await queryDatabricks<JobRow>(`
        SELECT
          j.build_id,
          j.name,
          j.state
        FROM vllm_data_warehouse.buildkite.build_job AS j
        WHERE j.build_id IN (${idList})
          AND j._fivetran_deleted = false
          AND j.type = 'script'
          AND j.name IS NOT NULL
      `);

      for (const j of jobs) {
        if (!jobsByBuild.has(j.build_id)) jobsByBuild.set(j.build_id, []);
        jobsByBuild.get(j.build_id)!.push({ name: j.name, state: j.state });
      }
    }

    const buildsWithGroups = builds.map((b) => {
      const buildJobs = jobsByBuild.get(b.id) ?? [];
      const testGroups = aggregateJobsByGroup(buildJobs);
      let prNumber = b.pr_number;
      if (!prNumber && b.message) {
        const match = b.message.match(/\(#(\d+)\)/);
        if (match) prNumber = match[1];
      }
      const matchedJobs = jobNames.length > 0
        ? buildJobs.filter((j) => jobNames.some((n) => j.name === n))
        : undefined;
      return { ...b, pr_number: prNumber, testGroups, matchedJobs };
    });

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
