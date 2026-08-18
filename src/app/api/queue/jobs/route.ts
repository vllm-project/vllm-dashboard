import { NextRequest, NextResponse } from "next/server";
import { BuildkiteQueueError, getQueueJobs } from "@/lib/buildkite-queue-jobs";

export const dynamic = "force-dynamic";

function responseError(error: unknown) {
  if (error instanceof BuildkiteQueueError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  console.error("Failed to fetch current queue jobs:", error);
  return NextResponse.json(
    { error: "Current queue jobs could not be loaded.", code: "QUEUE_JOBS_UNAVAILABLE" },
    { status: 502, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: NextRequest) {
  const queue = request.nextUrl.searchParams.get("queue") ?? "";

  try {
    const { jobs, waitingCount } = await getQueueJobs(queue);
    return NextResponse.json(
      {
        jobs,
        waitingCount,
        operatorAccessRequired: Boolean(process.env.BUILDKITE_QUEUE_OPERATOR_TOKEN),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return responseError(error);
  }
}
