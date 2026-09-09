#!/usr/bin/env node
// Run with: node --env-file=.env.local --import tsx scripts/profile-filters-db.mjs
// Times the two /api/builds/filters OTel queries separately, bypassing
// browser, CDN, and application caches. No row contents are logged.
import { getDb } from "../src/lib/db.ts";

const budget = Number(process.env.MAX_MS ?? 3000);
if (!Number.isFinite(budget) || budget <= 0) throw new Error("MAX_MS must be positive");
const db = getDb();

async function timeQuery(label, run) {
  const started = performance.now();
  const rows = await run();
  const ms = Math.round(performance.now() - started);
  const pass = ms <= budget;
  console.log(JSON.stringify({ query: label, ms, rows: rows.length, verdict: pass ? "PASS" : "FAIL" }));
  if (!pass) process.exitCode = 1;
}

try {
  for (let sample = 1; sample <= 2; sample++) {
    console.log(JSON.stringify({ sample, freshConnectionPool: sample === 1 }));
    await timeQuery("pipelines-unbounded", () => db`
      SELECT DISTINCT resource_attributes->>'buildkite.pipeline.name' AS name
      FROM otel_spans
      WHERE span_name = 'buildkite.build'
        AND resource_attributes->>'buildkite.pipeline.name' IS NOT NULL
      ORDER BY name
    `);
    await timeQuery("branches-30d", () => db`
      SELECT DISTINCT span_attributes->>'buildkite.build.branch' AS branch
      FROM otel_spans
      WHERE span_name = 'buildkite.build'
        AND start_time > NOW() - INTERVAL '30 days'
        AND span_attributes->>'buildkite.build.branch' IS NOT NULL
      ORDER BY branch
    `);
  }
} catch (error) {
  console.error(`FAIL: filters probe could not complete (${error.name})`);
  process.exitCode = 1;
} finally {
  await db.end();
}
