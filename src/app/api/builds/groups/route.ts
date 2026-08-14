import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import {
  aggregateJobsByGroup,
  isFailedJobState,
  type GroupStatus,
} from "@/lib/test-groups";

const TTL = 30_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };
const MAX_BUILD_IDS = 50;

type GroupSummary = Omit<GroupStatus, "jobs"> & {
  failedJobs: Array<{ name: string; web_url: string }>;
};

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
        {
          groupsByBuild: {},
          jobNames: [],
          jobsByBuild: {},
          startedJobCountsByBuild: {},
          jobOptions: [],
        },
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
        j.state,
        j.web_url,
        j.started_at
      FROM vllm_data_warehouse.buildkite.build_job AS j
      WHERE j.build_id IN (${idList})
        AND j._fivetran_deleted = false
        AND j.type = 'script'
        AND j.name IS NOT NULL
    `);

    const jobsByBuild = new Map<
      string,
      { name: string; state: string; web_url?: string }[]
    >();
    const startedJobCountsByBuild = Object.fromEntries(
      buildIds.map((buildId) => [buildId, 0]),
    ) as Record<string, number>;
    for (const job of jobs) {
      const row = job as Record<string, string | null>;
      const buildId = row.build_id;
      if (!buildId || !row.name || !row.state) continue;
      if (row.started_at) {
        startedJobCountsByBuild[buildId] += 1;
      }
      const buildJobs = jobsByBuild.get(buildId) ?? [];
      buildJobs.push({
        name: row.name,
        state: row.state,
        web_url: row.web_url ?? undefined,
      });
      jobsByBuild.set(buildId, buildJobs);
    }

    const groupedByBuild = new Map<string, GroupStatus[]>();
    const jobToGroup = new Map<string, string>();
    for (const buildId of buildIds) {
      const groups = aggregateJobsByGroup(jobsByBuild.get(buildId) ?? []);
      groupedByBuild.set(buildId, groups);
      for (const group of groups) {
        for (const job of group.jobs) {
          if (!jobToGroup.has(job.name)) {
            jobToGroup.set(job.name, group.group);
          }
        }
      }
    }

    // Normalize repeated job names into one dictionary. The compact
    // name-index/state matrix is small enough to ship with group summaries, so
    // expanding a group is immediate. Only the much larger job URLs stay lazy.
    const jobNames = [...jobToGroup.keys()].sort((a, b) => a.localeCompare(b));
    const jobNameIndex = new Map(
      jobNames.map((name, index) => [name, index]),
    );
    const groupsByBuild: Record<string, GroupSummary[]> = {};
    const compactJobsByBuild: Record<
      string,
      Record<string, Array<[number, string]>>
    > = {};
    for (const buildId of buildIds) {
      const groups = groupedByBuild.get(buildId) ?? [];
      compactJobsByBuild[buildId] = {};
      groupsByBuild[buildId] = groups.map(({ jobs: groupJobs, ...summary }) => {
        compactJobsByBuild[buildId][summary.group] = groupJobs.map((job) => [
          jobNameIndex.get(job.name)!,
          job.state,
        ]);
        const failedJobs = groupJobs
          .filter((job) => isFailedJobState(job.state) && job.web_url)
          .map((job) => ({ name: job.name, web_url: job.web_url! }));
        return { ...summary, failedJobs };
      });
    }

    const result = {
      groupsByBuild,
      jobNames,
      jobsByBuild: compactJobsByBuild,
      startedJobCountsByBuild,
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
