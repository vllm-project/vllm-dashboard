import { NextRequest, NextResponse } from "next/server";
import { getQueueJobs, isBuildkiteQueueError } from "@/lib/buildkite-queue-jobs";

export const dynamic = "force-dynamic";

export type QueueJobsQuery = {
  queue?: string; // Empty or invalid queue returns a 400 error
};

function responseError(error: unknown) {
  if (isBuildkiteQueueError(error)) {
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (error.retryAfterSeconds !== undefined) {
      headers["Retry-After"] = String(error.retryAfterSeconds);
    }
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status, headers },
    );
  }

  console.error("Failed to fetch current queue jobs:", error);
  return NextResponse.json(
    { error: "Current queue jobs could not be loaded.", code: "QUEUE_JOBS_UNAVAILABLE" },
    { status: 502, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Live jobs currently waiting in a queue
 * @description Fetched live from the Buildkite GraphQL API (no caching). Errors surface Buildkite status codes, e.g. 400 INVALID_QUEUE, 503 BUILDKITE_NOT_CONFIGURED, 429 with Retry-After when rate-limited.
 * @params QueueJobsQuery
 * @tag Queue
 * @openapi
 */
export async function GET(request: NextRequest) {
  const queue = request.nextUrl.searchParams.get("queue") ?? "";

  try {
    const { jobs } = await getQueueJobs(queue);
    return NextResponse.json(
      {
        jobs,
        operatorAccessRequired: Boolean(process.env.BUILDKITE_QUEUE_OPERATOR_TOKEN),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return responseError(error);
  }
}
