#!/usr/bin/env node
// Read-only latency probe. No credentials or response bodies are logged.
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
});
if (process.env.SOURCE) {
  if (!["otel", "databricks"].includes(process.env.SOURCE)) throw new Error("SOURCE must be otel or databricks");
  params.set("source", process.env.SOURCE);
}

async function measure(path, sample, jobs = false) {
  const url = new URL(path, base);
  // Bypasses the CDN URL cache, but deliberately leaves the application's
  // semantic cache key intact. MISS at the CDN need not mean a database read.
  if (process.env.BYPASS_CDN === "1") url.searchParams.set("_profile", `${Date.now()}-${sample}`);
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(40_000) });
  const ttfb = performance.now() - started;
  const body = await response.text();
  const elapsed = performance.now() - started;
  let valid = response.ok;
  if (jobs) {
    try {
      const data = JSON.parse(body);
      valid &&= Array.isArray(data.failureRanking) && Array.isArray(data.durationStats) && !data.error;
    } catch {
      valid = false;
    }
  }
  const pass = valid && (!jobs || elapsed <= budget);
  console.log(JSON.stringify({
    path: url.pathname, sample, status: response.status,
    ttfbMs: Math.round(ttfb), totalMs: Math.round(elapsed), bytes: Buffer.byteLength(body),
    cdnCache: response.headers.get("x-vercel-cache"), age: response.headers.get("age"),
    serverTiming: response.headers.get("server-timing"),
    verdict: pass ? "PASS" : "FAIL",
  }));
  if (!pass) process.exitCode = 1;
}

try {
  await measure("/jobs", 1);
  const filters = new URLSearchParams();
  if (params.has("source")) filters.set("source", params.get("source"));
  await measure(`/api/builds/filters?${filters}`, 1);
  for (let sample = 1; sample <= samples; sample++) {
    await measure(`/api/jobs?${params}`, sample, true);
  }
} catch (error) {
  console.error(`FAIL: jobs probe could not complete (${error.name})`);
  process.exitCode = 1;
}
