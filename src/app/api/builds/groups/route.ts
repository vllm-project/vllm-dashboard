import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { aggregateJobsByGroup, type GroupStatus } from "@/lib/test-groups";

const TTL = 30_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };
const MAX_BUILD_IDS = 50;

type GroupSummary = Omit<GroupStatus, "jobs">;

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

export async function GET(request: NextRequest) {
  try {
    const buildIds = [
      ...new Set(
        (request.nextUrl.searchParams.get("buildIds") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length <= 100),
      ),
    ].slice(0, MAX_BUILD_IDS);

    if (buildIds.length === 0) {
      return cachedJson(
        { groupsByBuild: {}, jobOptions: [] },
        CDN_CACHE,
      );
    }

    const cacheKey = `build-groups:${buildIds.join(",")}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    const idList = buildIds.map((id) => `'${escapeSql(id)}'`).join(",");
    const jobs = await queryDatabricks(`
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

    const jobsByBuild = new Map<
      string,
      { name: string; state: string }[]
    >();
    for (const job of jobs) {
      const row = job as Record<string, string>;
      const buildJobs = jobsByBuild.get(row.build_id) ?? [];
      buildJobs.push({ name: row.name, state: row.state });
      jobsByBuild.set(row.build_id, buildJobs);
    }

    const groupsByBuild: Record<string, GroupSummary[]> = {};
    const jobToGroup = new Map<string, string>();
    for (const buildId of buildIds) {
      const groups = aggregateJobsByGroup(jobsByBuild.get(buildId) ?? []);
      groupsByBuild[buildId] = groups.map(({ jobs: groupJobs, ...summary }) => {
        for (const job of groupJobs) {
          if (!jobToGroup.has(job.name)) {
            jobToGroup.set(job.name, summary.group);
          }
        }
        return summary;
      });
    }

    const result = {
      groupsByBuild,
      jobOptions: [...jobToGroup.entries()]
        .map(([name, group]) => ({ name, group }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch build group summaries:", error);
    return NextResponse.json(
      { error: "Failed to fetch build group summaries" },
      { status: 500 },
    );
  }
}
