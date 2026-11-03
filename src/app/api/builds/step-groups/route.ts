import { NextRequest, NextResponse } from "next/server";
import { fetchStepGroups, type StepGroupsResult } from "@/lib/buildkite-step-groups";

export const runtime = "nodejs";

const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const CACHE_LIMIT = 200;
// The generated pipeline never changes once uploaded, so a found mapping is
// kept for the life of the process (bounded by CACHE_LIMIT).
const cache = new Map<string, StepGroupsResult["groups"]>();

export async function GET(request: NextRequest) {
  const organization = request.nextUrl.searchParams.get("organization") ?? "";
  const pipeline = request.nextUrl.searchParams.get("pipeline") ?? "";
  const buildNumber = request.nextUrl.searchParams.get("buildNumber") ?? "";
  if (!SLUG.test(organization) || !SLUG.test(pipeline) || !/^\d{1,12}$/.test(buildNumber)) {
    return NextResponse.json({ error: "Invalid build" }, { status: 400 });
  }

  const key = `${organization}/${pipeline}/${buildNumber}`;
  const cached = cache.get(key);
  if (cached) {
    return NextResponse.json({ ...cached, complete: true }, {
      headers: { "Cache-Control": "private, max-age=3600" },
    });
  }

  try {
    const { groups, complete } = await fetchStepGroups(organization, pipeline, buildNumber);
    if (complete) {
      cache.set(key, groups);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    }
    return NextResponse.json({ ...groups, complete }, {
      headers: { "Cache-Control": complete ? "private, max-age=3600" : "no-store" },
    });
  } catch {
    // Grouping is an enhancement; the timeline still works flat.
    return NextResponse.json(
      { byKey: {}, byLabel: {}, order: [], complete: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
