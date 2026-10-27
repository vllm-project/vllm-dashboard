import { NextRequest, NextResponse } from "next/server";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { queryObservedSteps } from "@/lib/automatic-sharding-query";
import {
  classifyShardingJobs,
  SHARDING_WINDOWS,
  summarizeSharding,
} from "@/lib/automatic-sharding";
import { ensureTestAreas } from "@/lib/test-areas";

const TTL = 10 * 60 * 1000;
const CDN_CACHE = { maxAge: 300, staleWhileRevalidate: 3_600 };

/**
 * Which CI jobs (the test-area YAML on vLLM main, and their AMD mirrors) are
 * on automatic sharding, and how each ran on main over the last `days` days.
 */
export async function GET(request: NextRequest) {
  const requested = Number(request.nextUrl.searchParams.get("days") ?? 7);
  const days = (SHARDING_WINDOWS as readonly number[]).includes(requested)
    ? requested
    : 7;
  const cacheKey = `sharding:${days}`;
  const cached = getCached(cacheKey);
  if (cached) return cachedJson(cached, CDN_CACHE);

  try {
    const [areas, observed] = await Promise.all([
      ensureTestAreas(),
      queryObservedSteps(days),
    ]);
    if (areas.length === 0) {
      return NextResponse.json(
        { error: "Could not load the CI test areas from vLLM main" },
        { status: 502 },
      );
    }
    const jobs = classifyShardingJobs(areas, observed);
    const result = {
      days,
      summary: summarizeSharding(jobs),
      jobs,
      generatedAt: new Date().toISOString(),
    };
    setCache(cacheKey, result, TTL);
    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to build the sharding report:", error);
    return NextResponse.json(
      { error: "Failed to build the sharding report" },
      { status: 500 },
    );
  }
}
