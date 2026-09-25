import { NextRequest, NextResponse } from "next/server";

import { cachedJson } from "@/lib/api-response";
import {
  clampHistoryWeeks,
  GitHubError,
  loadParityHistory,
} from "@/lib/gpu-parity-source";

export const maxDuration = 60;

// Weekly samples cost one GitHub API call per week plus one raw fetch per
// changed YAML file, so keep the CDN copy for an hour and serve stale for a
// day while the origin recomputes.
const CDN_CACHE = { maxAge: 3_600, staleWhileRevalidate: 86_400 };

export async function GET(request: NextRequest) {
  const weeks = clampHistoryWeeks(request.nextUrl.searchParams.get("weeks"));
  try {
    const history = await loadParityHistory(weeks);
    return cachedJson(history, CDN_CACHE);
  } catch (error) {
    console.error("Failed to load GPU parity history:", error);
    const rateLimited = error instanceof GitHubError && error.rateLimited;
    return NextResponse.json(
      {
        error: rateLimited
          ? "GitHub API rate limit exhausted; retry later"
          : "Failed to sample .buildkite/test_areas history from GitHub",
      },
      {
        status: rateLimited ? 503 : 502,
        headers: {
          "Cache-Control": "no-store",
          ...(rateLimited ? { "Retry-After": "600" } : {}),
        },
      },
    );
  }
}
