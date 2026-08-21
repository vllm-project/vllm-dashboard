import { NextRequest, NextResponse } from "next/server";
import { isBuildkiteQueueError, reprioritizeQueueJob } from "@/lib/buildkite-queue-jobs";

export const dynamic = "force-dynamic";

function hasOperatorAccess(request: NextRequest): boolean {
  const expectedToken = process.env.BUILDKITE_QUEUE_OPERATOR_TOKEN;
  const suppliedToken = request.headers.get("x-queue-operator-token");
  return Boolean(expectedToken && suppliedToken && suppliedToken === expectedToken);
}

export async function POST(request: NextRequest) {
  if (!hasOperatorAccess(request)) {
    return NextResponse.json(
      {
        error: "Promotion requires the configured queue operator token.",
        code: "QUEUE_OPERATOR_UNAUTHORIZED",
      },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: { queue?: unknown; jobUuid?: unknown };
  try {
    body = (await request.json()) as { queue?: unknown; jobUuid?: unknown };
  } catch {
    return NextResponse.json(
      { error: "The promotion request must be valid JSON.", code: "INVALID_REQUEST" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (typeof body.queue !== "string" || typeof body.jobUuid !== "string") {
    return NextResponse.json(
      { error: "A queue and job UUID are required.", code: "INVALID_REQUEST" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await reprioritizeQueueJob(body.queue, body.jobUuid);
    return NextResponse.json(
      { priority: result.priority },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
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

    console.error("Failed to reprioritize queue job:", error);
    return NextResponse.json(
      { error: "This job could not be promoted.", code: "QUEUE_REPRIORITIZE_UNAVAILABLE" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
