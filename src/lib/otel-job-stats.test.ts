import assert from "node:assert/strict";
import test from "node:test";
import { queryBuildJobsFromOtel, queryBuildsFromOtel, queryJobStatsFromOtel, splitOtelJobStats } from "./otel-ci";

test("combined statistics retain distinct failure and passed-duration populations", () => {
  const result = splitOtelJobStats([
    { name: "mixed", total_runs: 12, failures: 4, passes: 7, failure_rate: "33.3", has_soft_fail: 1,
      avg_duration: 90, p50_duration: 80, p90_duration: 120, max_duration: 150 },
    { name: "passed only", total_runs: 3, failures: 0, passes: 3, failure_rate: "0.0", has_soft_fail: 0,
      avg_duration: 200, p50_duration: 200, p90_duration: 250, max_duration: 300 },
    { name: "failed only", total_runs: 2, failures: 2, passes: 0, failure_rate: "100.0", has_soft_fail: 0,
      avg_duration: null, p50_duration: null, p90_duration: null, max_duration: null },
    { name: "unknown outcome", total_runs: 1, failures: 0, passes: 0, failure_rate: "0.0", has_soft_fail: 0,
      avg_duration: null, p50_duration: null, p90_duration: null, max_duration: null },
  ]);
  assert.deepEqual(result, {
    failureRanking: [
      { name: "failed only", total_runs: 2, failures: 2, passes: 0, failure_rate: "100.0", has_soft_fail: 0 },
      { name: "mixed", total_runs: 12, failures: 4, passes: 7, failure_rate: "33.3", has_soft_fail: 1 },
    ],
    durationStats: [
      { name: "passed only", total_runs: 3, avg_duration: 200, p50_duration: 200, p90_duration: 250, max_duration: 300 },
      { name: "mixed", total_runs: 7, avg_duration: 90, p50_duration: 80, p90_duration: 120, max_duration: 150 },
    ],
  });
});

test("duration ranks only runs of a sharded step whose shards all ran", () => {
  const result = splitOtelJobStats([
    { name: "sharded", total_runs: 5, failures: 1, passes: 4, timed_passes: 3, failure_rate: "20.0",
      has_soft_fail: 0, avg_duration: 600, p50_duration: 600, p90_duration: 700, max_duration: 720 },
    { name: "partial only", total_runs: 1, failures: 0, passes: 1, timed_passes: 0, failure_rate: "0.0",
      has_soft_fail: 0, avg_duration: null, p50_duration: null, p90_duration: null, max_duration: null },
  ]);
  assert.deepEqual(result.durationStats, [
    { name: "sharded", total_runs: 3, avg_duration: 600, p50_duration: 600, p90_duration: 700, max_duration: 720 },
  ]);
});

test("failure rates sort numerically and ties use failure counts", () => {
  const rows = [
    { name: "lower rate", total_runs: 100, failures: 9, passes: 91, failure_rate: "9.0" },
    { name: "fewer failures", total_runs: 10, failures: 5, passes: 5, failure_rate: "50.0" },
    { name: "more failures", total_runs: 20, failures: 10, passes: 10, failure_rate: "50.0" },
  ].map((row) => ({ ...row, has_soft_fail: 0, avg_duration: 0, p50_duration: 0, p90_duration: 0, max_duration: 0 }));
  assert.deepEqual(splitOtelJobStats(rows).failureRanking.map((row) => row.name), [
    "more failures", "fewer failures", "lower rate",
  ]);
  assert.deepEqual(splitOtelJobStats([]), { failureRanking: [], durationStats: [] });
});

type Call = { sql: string; url: URL };

function fakeClickHouse(t: test.TestContext, respond: (call: Call) => object[]): Call[] {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  process.env.CLICKHOUSE_URL = "https://ch.example";
  process.env.CLICKHOUSE_READ_USER = "reader";
  process.env.CLICKHOUSE_READ_PASSWORD = "secret";
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const call = { sql: String(init?.body), url: new URL(String(input)) };
    // Other fetches (the test-area mapping from GitHub) are not ClickHouse.
    if (call.url.host !== "ch.example") return new Response("{}", { status: 404 });
    calls.push(call);
    return new Response(respond(call).map((row) => JSON.stringify(row)).join("\n"), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test("job statistics parse ClickHouse strings and dedupe spans before joining builds", async (t) => {
  const calls = fakeClickHouse(t, () => [
    { name: "Job", total_runs: "4", failures: "1", passes: "3", failure_rate: "25.0", has_soft_fail: "0",
      timed_passes: "3", avg_duration: "90", p50_duration: "80", p90_duration: "120", max_duration: "150" },
    { name: "Failing", total_runs: "1", failures: "1", passes: "0", failure_rate: "100.0", has_soft_fail: "1",
      timed_passes: "0", avg_duration: "ᴺᵁᴸᴸ", p50_duration: "ᴺᵁᴸᴸ", p90_duration: "ᴺᵁᴸᴸ", max_duration: "ᴺᵁᴸᴸ" },
  ]);
  const result = await queryJobStatsFromOtel({ pipeline: "AMD CI", branch: "main' --", startDate: "2026-11-06", endDate: "2026-11-12", hasDateRange: true });
  assert.deepEqual(result.failureRanking.map((row) => [row.name, row.failures, row.has_soft_fail]), [["Failing", 1, 1], ["Job", 1, 0]]);
  assert.deepEqual(result.durationStats, [
    { name: "Job", total_runs: 3, avg_duration: 90, p50_duration: 80, p90_duration: 120, max_duration: 150 },
  ]);
  const [{ sql, url }] = calls;
  assert.match(sql, /FROM ci\.otel_spans/);
  assert.match(sql, /LIMIT 1 BY trace_id, span_id/);
  assert.ok(!sql.includes("main' --"), "branch must be bound, not interpolated");
  const params = [...url.searchParams].filter(([key]) => key.startsWith("param_")).map(([, value]) => value);
  assert.ok(params.includes("amd-ci"));
  assert.ok(params.includes("main' --"));
  assert.ok(params.includes("2026-11-13T00:00:00.000Z"), "end date is inclusive");
});

test("build jobs match exact build keys and build filters rewrite regex lookaheads", async (t) => {
  const calls = fakeClickHouse(t, () => []);
  assert.deepEqual(await queryBuildJobsFromOtel(["bad", "ci:x"]), []);
  assert.equal(calls.length, 0);
  await queryBuildJobsFromOtel(["ci:12", "amd-ci:7"]);
  const params = Object.fromEntries([...calls[0].url.searchParams].filter(([key]) => key.startsWith("param_")));
  assert.deepEqual(Object.values(params), ["['ci','amd-ci']", "[12,7]", "['ci:12','amd-ci:7']"]);

  await queryBuildsFromOtel({ pipeline: "CI", page: 1, pageSize: 50, jobGroups: ["Hardware-AMD Tests"], jobNames: [], state: "failed" });
  const builds = calls.slice(1);
  assert.equal(builds.length, 3);
  for (const { sql } of builds) {
    assert.doesNotMatch(sql, /\(\?!/);
    assert.match(sql, /AND NOT match\(/);
    assert.match(sql, /WHERE build_state = \{p\d+:String\}/);
  }
  const values = [...builds[0].url.searchParams.values()];
  assert.ok(values.includes("^AMD: .*$"));
  assert.ok(values.includes("^AMD: :docker: "));
  assert.ok(values.includes("50"), "page offset");
});
