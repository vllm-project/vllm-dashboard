import assert from "node:assert/strict";
import test from "node:test";
import {
  toMainCiJobAlert,
  viewMainCiJobAlerts,
  type MainCiJobAlertRow,
} from "./alerts-main-ci";

function alertRow(
  overrides: Partial<MainCiJobAlertRow> = {},
): MainCiJobAlertRow {
  return {
    alert_id: 42,
    job_key: "step:gpu|name:GPU test",
    job_name: "GPU test",
    status: "open",
    opened_at: new Date("2026-08-29T08:00:00.000Z"),
    first_failure_job_id: "job-1",
    first_failure_state: "failed",
    first_failure_build_id: "build-100",
    first_failure_build_number: 100,
    first_failure_build_url: "https://buildkite.com/vllm/ci/builds/100",
    first_failure_job_url: "https://example.test/job-1",
    first_failure_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    last_failed_at: new Date("2026-08-29T09:00:00.000Z"),
    last_failure_job_id: "job-2",
    last_failure_state: "timed_out",
    last_failure_build_id: "build-101",
    last_failure_build_number: 101,
    last_failure_build_url: "https://buildkite.com/vllm/ci/builds/101",
    last_failure_job_url: "https://example.test/job-2",
    last_failure_commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    failure_count: 2,
    resolved_at: null,
    resolution_job_id: null,
    resolution_build_id: null,
    resolution_build_number: null,
    resolution_build_url: null,
    resolution_job_url: null,
    resolution_commit_sha: null,
    analysis_analyzed_failure_job_id: null,
    analysis_classification: null,
    analysis_confidence: null,
    analysis_summary: null,
    analysis_evidence_urls: null,
    analysis_recommended_action: null,
    analysis_suspected_fix_prs: null,
    analysis_model_version: null,
    analysis_analyzed_at: null,
    ...overrides,
  };
}

function analyzedRow(): Partial<MainCiJobAlertRow> {
  return {
    analysis_analyzed_failure_job_id: "job-2",
    analysis_classification: "flaky",
    analysis_confidence: "medium",
    analysis_summary: "Test passes on retry with no code change.",
    analysis_evidence_urls: ["https://buildkite.com/vllm/ci/builds/101#job-2"],
    analysis_recommended_action: "Quarantine and re-run the test.",
    analysis_suspected_fix_prs: [
      {
        url: "https://github.com/vllm-project/vllm/pull/77",
        number: 77,
        title: "Deflake GPU test",
      },
    ],
    analysis_model_version: "moonshotai/Kimi-K3",
    analysis_analyzed_at: new Date("2026-08-29T09:05:00.000Z"),
  };
}

test("row mapping exposes only the alert episode and exact Buildkite evidence", () => {
  const alert = toMainCiJobAlert(alertRow());

  assert.equal(alert.alertId, "42");
  assert.equal(alert.status, "open");
  assert.equal(alert.failureCount, 2);
  assert.equal(alert.firstFailure.buildNumber, 100);
  assert.equal(alert.lastFailure.buildNumber, 101);
  assert.equal(alert.resolution, null);
  assert.equal(alert.analysis, null);
});

test("analysis columns map to a nested object with a computed stale flag", () => {
  const alert = toMainCiJobAlert(alertRow(analyzedRow()));

  assert.equal(alert.analysis?.classification, "flaky");
  assert.equal(alert.analysis?.confidence, "medium");
  assert.equal(alert.analysis?.summary, "Test passes on retry with no code change.");
  assert.deepEqual(alert.analysis?.evidenceUrls, [
    "https://buildkite.com/vllm/ci/builds/101#job-2",
  ]);
  assert.deepEqual(alert.analysis?.suspectedFixPrs, [
    {
      url: "https://github.com/vllm-project/vllm/pull/77",
      number: 77,
      title: "Deflake GPU test",
    },
  ]);
  assert.equal(alert.analysis?.modelVersion, "moonshotai/Kimi-K3");
  assert.equal(alert.analysis?.analyzedAt, "2026-08-29T09:05:00.000Z");
  // The analyzed job is the latest failure: not stale.
  assert.equal(alert.analysis?.stale, false);
});

test("an analysis of an older failure is marked stale", () => {
  const alert = toMainCiJobAlert(
    alertRow({
      ...analyzedRow(),
      analysis_analyzed_failure_job_id: "job-1",
    }),
  );

  assert.equal(alert.analysis?.stale, true);
});

test("a positive pass is represented as the resolution", () => {
  const resolvedAt = new Date("2026-08-29T09:30:00.000Z");
  const alert = toMainCiJobAlert(
    alertRow({
      status: "resolved",
      resolved_at: resolvedAt,
      resolution_job_id: "job-3",
      resolution_build_id: "build-102",
      resolution_build_number: 102,
      resolution_build_url: "https://buildkite.com/vllm/ci/builds/102",
      resolution_job_url: "https://example.test/job-3",
      resolution_commit_sha: "cccccccccccccccccccccccccccccccccccccccc",
    }),
  );

  assert.equal(alert.resolvedAt, resolvedAt.toISOString());
  assert.deepEqual(alert.resolution, {
    buildkiteJobId: "job-3",
    state: "passed",
    finishedAt: resolvedAt.toISOString(),
    buildkiteBuildId: "build-102",
    buildNumber: 102,
    buildUrl: "https://buildkite.com/vllm/ci/builds/102",
    jobUrl: "https://example.test/job-3",
    commitSha: "cccccccccccccccccccccccccccccccccccccccc",
  });
});

test("open alerts survive the time filter and sort ahead of resolved history", () => {
  const oldOpen = toMainCiJobAlert(
    alertRow({
      alert_id: 1,
      last_failed_at: new Date("2026-08-01T00:00:00.000Z"),
    }),
  );
  const recentResolved = toMainCiJobAlert(
    alertRow({
      alert_id: 2,
      status: "resolved",
      resolved_at: new Date("2026-08-29T09:30:00.000Z"),
      resolution_job_id: "job-3",
      resolution_build_id: "build-102",
      resolution_build_number: 102,
      resolution_build_url: "https://buildkite.com/vllm/ci/builds/102",
      resolution_job_url: "https://example.test/job-3",
      resolution_commit_sha: "cccccccccccccccccccccccccccccccccccccccc",
    }),
  );
  const staleResolved = {
    ...recentResolved,
    alertId: "3",
    resolvedAt: "2026-08-01T00:00:00.000Z",
  };

  assert.deepEqual(
    viewMainCiJobAlerts(
      [recentResolved, staleResolved, oldOpen],
      new Date("2026-08-28T00:00:00.000Z"),
    ).map((alert) => alert.alertId),
    ["1", "2"],
  );
});

