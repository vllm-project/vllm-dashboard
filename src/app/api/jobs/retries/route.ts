import { NextRequest, NextResponse } from "next/server";
import { getOrLoadCached } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { ServerTiming } from "@/lib/server-timing";
import {
  rankRetryJobs,
  parseRetryFilters,
  queryRetriesFromOtel,
  queryRetriesFromWarehouse,
  RetryFilterError,
} from "@/lib/job-retries";

const TTL = 60_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };

export async function GET(request: NextRequest) {
  const timing = new ServerTiming();
  try {
    const source = resolveCiDataSource(request);
    timing.describe("source", source);
    const filters = parseRetryFilters(request.nextUrl.searchParams);
    const cacheKey = `job-retries:${JSON.stringify([source, filters.pipeline, filters.branch, filters.rangeKey])}`;
    const { data: result, status } = await getOrLoadCached(cacheKey, TTL, async () => {
      const rows = await timing.measure("retries", source === "otel"
        ? queryRetriesFromOtel(filters)
        : queryRetriesFromWarehouse(filters));
      return { source, retryRanking: rankRetryJobs(rows) };
    });
    timing.describe("cache", status);
    const response = cachedJson(result, CDN_CACHE);
    response.headers.set("Server-Timing", timing.header());
    return response;
  } catch (error) {
    if (error instanceof RetryFilterError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    timing.describe("cache", "ERROR");
    console.error("Failed to fetch job retries:", error);
    return NextResponse.json(
      { error: "Failed to fetch job retries" },
      { status: 500, headers: { "Server-Timing": timing.header() } },
    );
  }
}
