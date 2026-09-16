import { NextResponse } from "next/server";

import { cachedJson } from "@/lib/api-response";
import { GitHubError, loadParitySnapshot } from "@/lib/gpu-parity-source";

export const maxDuration = 60;

// Current NVIDIA-to-AMD mirror parity for vllm-project/vllm main. The data
// changes only when `.buildkite/test_areas` changes, so the CDN may serve a
// stale copy for a day while the origin refreshes hourly.
const CDN_CACHE = { maxAge: 300, staleWhileRevalidate: 86_400 };

export async function GET() {
  try {
    const snapshot = await loadParitySnapshot();
    return cachedJson(snapshot, CDN_CACHE);
  } catch (error) {
    console.error("Failed to load GPU parity snapshot:", error);
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
