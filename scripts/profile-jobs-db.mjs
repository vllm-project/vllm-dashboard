#!/usr/bin/env node
// Run with: node --env-file=.env.local --import tsx scripts/profile-jobs-db.mjs
// Uses the real OTel handler, bypassing browser, CDN, and application caches.
import { getDb } from "../src/lib/db.ts";
import { queryJobStatsFromOtel } from "../src/lib/otel-ci.ts";
import { ServerTiming } from "../src/lib/server-timing.ts";

const end = new Date();
const start = new Date(end);
start.setUTCDate(start.getUTCDate() - 14);
const budget = Number(process.env.MAX_MS ?? 3000);
if (!Number.isFinite(budget) || budget <= 0) throw new Error("MAX_MS must be positive");
const db = getDb();
const previousDebug = db.options.debug;
let queryCount = 0;
let started = 0;
let dispatchMs = [];
db.options.debug = (_connection, query) => {
  if (query.includes("AS failure_rate") || query.includes("AS p50_duration")) {
    queryCount++;
    dispatchMs.push(Math.round(performance.now() - started));
  }
};

try {
  for (let sample = 1; sample <= 3; sample++) {
    queryCount = 0;
    dispatchMs = [];
    const timing = new ServerTiming();
    started = performance.now();
    const result = await queryJobStatsFromOtel({
      pipeline: process.env.PIPELINE ?? "CI",
      branch: process.env.BRANCH ?? "main",
      startDate: process.env.START ?? start.toISOString().slice(0, 10),
      endDate: process.env.END ?? end.toISOString().slice(0, 10),
      hasDateRange: true,
    }, timing);
    const ms = Math.round(performance.now() - started);
    const pass = queryCount === 1 && ms <= budget;
    console.log(JSON.stringify({
      sample, freshConnectionPool: sample === 1, ms, queryCount, dispatchMs,
      failureRows: result.failureRanking.length, durationRows: result.durationStats.length,
      serverTiming: timing.header(), verdict: pass ? "PASS" : "FAIL",
    }));
    if (!pass) process.exitCode = 1;
  }
} catch (error) {
  console.error(`FAIL: database jobs probe could not complete (${error.name})`);
  process.exitCode = 1;
} finally {
  db.options.debug = previousDebug;
  await db.end();
}
