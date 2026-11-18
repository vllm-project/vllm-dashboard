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
    return [{ job_id: "j2", orphans: "0" }, { job_id: "j4", orphans: "0" }];
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
    : [{ job_id: "a", orphans: "0" }, { job_id: "b", orphans: "0" }]);
  const builds = await clickHousePassingBuilds(true, "s", null, null, 1, { timeoutMs: 3000 });
  assert.deepEqual(builds.map((b) => b.build_number), ["2"]);
  assert.equal(calls[0].url.searchParams.get("param_branch"), "khluu/otel");
  assert.equal(calls[0].url.searchParams.get("param_days"), null);
  assert.equal(calls[0].url.searchParams.get("max_execution_time"), "3");
});

test("passing builds skip a build whose test spans lost their command span", async (t) => {
  // Build 13's job "b" uploaded its tests but not the command span they point
  // to (the job-end upload ran out of time), even if another of its commands
  // landed. Its tests can't be timed, so 13 must not take one of the newest-N
  // slots; 12 is used instead.
  fakeClickHouse(t, ({ sql }) => sql.includes("GROUP BY build_number")
    ? [
      { build_number: "13", commit: null, finished_at: "2026-11-14T10:00:00Z", jobs: '[["a",1],["b",1]]' },
      { build_number: "12", commit: null, finished_at: "2026-11-13T10:00:00Z", jobs: '[["c",1]]' },
    ]
    : [{ job_id: "a", orphans: "0" }, { job_id: "b", orphans: "1" }, { job_id: "c", orphans: "0" }]);
  const builds = await clickHousePassingBuilds(false, "s", 14, null, 1);
  assert.deepEqual(builds.map((b) => b.build_number), ["12"]);
});

test("passing builds below a build number bind it as a filter", async (t) => {
  const calls = fakeClickHouse(t, () => []);
  assert.deepEqual(await clickHousePassingBuilds(false, "s", null, null, 20, {}, 97156), []);
  assert.equal(calls[0].url.searchParams.get("param_before"), "97156");
  assert.match(calls[0].sql, /build_number < \{before:Int64\}/);
  assert.equal(calls[0].url.searchParams.get("param_days"), null);
  const unbounded = fakeClickHouse(t, () => []);
  await clickHousePassingBuilds(false, "s", 14, null, 20);
  assert.equal(unbounded[0].url.searchParams.get("param_before"), null);
  assert.ok(!unbounded[0].sql.includes("{before:"));
});

// 51 passing builds, newest first: "b1" (job "j1") ... "b51" (job "j51").
function manyBuilds(t: test.TestContext, orphansOf: (job: string) => string): Call[] {
  return fakeClickHouse(t, ({ sql, url }) => {
    if (sql.includes("GROUP BY build_number")) {
      return Array.from({ length: 51 }, (_, i) => ({
        build_number: `b${i + 1}`, commit: null, finished_at: "2026-11-13T10:00:00Z", jobs: `[["j${i + 1}",1]]`,
      }));
    }
    const jobs = (url.searchParams.get("param_jobIds") ?? "[]").slice(1, -1).split(",").filter(Boolean);
    return jobs.map((quoted) => quoted.slice(1, -1)).map((job) => ({ job_id: job, orphans: orphansOf(job) }));
  });
}

function jobChecks(calls: Call[]): string[][] {
  return calls.filter((call) => call.sql.includes("AS orphans")).map((call) =>
    (call.url.searchParams.get("param_jobIds") ?? "[]").slice(1, -1).split(",").filter(Boolean));
}

test("the build check counts tests whose parent is not a labelled command span", async (t) => {
  // A surviving command of the same job must not vouch for tests whose own
  // parent command was lost: the check joins each test's parent span.
  const calls = fakeClickHouse(t, ({ sql }) => sql.includes("GROUP BY build_number")
    ? [{ build_number: "1", commit: null, finished_at: "2026-11-13T10:00:00Z", jobs: '[["a",1]]' }]
    : [{ job_id: "a", orphans: "0" }]);
  await clickHousePassingBuilds(false, "s", 14, null, 1);
  const check = calls.find((call) => call.sql.includes("AS orphans"))!.sql;
  assert.match(check, /c\.span_id = t\.parent_span_id/);
  assert.match(check, /c\.trace_id = t\.trace_id/);
  assert.match(check, /ci\.command\.label'\) != ''/);
  assert.match(check, /countIf\(c\.span_id IS NULL\)/);
  assert.match(check, /join_use_nulls = 1/);
});

test("passing builds check jobs a page of 50 builds at a time", async (t) => {
  // Every job of the first page lost its command span, so the check moves on
  // to the second page, which holds only the 51st build.
  const calls = manyBuilds(t, (job) => (job === "j51" ? "0" : "1"));
  const builds = await clickHousePassingBuilds(false, "s", 14, null, 1);
  assert.deepEqual(builds.map((b) => b.build_number), ["b51"]);
  assert.deepEqual(jobChecks(calls).map((jobs) => jobs.length), [50, 1]);
  assert.deepEqual(jobChecks(calls)[1], ["'j51'"]);
});

test("passing builds stop checking once they have enough builds", async (t) => {
  const calls = manyBuilds(t, () => "0");
  const builds = await clickHousePassingBuilds(false, "s", 14, null, 2);
  assert.deepEqual(builds.map((b) => b.build_number), ["b1", "b2"]);
  assert.equal(jobChecks(calls).length, 1);
});

test("passing builds make no empty check after the last page", async (t) => {
  const calls = fakeClickHouse(t, ({ sql }) => sql.includes("GROUP BY build_number")
    ? Array.from({ length: 50 }, (_, i) => ({
      build_number: `b${i + 1}`, commit: null, finished_at: "2026-11-13T10:00:00Z", jobs: `[["j${i + 1}",1]]`,
    }))
    : []);
  assert.deepEqual(await clickHousePassingBuilds(false, "s", 14, null, 1), []);
  assert.equal(jobChecks(calls).length, 1);
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
