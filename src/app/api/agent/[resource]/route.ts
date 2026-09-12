import { NextRequest, NextResponse } from "next/server";
import { AgentApiError, agentBuilds, validateAgentParams } from "@/lib/agent-buildkite";
import { agentFailures, agentQueues } from "@/lib/agent-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ resource: string }> }) {
  const { resource } = await context.params;
  const params = request.nextUrl.searchParams;
  const source = resource === "build" || resource === "builds" ? "buildkite-rest" : "postgres";
  try {
    validateAgentParams(resource, params);
    const data = resource === "build" || resource === "builds" ? await agentBuilds(params, resource === "build")
      : resource === "failures" ? await agentFailures(params)
      : resource === "queues" ? await agentQueues(params)
      : null;
    if (data === null) throw new AgentApiError("Unknown resource. Read /agents.md", 404);
    const fetchedAt = new Date().toISOString();
    return NextResponse.json({ schemaVersion: 1, source, fetchedAt,
      ...(source === "buildkite-rest" ? { observedAt: fetchedAt } : {}), ...data },
    { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (!(error instanceof AgentApiError)) console.error("Agent API failed", error);
    return NextResponse.json({ schemaVersion: 1, error: error instanceof AgentApiError ? error.message : "Data unavailable; do not interpret this as an empty or healthy result" },
      { status: error instanceof AgentApiError ? error.status : 502,
        headers: { "Cache-Control": "no-store", ...(error instanceof AgentApiError && error.retryAfter ? { "Retry-After": error.retryAfter } : {}) } });
  }
}
