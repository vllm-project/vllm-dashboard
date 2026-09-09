#!/usr/bin/env node
// Run with: node --env-file=.env.local --import tsx scripts/profile-groups.mjs
// Times the /api/builds/groups data fetch both ways for the same 50 builds:
// the Buildkite REST roster fan-out (current OTel path) versus a single
// OTel SQL query (the fallback). No credentials or row contents are logged.
import { queryBuildsFromOtel, queryBuildJobsFromOtel } from "../src/lib/otel-ci.ts";
import { getBuildJobRosterRows } from "../src/lib/buildkite-build-jobs.ts";
import { getDb } from "../src/lib/db.ts";

const budget = Number(process.env.MAX_MS ?? 3000);
if (!Number.isFinite(budget) || budget <= 0) throw new Error("MAX_MS must be positive");

const end = new Date();
const start = new Date(end);
start.setUTCDate(start.getUTCDate() - 14);

const db = getDb();
try {
  const { builds } = await queryBuildsFromOtel({
    pipeline: process.env.PIPELINE ?? "CI",
    branch: process.env.BRANCH ?? "main",
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    page: 0,
    pageSize: 50,
    jobGroups: [],
    jobNames: [],
  });
  const buildIds = builds.map((b) => b.id).filter(Boolean);
  console.log(JSON.stringify({ builds: buildIds.length }));

  for (let sample = 1; sample <= 2; sample++) {
    let started = performance.now();
    const rosterRows = await getBuildJobRosterRows(buildIds);
    const rosterMs = Math.round(performance.now() - started);

    started = performance.now();
    const otelRows = await queryBuildJobsFromOtel(buildIds);
    const otelMs = Math.round(performance.now() - started);

    const pass = rosterMs <= budget;
    console.log(JSON.stringify({
      sample, rosterMs, rosterRows: rosterRows.length,
      otelMs, otelRows: otelRows.length,
      verdict: pass ? "PASS" : "FAIL",
    }));
    if (!pass) process.exitCode = 1;
  }
} catch (error) {
  console.error(`FAIL: groups probe could not complete (${error.name})`);
  process.exitCode = 1;
} finally {
  await db.end();
}
