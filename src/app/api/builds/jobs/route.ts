import { NextRequest, NextResponse } from "next/server";
import { queryClickHouse } from "@/lib/clickhouse";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { aggregateJobsByGroup, type JobInfo } from "@/lib/test-groups";
import { getTestAreaMappingForCommit } from "@/lib/test-areas";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { getBuildJobRosterRows } from "@/lib/buildkite-build-jobs";
import { queryBuildJobsFromOtel } from "@/lib/otel-ci";

const TTL = 30_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };
const MAX_BUILD_IDS = 50;
const MAX_GROUPS = 20;

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

    const cacheKey = `build-jobs:${buildIds.join(",")}:${groups.join(",")}:${resolveCiDataSource(request)}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    if (resolveCiDataSource(request) === "otel") {
      // OTel spans only cover jobs that ran; use the REST roster for the full
      // job list including gated jobs that never executed. Fall back to OTel
      // spans if the roster is empty (e.g. API token misconfigured).
      let jobs = await getBuildJobRosterRows(buildIds);
      if (jobs.length === 0) {
        jobs = await queryBuildJobsFromOtel(buildIds);
      }
      const rawJobsByBuild = new Map<
        string,
        { name: string; state: string; web_url?: string }[]
      >();
      const refsByBuild = new Map<
        string,
        { commit: string | null; branch: string | null }
      >();
      for (const job of jobs) {
        const buildId = job.build_id as string;
        if (!refsByBuild.has(buildId)) {
          refsByBuild.set(buildId, {
            commit: (job.commit_sha as string) ?? null,
            branch: (job.branch as string) ?? null,
          });
        }
        const buildJobs = rawJobsByBuild.get(buildId) ?? [];
        buildJobs.push({
          name: job.name as string,
          state: job.state as string,
          web_url: (job.web_url as string) ?? undefined,
        });
        rawJobsByBuild.set(buildId, buildJobs);
      }

      const groupSet = new Set(groups);
      const jobsByBuild: Record<string, Record<string, JobInfo[]>> = {};
      for (const buildId of buildIds) {
        const ref = refsByBuild.get(buildId);
        const mapping = await getTestAreaMappingForCommit(ref?.commit, ref?.branch);
        const grouped = aggregateJobsByGroup(
          rawJobsByBuild.get(buildId) ?? [],
          mapping,
        );
        jobsByBuild[buildId] = Object.fromEntries(
          grouped
            .filter((group) => groupSet.has(group.group))
            .map((group) => [group.group, group.jobs]),
        );
      }

      const result = { jobsByBuild };
      setCache(cacheKey, result, TTL);
      return cachedJson(result, CDN_CACHE);
    }

    const jobs = await queryClickHouse(`
      SELECT
        j.build_id AS build_id,
        j.name AS name,
        j.state AS state,
        j.web_url AS web_url,
        b.commit AS commit_sha,
        b.branch AS branch
      FROM buildkite.build_job AS j FINAL
      INNER JOIN (
        SELECT id, commit, branch
        FROM buildkite.build FINAL
        WHERE id IN {buildIds:Array(String)} AND NOT _fivetran_deleted
      ) AS b ON j.build_id = b.id
      WHERE j.build_id IN {buildIds:Array(String)}
        AND NOT j._fivetran_deleted
        AND j.type = 'script'
        AND j.name IS NOT NULL
    `, { buildIds });

    const rawJobsByBuild = new Map<
      string,
      { name: string; state: string; web_url?: string }[]
    >();
    const refsByBuild = new Map<
      string,
      { commit: string | null; branch: string | null }
    >();
    for (const job of jobs) {
      const row = job as Record<string, string | null>;
      if (!row.build_id || !row.name || !row.state) continue;
      if (!refsByBuild.has(row.build_id)) {
        refsByBuild.set(row.build_id, {
          commit: row.commit_sha,
          branch: row.branch,
        });
      }
      const buildJobs = rawJobsByBuild.get(row.build_id) ?? [];
      buildJobs.push({
        name: row.name,
        state: row.state,
        web_url: row.web_url ?? undefined,
      });
      rawJobsByBuild.set(row.build_id, buildJobs);
    }

    const groupSet = new Set(groups);
    const jobsByBuild: Record<string, Record<string, JobInfo[]>> = {};
    const mappingsByCommit = new Map<
      string,
      ReturnType<typeof getTestAreaMappingForCommit>
    >();
    for (const ref of refsByBuild.values()) {
      const mappingKey = `${ref.branch ?? ""}:${ref.commit ?? ""}`;
      if (!mappingsByCommit.has(mappingKey)) {
        mappingsByCommit.set(
          mappingKey,
          getTestAreaMappingForCommit(ref.commit, ref.branch),
        );
      }
    }
    for (const buildId of buildIds) {
      const ref = refsByBuild.get(buildId);
      const mappingKey = `${ref?.branch ?? ""}:${ref?.commit ?? ""}`;
      let mappingPromise = mappingsByCommit.get(mappingKey);
      if (!mappingPromise) {
        mappingPromise = getTestAreaMappingForCommit(
          ref?.commit,
          ref?.branch,
        );
        mappingsByCommit.set(mappingKey, mappingPromise);
      }
      const mapping = await mappingPromise;
      const grouped = aggregateJobsByGroup(
        rawJobsByBuild.get(buildId) ?? [],
        mapping,
      );
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
