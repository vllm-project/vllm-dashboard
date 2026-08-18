import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { aggregateJobsByGroup, type JobInfo } from "@/lib/test-groups";
import { ensureTestAreaMapping } from "@/lib/test-areas";

const TTL = 30_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };
const MAX_BUILD_IDS = 50;
const MAX_GROUPS = 20;

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const buildIds = [
      ...new Set(
        (searchParams.get("buildIds") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length <= 100),
      ),
    ].slice(0, MAX_BUILD_IDS);
    const groups = [
      ...new Set(
        (searchParams.get("groups") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length <= 200),
      ),
    ].slice(0, MAX_GROUPS);

    if (buildIds.length === 0 || groups.length === 0) {
      return cachedJson({ jobsByBuild: {} }, CDN_CACHE);
    }

    const cacheKey = `build-jobs:${buildIds.join(",")}:${groups.join(",")}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    await ensureTestAreaMapping();

    const idList = buildIds.map((id) => `'${escapeSql(id)}'`).join(",");
    const jobs = await queryDatabricks(`
      SELECT
        j.build_id,
        j.name,
        j.state,
        j.web_url
      FROM vllm_data_warehouse.buildkite.build_job AS j
      WHERE j.build_id IN (${idList})
        AND j._fivetran_deleted = false
        AND j.type = 'script'
        AND j.name IS NOT NULL
    `);

    const rawJobsByBuild = new Map<
      string,
      { name: string; state: string; web_url?: string }[]
    >();
    for (const job of jobs) {
      const row = job as Record<string, string>;
      const buildJobs = rawJobsByBuild.get(row.build_id) ?? [];
      buildJobs.push({
        name: row.name,
        state: row.state,
        web_url: row.web_url,
      });
      rawJobsByBuild.set(row.build_id, buildJobs);
    }

    const groupSet = new Set(groups);
    const jobsByBuild: Record<string, Record<string, JobInfo[]>> = {};
    for (const buildId of buildIds) {
      const grouped = aggregateJobsByGroup(rawJobsByBuild.get(buildId) ?? []);
      jobsByBuild[buildId] = Object.fromEntries(
        grouped
          .filter((group) => groupSet.has(group.group))
          .map((group) => [group.group, group.jobs]),
      );
    }

    const result = { jobsByBuild };
    setCache(cacheKey, result, TTL);
    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch expanded build jobs:", error);
    return NextResponse.json(
      { error: "Failed to fetch expanded build jobs" },
      { status: 500 },
    );
  }
}
