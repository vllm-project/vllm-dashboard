import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// Keep the default landing views warm across the CDN and application caches.
// Without this, the first request after a deploy or an idle stretch pays a
// cold fill, which on a cold serverless instance has measured ~20s for the
// Jobs view and ~3.5s for the Builds group matrix (see
// docs/jobs-performance.md and docs/builds-performance.md).
//
// The Jobs default view uses a stable window=14d URL whose cache key never
// changes. The Builds chain is recomputed each tick because the group matrix
// key embeds the current build ids, which change with every new CI build.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const base = process.env.WARM_DEFAULTS_BASE_URL ?? "https://ci.vllm.ai";
  // The diagnostic parameter bypasses the CDN URL cache so every tick reaches
  // the origin; the origin's application caches absorb the repeated work.
  const tick = Date.now();
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 14);
  const dateParams = new URLSearchParams({
    pipeline: "CI",
    branch: "main",
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  });

  async function warm(path: string, timeoutMs: number) {
    const started = performance.now();
    try {
      const response = await fetch(`${base}${path}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        ok: response.ok,
        status: response.status,
        durationMs: Math.round(performance.now() - started),
        serverTiming: response.headers.get("server-timing"),
        body: response.ok ? await response.text() : null,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        durationMs: Math.round(performance.now() - started),
        serverTiming: null,
        error: (error as Error).name,
        body: null,
      };
    }
  }

  const [jobs, builds] = await Promise.all([
    warm(`/api/jobs?pipeline=CI&branch=main&window=14d&_warm=${tick}`, 25_000),
    warm(`/api/builds?${dateParams}&page=0&_warm=${tick}`, 15_000),
  ]);

  let groups: Record<string, unknown> | null = null;
  if (builds.ok && builds.body) {
    try {
      const ids = (JSON.parse(builds.body).builds ?? [])
        .map((b: { id?: string }) => b.id)
        .filter(Boolean)
        .slice(0, 50);
      if (ids.length > 0) {
        const params = new URLSearchParams({ buildIds: ids.join(",") });
        const result = await warm(`/api/builds/groups?${params}&_warm=${tick}`, 30_000);
        groups = { ...result, body: undefined };
      }
    } catch {
      groups = { ok: false, error: "unparseable builds response" };
    }
  }

  const ok = jobs.ok && builds.ok && (groups === null || groups.ok !== false);
  return NextResponse.json(
    {
      ok,
      jobs: { ...jobs, body: undefined },
      builds: { ...builds, body: undefined },
      groups,
    },
    { status: ok ? 200 : 502 },
  );
}
