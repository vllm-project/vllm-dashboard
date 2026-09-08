import assert from "node:assert/strict";
import test from "node:test";
import { splitOtelJobStats } from "./otel-ci";

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
