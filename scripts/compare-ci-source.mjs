#!/usr/bin/env node
/**
 * Parity check: hit each CI dashboard route with ?source=databricks and
 * ?source=otel and diff the key metrics, so you can validate the OTel path
 * before flipping CI_DATA_SOURCE=otel.
 *
 * Usage:
 *   BASE=http://localhost:3000 node scripts/compare-ci-source.mjs
 *   BASE=https://ci.vllm.ai START=2026-08-25 END=2026-09-01 node scripts/compare-ci-source.mjs
 */

const BASE = process.env.BASE ?? "http://localhost:3000";
const START = process.env.START ?? isoDaysAgo(7);
const END = process.env.END ?? isoDaysAgo(0);
const PIPELINE = process.env.PIPELINE ?? "CI";
const BRANCH = process.env.BRANCH ?? "main";

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function get(path, source) {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}source=${source}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function diff(label, a, b) {
  const match = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${match ? "OK  " : "DIFF"} ${label}`);
  if (!match) {
    console.log(`    databricks: ${JSON.stringify(a)}`);
    console.log(`    otel:       ${JSON.stringify(b)}`);
  }
  return match;
}

async function main() {
  console.log(`Comparing CI data sources against ${BASE}`);
  console.log(`Window: ${START}..${END}  pipeline=${PIPELINE} branch=${BRANCH}\n`);

  let allOk = true;

  // /api/builds
  try {
    const q = `?pipeline=${PIPELINE}&branch=${BRANCH}&startDate=${START}&endDate=${END}`;
    const [db, otel] = await Promise.all([
      get(`/api/builds${q}`, "databricks"),
      get(`/api/builds${q}`, "otel"),
    ]);
    console.log("/api/builds");
    allOk &= diff("summary.total", db.summary?.total, otel.summary?.total);
    allOk &= diff("summary.passed", db.summary?.passed, otel.summary?.passed);
    allOk &= diff("summary.failed", db.summary?.failed, otel.summary?.failed);
    allOk &= diff("builds.length", db.builds?.length, otel.builds?.length);
  } catch (e) {
    console.log(`/api/builds ERROR: ${e.message}`);
    allOk = false;
  }

  // /api/jobs
  try {
    const q = `?pipeline=${PIPELINE}&branch=${BRANCH}&startDate=${START}&endDate=${END}`;
    const [db, otel] = await Promise.all([
      get(`/api/jobs${q}`, "databricks"),
      get(`/api/jobs${q}`, "otel"),
    ]);
    console.log("/api/jobs");
    allOk &= diff("failureRanking.length", db.failureRanking?.length, otel.failureRanking?.length);
    allOk &= diff("durationStats.length", db.durationStats?.length, otel.durationStats?.length);
  } catch (e) {
    console.log(`/api/jobs ERROR: ${e.message}`);
    allOk = false;
  }

  // /api/queue
  try {
    const q = `?pipeline=${PIPELINE}&startDate=${START}&endDate=${END}`;
    const [db, otel] = await Promise.all([
      get(`/api/queue${q}`, "databricks"),
      get(`/api/queue${q}`, "otel"),
    ]);
    console.log("/api/queue");
    allOk &= diff("queueStats.length", db.queueStats?.length, otel.queueStats?.length);
    allOk &= diff("queueNames.length", db.queueNames?.length, otel.queueNames?.length);
  } catch (e) {
    console.log(`/api/queue ERROR: ${e.message}`);
    allOk = false;
  }

  // /api/cost
  try {
    const q = `?pipeline=${PIPELINE}&startDate=${START}&endDate=${END}`;
    const [db, otel] = await Promise.all([
      get(`/api/cost${q}`, "databricks"),
      get(`/api/cost${q}`, "otel"),
    ]);
    console.log("/api/cost");
    const sum = (rows) => Math.round((rows ?? []).reduce((s, r) => s + (Number(r.total_hours) || 0), 0) * 100) / 100;
    allOk &= diff("byQueue total_hours", sum(db.byQueue), sum(otel.byQueue));
    allOk &= diff("byBuild.length", db.byBuild?.length, otel.byBuild?.length);
    allOk &= diff("byJob.length", db.byJob?.length, otel.byJob?.length);
  } catch (e) {
    console.log(`/api/cost ERROR: ${e.message}`);
    allOk = false;
  }

  console.log(allOk ? "\nAll compared metrics match." : "\nDifferences found (see above).");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
