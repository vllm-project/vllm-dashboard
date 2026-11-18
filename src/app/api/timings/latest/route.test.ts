import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

// This route is a CI contract: ci-infra's runtime shard planner
// (buildkite/pipeline_generator/runtime_shard.py, fetch_timings and plan)
// calls it once per sharded step while generating every vLLM CI build. The
// planner reads setupMs, buildNumber, buildNumbers, and per file command,
// file, observedMs and tests[].nodeid/observedMs, all durations in
// milliseconds, and matches files to its commands by the exact command label.
// A response it can't read makes the step run as one unsharded job, which can
// time out; a readable but wrong one gives a silently bad plan. Change these
// fields only together with the planner.

const LABEL = "pytest -v -s lora";
const JOB = "00000000-0000-0000-0000-000000000001";

// One passing main build of one job: 500s long, of which its test command
// took 450s. test_a.py's cases sum to 300s, test_b.py's to 100s. The fake
// answers ClickHouse's HTTP interface the way queryClickHouse reads it.
function answer(sql: string, url: URL): object[] {
  if (sql.includes("GROUP BY build_number")) {
    if (url.searchParams.get("param_branch") !== "main") return [];
    return [{
      build_number: "101", commit: "abc123", finished_at: "2026-10-29T00:00:00.000000Z",
      jobs: JSON.stringify([[JOB, 500_000]]),
    }];
  }
  if (sql.includes("AS orphans")) return [{ job_id: JOB, orphans: "0" }];
  if (sql.includes("LEFT JOIN")) {
    const test = (nodeid: string, ms: number) => ({
      job_id: JOB, duration_ms: String(ms), nodeid, outcome: "passed",
      command_span_id: "span-1", command_label: LABEL,
    });
    return [
      test("lora/test_a.py::test_x", 250_000),
      test("lora/test_a.py::test_y", 50_000),
      test("lora/test_b.py::test_z", 100_000),
    ];
  }
  return [{ job_id: JOB, label: LABEL, duration_ms: "450000" }];
}

async function getTimings(
  query: string, respond: (sql: string, url: URL) => object[] = answer,
): Promise<Response> {
  process.env.CLICKHOUSE_URL = "https://clickhouse.test";
  process.env.CLICKHOUSE_READ_USER = "reader";
  process.env.CLICKHOUSE_READ_PASSWORD = "secret";
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const rows = respond(String(init?.body), new URL(String(input)));
    return new Response(rows.map((row) => JSON.stringify(row)).join("\n"), { status: 200 });
  }) as typeof fetch;
  try {
    const { GET } = await import("./route");
    return await GET(new NextRequest(`http://localhost/api/timings/latest?${query}`));
  } finally {
    globalThis.fetch = original;
  }
}

test("the response carries every field the shard planner reads, in milliseconds", async () => {
  const response = await getTimings("stepKey=lora&testsOverMs=200000");
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.setupMs, 50_000);
  assert.equal(body.buildNumber, 101);
  assert.deepEqual(body.buildNumbers, [101]);

  const files = new Map(body.files.map((file: { file: string }) => [file.file, file]));
  assert.deepEqual([...files.keys()].sort(), ["lora/test_a.py", "lora/test_b.py"]);
  for (const file of files.values()) {
    assert.equal((file as { command: string }).command, LABEL);
  }
  assert.equal((files.get("lora/test_a.py") as { observedMs: number }).observedMs, 300_000);
  assert.equal((files.get("lora/test_b.py") as { observedMs: number }).observedMs, 100_000);
});

test("per-test timings come only for files over testsOverMs", async () => {
  const response = await getTimings("stepKey=lora&testsOverMs=200000");
  const body = await response.json();
  const files = new Map(body.files.map((file: { file: string }) => [file.file, file]));

  assert.deepEqual((files.get("lora/test_a.py") as { tests: unknown }).tests, [
    { nodeid: "lora/test_a.py::test_x", observedMs: 250_000 },
    { nodeid: "lora/test_a.py::test_y", observedMs: 50_000 },
  ]);
  assert.ok(!("tests" in (files.get("lora/test_b.py") as object)));
});

// Build 102, the window's only passing build, is broken: its job is shorter
// than the test command inside it. Build 101 (answer() above) is intact but
// only a look-back below 102 finds it; with `older` false nothing does.
const BROKEN_JOB = "00000000-0000-0000-0000-000000000002";
function brokenWindow(older: boolean) {
  return (sql: string, url: URL): object[] => {
    if (sql.includes("GROUP BY build_number")) {
      if (url.searchParams.get("param_branch") !== "main") return [];
      if (url.searchParams.get("param_before") === "102") return older ? answer(sql, url) : [];
      return [{
        build_number: "102", commit: "def456", finished_at: "2026-11-17T16:00:00.000000Z",
        jobs: JSON.stringify([[BROKEN_JOB, 1_000]]),
      }];
    }
    if (sql.includes("AS orphans")) return [{ job_id: JOB, orphans: "0" }, { job_id: BROKEN_JOB, orphans: "0" }];
    const rows = answer(sql, url);
    if (sql.includes("LEFT JOIN")) {
      return [...rows, ...rows.map((row) => ({ ...row, job_id: BROKEN_JOB, command_span_id: "span-2" }))];
    }
    return [...rows, { job_id: BROKEN_JOB, label: LABEL, duration_ms: "450000" }];
  };
}

test("a window of only broken builds is served from older valid builds", async () => {
  const response = await getTimings("stepKey=lora&queue=l4-k8s", brokenWindow(true));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.buildNumber, 101);
  assert.deepEqual(body.buildNumbers, [101]);
  assert.equal(body.setupMs, 50_000);
  assert.deepEqual(body.skippedBuilds, [
    { buildNumber: 102, reason: `Job ${BROKEN_JOB} is shorter than its test commands` },
  ]);
  assert.deepEqual(body.files.map((file: { file: string }) => file.file), ["lora/test_a.py", "lora/test_b.py"]);
});

test("no valid build in or before the window is a 422", async () => {
  const response = await getTimings("stepKey=lora", brokenWindow(false));
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /shorter than its test commands/);
});
