import { NextResponse } from "next/server";

import { cachedJson } from "@/lib/api-response";
import { GitHubError } from "@/lib/gpu-parity-source";
import { loadPlatformScopeSnapshot } from "@/lib/platform-scope-source";

export const maxDuration = 60;

// Common / NVIDIA-only / ROCm-only scope of every GPU job in vllm-project/vllm
// main's `.buildkite/test_areas`, using the dashboard's platform rules. The
// CDN may serve a stale copy for a day while the origin refreshes hourly.
const CDN_CACHE = { maxAge: 300, staleWhileRevalidate: 86_400 };

export async function GET() {
  try {
    const snapshot = await loadPlatformScopeSnapshot();
    return cachedJson(snapshot, CDN_CACHE);
  } catch (error) {
    console.error("Failed to load platform scope snapshot:", error);
    const rateLimited = error instanceof GitHubError && error.rateLimited;
    return NextResponse.json(
      {
        error: rateLimited
          ? "GitHub API rate limit exhausted; retry later"
          : "Failed to read .buildkite/test_areas from GitHub",
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
