import { NextRequest, NextResponse } from "next/server";
import { cachedJson } from "@/lib/api-response";
import { queryLatestTestTimings, TimingDataError } from "@/lib/latest-test-timings";

export const runtime = "nodejs";

const STEP_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,199}$/;
// A median over 20 builds moves slowly, so an hour-old answer is still current.
const CDN_CACHE = { maxAge: 3_600, staleWhileRevalidate: 3_600 };

function error(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const stepKey = params.get("stepKey") ?? "";
  const days = Number(params.get("days") ?? 14);
  if (!STEP_KEY.test(stepKey)) return error("stepKey is required", 400);
  if (!Number.isInteger(days) || days < 1 || days > 30) return error("days must be 1-30", 400);

  try {
    const timings = await queryLatestTestTimings(stepKey, { days });
    if (!timings) {
      return error(`No main CI build in the last ${days} days where every ${stepKey} job passed with test spans`, 404);
    }
    return cachedJson(timings, CDN_CACHE);
  } catch (e) {
    if (e instanceof TimingDataError) return error(e.message, 422);
    console.error("Latest test timings query failed:", e);
    return error("Failed to query test timings", 500);
  }
}
