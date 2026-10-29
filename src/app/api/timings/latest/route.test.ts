import assert from "node:assert/strict";
import { createRequire } from "node:module";
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

const require = createRequire(import.meta.url);

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

const LABEL = "pytest -v -s lora";
const JOB = "00000000-0000-0000-0000-000000000001";

// One passing main build of one job: 500s long, of which its test command
// took 450s. test_a.py's cases sum to 300s, test_b.py's to 100s.
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): unknown {
  const text = strings.join("?");
  if (!text.includes("SELECT")) return { text, values }; // a nested fragment
  if (text.includes("'buildkite.job'")) {
    return Promise.resolve([{
      build_number: "101", commit: "abc123", finished_at: new Date("2026-10-29T00:00:00Z"),
      job_ids: [JOB], job_ms: [500_000],
    }]);
  }
  if (text.includes("LEFT JOIN")) {
    const test = (nodeid: string, ms: number) => ({
      job_id: JOB, duration_ms: ms, nodeid, outcome: "passed",
      command_span_id: "span-1", command_label: LABEL,
    });
    return Promise.resolve([
      test("lora/test_a.py::test_x", 250_000),
      test("lora/test_a.py::test_y", 50_000),
      test("lora/test_b.py::test_z", 100_000),
    ]);
  }
  return Promise.resolve([{ job_id: JOB, label: LABEL, duration_ms: 450_000 }]);
}

async function getTimings(query: string): Promise<Response> {
  // Replace the DB boundary before the route loads latest-test-timings, which
  // reads getDb from the db module's exports once.
  await import("@/lib/db");
  const dbModule = require.cache[require.resolve("@/lib/db")];
  assert.ok(dbModule);
  dbModule.exports = { getDb: () => fakeSql as Sql };
  const { GET } = await import("./route");
  return GET(new NextRequest(`http://localhost/api/timings/latest?${query}`));
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
