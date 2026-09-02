import { NextRequest, NextResponse } from "next/server";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { BuildkiteQueueError, getQueueJobs } from "@/lib/buildkite-queue-jobs";

const TTL = 60_000;
const CDN_CACHE = { maxAge: 30, staleWhileRevalidate: 3_600 };

// Waiting jobs come from the live Buildkite GraphQL API (scheduled jobs in the
// queue), aggregated per build. OTel spans only exist once a job finishes, so
// they cannot see jobs that are still waiting.
export async function GET(request: NextRequest) {
  const queue = request.nextUrl.searchParams.get("queue");
  if (!queue) {
    return NextResponse.json({ error: "queue parameter required" }, { status: 400 });
  }

  const cacheKey = `waiting-builds:${queue}`;
  const cached = getCached(cacheKey);
  if (cached) return cachedJson(cached, CDN_CACHE);

  try {
    const { jobs } = await getQueueJobs(queue);
    const now = Date.now();

    const byBuild = new Map<
      string,
      {
        build_number: number | null;
        build_url: string;
        message: string | null;
        author: string | null;
        waiting_jobs: number;
        max_wait_min: number;
      }
    >();

    for (const job of jobs) {
      // The job URL is the build URL with a job fragment.
      const buildUrl = job.build?.url ?? job.url.split("#")[0];
      const buildNumber = job.build?.number ?? null;
      const waitedMs =
        now - new Date(job.runnableAt ?? job.scheduledAt).getTime();
      const waitMin = Math.max(0, Math.round(waitedMs / 60000));

      const entry = byBuild.get(buildUrl) ?? {
        build_number: buildNumber,
        build_url: buildUrl,
        message: job.build?.message ?? null,
        author: job.build?.author ?? null,
        waiting_jobs: 0,
        max_wait_min: 0,
      };
      entry.waiting_jobs += 1;
      entry.max_wait_min = Math.max(entry.max_wait_min, waitMin);
      byBuild.set(buildUrl, entry);
    }

    const builds = [...byBuild.values()]
      .sort((a, b) => b.waiting_jobs - a.waiting_jobs)
      .slice(0, 5);

    const result = { builds };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    if (error instanceof BuildkiteQueueError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error("Failed to fetch waiting builds:", error);
    return NextResponse.json(
      { error: "Failed to fetch waiting builds" },
      { status: 500 },
    );
  }
}
