import assert from "node:assert/strict";
import test from "node:test";
import { clickHousePassingBuilds, clickHouseTimingSpans } from "./latest-test-timings-clickhouse";

type Call = { sql: string; url: URL };

function fakeClickHouse(t: test.TestContext, respond: (call: Call) => object[]): Call[] {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  process.env.CLICKHOUSE_URL = "https://ch.example";
  process.env.CLICKHOUSE_READ_USER = "reader";
  process.env.CLICKHOUSE_READ_PASSWORD = "secret";
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const call = { sql: String(init?.body), url: new URL(String(input)) };
    calls.push(call);
    const body = respond(call).map((row) => JSON.stringify(row)).join("\n");
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test("passing builds parse job arrays and keep only builds with test spans", async (t) => {
  const calls = fakeClickHouse(t, ({ sql }) => {
    if (sql.includes("GROUP BY build_number")) {
      return [
        { build_number: "12", commit: "abc", finished_at: "2026-11-13T10:00:00.000000000Z", jobs: '[["j1",1000.5],["j2",2000]]' },
        { build_number: "11", commit: "ᴺᵁᴸᴸ", finished_at: "2026-11-12T10:00:00Z", jobs: '[["j3",3000]]' },
        { build_number: "10", commit: "def", finished_at: "2026-11-11T10:00:00Z", jobs: '[["j4",4000]]' },
      ];
    }
    return [{ job_id: "j2" }, { job_id: "j4" }];
  });
  const builds = await clickHousePassingBuilds(false, "step-a", 14, "q1", 20);
  assert.deepEqual(builds.map((b) => b.build_number), ["12", "10"]);
  assert.deepEqual(builds[0].job_ids, ["j1", "j2"]);
  assert.deepEqual(builds[0].job_ms, [1000.5, 2000]);
  assert.equal(builds[0].finished_at.toISOString(), "2026-11-13T10:00:00.000Z");
  const select = calls[0];
  assert.equal(select.url.searchParams.get("param_branch"), "main");
  assert.equal(select.url.searchParams.get("param_stepKey"), "step-a");
  assert.equal(select.url.searchParams.get("param_queue"), "q1");
  assert.equal(select.url.searchParams.get("param_days"), "14");
  assert.match(select.sql, /LIMIT 1 BY trace_id, span_id/);
  assert.ok(!select.sql.includes("step-a"), "step key must be bound, not interpolated");
});

test("passing builds stop at the limit and read the treatment branch", async (t) => {
  const calls = fakeClickHouse(t, ({ sql }) => sql.includes("GROUP BY build_number")
    ? [
      { build_number: "2", commit: null, finished_at: "2026-11-13T10:00:00Z", jobs: '[["a",1]]' },
      { build_number: "1", commit: null, finished_at: "2026-11-12T10:00:00Z", jobs: '[["b",1]]' },
    ]
    : [{ job_id: "a" }, { job_id: "b" }]);
  const builds = await clickHousePassingBuilds(true, "s", null, null, 1, { timeoutMs: 3000 });
  assert.deepEqual(builds.map((b) => b.build_number), ["2"]);
  assert.equal(calls[0].url.searchParams.get("param_branch"), "khluu/otel");
  assert.equal(calls[0].url.searchParams.get("param_days"), null);
  assert.equal(calls[0].url.searchParams.get("max_execution_time"), "3");
});

test("timing spans convert durations to numbers and nulls to null", async (t) => {
  fakeClickHouse(t, ({ sql }) => sql.includes("LEFT JOIN")
    ? [{ job_id: "j1", duration_ms: "12.5", nodeid: "t.py::a", outcome: "passed", command_span_id: "c1", command_label: "pytest t.py" }]
    : [{ job_id: "j1", duration_ms: "100", label: "ᴺᵁᴸᴸ" }]);
  const { rows, commands } = await clickHouseTimingSpans(["j1"]);
  assert.equal(rows[0].duration_ms, 12.5);
  assert.equal(rows[0].command_label, "pytest t.py");
  assert.equal(commands[0].duration_ms, 100);
  assert.equal(commands[0].label, null);
});
