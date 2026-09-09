import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// Keep the Jobs page's default request warm across the CDN and application
// caches. Without this, the daily date rollover empties both caches and the
// first request per region pays a cold fill, which on a cold serverless
// instance has measured up to ~20s (see docs/jobs-performance.md). The page
// computes its 14-day window client-side; the cron approximates it in UTC,
// which matches except around local midnight.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 14);
  const params = new URLSearchParams({
    pipeline: "CI",
    branch: "main",
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  });
  const base = process.env.WARM_JOBS_BASE_URL ?? "https://ci.vllm.ai";

  const started = performance.now();
  try {
    // The diagnostic parameter bypasses the CDN URL cache so every tick
    // reaches the origin; the origin's 60s application cache absorbs all but
    // one backend query per minute.
    params.set("_warm", String(Date.now()));
    const response = await fetch(`${base}/api/jobs?${params}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(50_000),
    });
    const durationMs = Math.round(performance.now() - started);
    return NextResponse.json({
      ok: response.ok,
      status: response.status,
      durationMs,
      serverTiming: response.headers.get("server-timing"),
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Warm-up request failed: ${(error as Error).name}` },
      { status: 502 },
    );
  }
}
