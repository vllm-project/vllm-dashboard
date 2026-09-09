#!/usr/bin/env node
// Read-only latency probe for the main (Builds) page request chain:
// page shell -> /api/builds -> /api/builds/groups (buildIds from the builds
// response). No credentials or response bodies are logged; only counts.
const base = process.env.BASE ?? "http://localhost:3000";
const samples = Number(process.env.SAMPLES ?? 3);
const budget = Number(process.env.MAX_MS ?? 3000);
if (!Number.isInteger(samples) || samples < 1 || samples > 20 || !Number.isFinite(budget) || budget <= 0) {
  throw new Error("SAMPLES must be 1–20 and MAX_MS must be positive");
}
const end = new Date();
const start = new Date(end);
start.setUTCDate(start.getUTCDate() - 14);
const params = new URLSearchParams({
  pipeline: process.env.PIPELINE ?? "CI",
  branch: process.env.BRANCH ?? "main",
  startDate: process.env.START ?? start.toISOString().slice(0, 10),
  endDate: process.env.END ?? end.toISOString().slice(0, 10),
  page: "0",
});
if (process.env.SOURCE) {
  if (!["otel", "databricks"].includes(process.env.SOURCE)) throw new Error("SOURCE must be otel or databricks");
  params.set("source", process.env.SOURCE);
}

function bypass(url) {
  // Bypasses the CDN URL cache, but deliberately leaves the application's
  // semantic cache key intact. MISS at the CDN need not mean a database read.
  if (process.env.BYPASS_CDN === "1") url.searchParams.set("_profile", `${Date.now()}-${Math.random()}`);
  return url;
}

async function timedFetch(url) {
  const started = performance.now();
  const response = await fetch(bypass(url), { signal: AbortSignal.timeout(60_000) });
  const ttfb = performance.now() - started;
  const body = await response.text();
  const elapsed = performance.now() - started;
  return { response, body, ttfb, elapsed };
}

function report(path, sample, r, extra = {}) {
  console.log(JSON.stringify({
    path, sample, status: r.response.status,
    ttfbMs: Math.round(r.ttfb), totalMs: Math.round(r.elapsed),
    bytes: Buffer.byteLength(r.body),
    cdnCache: r.response.headers.get("x-vercel-cache"), age: r.response.headers.get("age"),
    serverTiming: r.response.headers.get("server-timing"),
    ...extra,
  }));
}

try {
  for (let sample = 1; sample <= samples; sample++) {
    const chainStart = performance.now();

    const shell = await timedFetch(new URL("/", base));
    report("/", sample, shell);

    const filtersParams = new URLSearchParams();
    if (params.has("source")) filtersParams.set("source", params.get("source"));
    const filters = await timedFetch(new URL(`/api/builds/filters?${filtersParams}`, base));
    report("/api/builds/filters", sample, filters);

    const builds = await timedFetch(new URL(`/api/builds?${params}`, base));
    let buildIds = [];
    let buildsValid = builds.response.ok;
    try {
      const data = JSON.parse(builds.body);
      buildsValid &&= Array.isArray(data.builds) && !data.error;
      buildIds = data.builds.map((b) => b.id).filter(Boolean);
    } catch {
      buildsValid = false;
    }
    report("/api/builds", sample, builds, { builds: buildIds.length, valid: buildsValid });

    let groupsMs = 0;
    let groupsValid = true;
    if (buildIds.length > 0) {
      const groupsParams = new URLSearchParams({ buildIds: buildIds.join(",") });
      if (params.has("source")) groupsParams.set("source", params.get("source"));
      const groups = await timedFetch(new URL(`/api/builds/groups?${groupsParams}`, base));
      groupsMs = groups.elapsed;
      try {
        const data = JSON.parse(groups.body);
        groupsValid = groups.response.ok && Array.isArray(data.jobOptions) && !data.error;
        report("/api/builds/groups", sample, groups, {
          jobOptions: data.jobOptions?.length ?? 0, valid: groupsValid,
        });
      } catch {
        groupsValid = false;
        report("/api/builds/groups", sample, groups, { valid: false });
      }
    }

    const chainMs = performance.now() - chainStart;
    const pass = shell.response.ok && buildsValid && groupsValid && chainMs <= budget;
    console.log(JSON.stringify({
      path: "CHAIN", sample, chainMs: Math.round(chainMs),
      groupsMs: Math.round(groupsMs), verdict: pass ? "PASS" : "FAIL",
    }));
    if (!pass) process.exitCode = 1;
  }
} catch (error) {
  console.error(`FAIL: builds probe could not complete (${error.name})`);
  process.exitCode = 1;
}
