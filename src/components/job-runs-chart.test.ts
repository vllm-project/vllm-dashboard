import assert from "node:assert/strict";
import test from "node:test";
import { jobRunChartData, type JobRun } from "./job-runs-chart";

const original: JobRun = {
  job_id: "original",
  web_url: "https://buildkite.com/vllm/ci/builds/42#original",
  state: "failed",
  started_at: "2026-09-22T14:30:15Z",
  finished_at: "2026-09-22T14:32:15Z",
  duration_secs: "120",
  commit_sha: "abcdef1234567890",
  build_created_at: "2026-09-20T01:00:00Z",
  is_retry: false,
};

test("retry history classifies attempts independently of their outcome", () => {
  const runs: JobRun[] = [
    original,
    { ...original, job_id: "passed-retry", state: "passed", is_retry: true },
    { ...original, job_id: "failed-retry", state: "failed", is_retry: true },
    { ...original, job_id: "passed-original", state: "passed" },
  ];
  const data = jobRunChartData(runs, "retries");

  assert.deepEqual(data.map((point) => point.status), [-1, 1, 1, -1]);
  assert.deepEqual(data.map((point) => point.retry), [false, true, true, false]);
  assert.deepEqual(data.map((point) => point.state), ["failed", "passed", "failed", "passed"]);
});

test("retry history uses the attempt start time and preserves its Buildkite link", () => {
  const [retryPoint] = jobRunChartData([original], "retries");
  const [failurePoint] = jobRunChartData([original], "failures");
  assert.equal(retryPoint.date, new Date(original.started_at!).toLocaleString(undefined, { timeZoneName: "short" }));
  assert.equal(failurePoint.date, new Date(original.build_created_at!).toLocaleString());
  assert.notEqual(retryPoint.date, failurePoint.date);
  assert.equal(retryPoint.webUrl, original.web_url);
  assert.equal(retryPoint.commit, "abcdef1");
});

test("failure and duration histories keep their outcome classification", () => {
  const runs = [original, { ...original, state: "passed", is_retry: true }];
  for (const mode of ["failures", "duration"] as const) {
    const data = jobRunChartData(runs, mode);
    assert.deepEqual(data.map((point) => point.status), [-1, 1]);
    assert.deepEqual(data.map((point) => point.failed), [true, false]);
    assert.deepEqual(data.map((point) => point.duration), [120, 120]);
  }
});

test("retry history accepts numeric durations and missing optional build details", () => {
  const [numeric, missing] = jobRunChartData([
    { ...original, duration_secs: 90, build_created_at: undefined, commit_sha: null },
    { ...original, duration_secs: null, started_at: null, web_url: null },
  ], "retries");
  assert.equal(numeric.duration, 90);
  assert.equal(numeric.commit, "");
  assert.equal(missing.duration, 0);
  assert.equal(missing.date, "Start time unavailable");
  assert.equal(missing.webUrl, null);
});
