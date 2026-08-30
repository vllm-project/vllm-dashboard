import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUrlForNumber,
  filterFullCiComparisonViews,
  toFullCiComparisons,
  viewFullCiComparisons,
  type FullCiComparisonRow,
  type FullCiComparisonView,
  type FullCiConditionRow,
} from "./alerts-full-ci";

function comparisonRow(
  overrides: Partial<FullCiComparisonRow> = {},
): FullCiComparisonRow {
  return {
    current_build_id: "build-2",
    current_build_number: 9002,
    current_scheduled_at: new Date("2026-08-27T21:00:00.000Z"),
    current_commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    current_message: "Second run",
    current_state: "failed",
    previous_build_id: "build-1",
    previous_build_number: 9001,
    previous_scheduled_at: new Date("2026-08-27T06:00:00.000Z"),
    previous_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    previous_message: "First run",
    previous_state: "failed",
    analyzed_at: new Date("2026-08-27T22:00:00.000Z"),
    notification_status: "delivered",
    ...overrides,
  };
}

function conditionRow(
  overrides: Partial<FullCiConditionRow> = {},
): FullCiConditionRow {
  return {
    current_build_id: "build-2",
    job_name: "Async engine test",
    lifecycle: "new",
    cause: "code",
    summary: "assertion failure in the async output processor",
    culprit_pr_number: 1234,
    culprit_pr_url: "https://github.com/vllm-project/vllm/pull/1234",
    culprit_pr_title: "Rework async output processing",
    fixing_pr_number: null,
    fixing_pr_url: null,
    fixing_pr_title: null,
    current_state: "failed",
    current_soft_failed: false,
    previous_state: "passed",
    previous_soft_failed: false,
    ...overrides,
  };
}

test("a comparison exposes both of its runs so the baseline is auditable", () => {
  const [comparison] = toFullCiComparisons([comparisonRow()], [conditionRow()]);

  assert.deepEqual(comparison.currentRun, {
    buildkiteBuildId: "build-2",
    buildNumber: 9002,
    scheduledAt: "2026-08-27T21:00:00.000Z",
    commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "Second run",
    state: "failed",
    buildUrl: "https://buildkite.com/vllm/ci/builds/9002",
  });
  assert.deepEqual(comparison.previousRun, {
    buildkiteBuildId: "build-1",
    buildNumber: 9001,
    scheduledAt: "2026-08-27T06:00:00.000Z",
    commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    message: "First run",
    state: "failed",
    buildUrl: "https://buildkite.com/vllm/ci/builds/9001",
  });
});

test("conditions attach to the comparison they were classified in", () => {
  const comparisons = toFullCiComparisons(
    [comparisonRow(), comparisonRow({ current_build_id: "build-3" })],
    [conditionRow(), conditionRow({ current_build_id: "build-3" })],
  );

  assert.equal(comparisons.length, 2);
  assert.equal(comparisons[0].conditions.length, 1);
  assert.equal(comparisons[1].conditions.length, 1);
});

test("a condition carries its classification, attribution, and both outcomes", () => {
  const [comparison] = toFullCiComparisons(
    [comparisonRow()],
    [
      conditionRow({
        lifecycle: "fixed",
        summary: "reverted by the author",
        fixing_pr_number: 5678,
        fixing_pr_url: "https://github.com/vllm-project/vllm/pull/5678",
        fixing_pr_title: "Revert async output processing",
        current_state: "passed",
        previous_state: "failed",
      }),
    ],
  );

  assert.deepEqual(comparison.conditions[0], {
    jobName: "Async engine test",
    lifecycle: "fixed",
    cause: "code",
    summary: "reverted by the author",
    culpritPr: {
      number: 1234,
      url: "https://github.com/vllm-project/vllm/pull/1234",
      title: "Rework async output processing",
    },
    fixingPr: {
      number: 5678,
      url: "https://github.com/vllm-project/vllm/pull/5678",
      title: "Revert async output processing",
    },
    previousOutcome: { state: "failed", softFailed: false },
    currentOutcome: { state: "passed", softFailed: false },
  });
});

test("an unattributed condition reports no pull request rather than an invented one", () => {
  const [comparison] = toFullCiComparisons(
    [comparisonRow()],
    [
      conditionRow({
        cause: "infrastructure",
        culprit_pr_number: null,
        culprit_pr_url: null,
        culprit_pr_title: null,
      }),
    ],
  );

  assert.equal(comparison.conditions[0].culpritPr, null);
  assert.equal(comparison.conditions[0].fixingPr, null);
});

test("a job absent from a run reports no outcome rather than a passing one", () => {
  const [comparison] = toFullCiComparisons(
    [comparisonRow()],
    [conditionRow({ previous_state: null, previous_soft_failed: null })],
  );

  assert.equal(comparison.conditions[0].previousOutcome, null);
});

test("raw analyzer evidence never reaches the response", () => {
  const row = {
    ...comparisonRow(),
    report_text: "the full rendered analyzer report",
    failure_cache: { failed_tests: ["secret_test"] },
    suspicious_prs: [{ pr_number: 1 }],
    s3_uri: "s3://analyzer-memory/checkpoint-42.json",
  } as FullCiComparisonRow;

  const [comparison] = toFullCiComparisons([row], [conditionRow()]);

  const serialized = JSON.stringify(comparison);
  for (const leak of [
    "report_text",
    "reportText",
    "failure_cache",
    "failureCache",
    "suspicious_prs",
    "suspiciousPrs",
    "s3_uri",
    "s3Uri",
    "secret_test",
    "analyzer report",
  ]) {
    assert.equal(serialized.includes(leak), false, `leaked ${leak}`);
  }
});

test("the default view separates ongoing conditions from fixed conditions", () => {
  const [view] = viewFullCiComparisons(
    toFullCiComparisons(
      [comparisonRow()],
      [
        conditionRow({ job_name: "Recurring job", lifecycle: "recurring" }),
        conditionRow({ job_name: "Fixed job", lifecycle: "fixed" }),
        conditionRow({ job_name: "New job", lifecycle: "new" }),
      ],
    ),
  );

  assert.deepEqual(
    view.ongoing.map((condition) => condition.jobName),
    ["New job", "Recurring job"],
  );
  assert.deepEqual(
    view.fixed.map((condition) => condition.jobName),
    ["Fixed job"],
  );
});

test("a comparison reports how far its Slack notification got", () => {
  const [retrying] = viewFullCiComparisons(
    toFullCiComparisons(
      [comparisonRow({ notification_status: "retrying" })],
      [],
    ),
  );
  assert.equal(retrying.notificationState, "retrying");

  const [unnotified] = viewFullCiComparisons(
    toFullCiComparisons([comparisonRow({ notification_status: null })], []),
  );
  assert.equal(unnotified.notificationState, "unnotified");
});

test("comparisons read newest first, and only the newest is the current one", () => {
  const views = viewFullCiComparisons(
    toFullCiComparisons(
      [
        comparisonRow({
          current_build_id: "old",
          current_scheduled_at: new Date("2026-08-26T21:00:00.000Z"),
        }),
        comparisonRow({ current_build_id: "new" }),
      ],
      [],
    ),
  );

  assert.deepEqual(
    views.map((view) => view.currentRun.buildkiteBuildId),
    ["new", "old"],
  );
  assert.deepEqual(
    views.map((view) => view.isLatest),
    [true, false],
  );
});

test("build numbers resolve to Buildkite builds", () => {
  assert.equal(
    buildUrlForNumber(9001),
    "https://buildkite.com/vllm/ci/builds/9001",
  );
});

function view(): FullCiComparisonView {
  const [comparison] = viewFullCiComparisons(
    toFullCiComparisons(
      [comparisonRow()],
      [
        conditionRow({ job_name: "GPU memory profiling test" }),
        conditionRow({
          job_name: "Async engine test",
          lifecycle: "fixed",
          summary: "passes again after the revert",
        }),
      ],
    ),
  );
  return comparison;
}

test("an empty query leaves every comparison untouched", () => {
  assert.deepEqual(filterFullCiComparisonViews([view()], "   "), [view()]);
});

test("a query keeps only the conditions whose job name matches", () => {
  const [filtered] = filterFullCiComparisonViews([view()], "gpu");

  assert.deepEqual(
    filtered.ongoing.map((condition) => condition.jobName),
    ["GPU memory profiling test"],
  );
  assert.deepEqual(filtered.fixed, []);
});

test("a query matching nothing in a comparison drops the comparison", () => {
  assert.deepEqual(filterFullCiComparisonViews([view()], "rocm"), []);
});

test("a query naming the comparison itself keeps all of its conditions", () => {
  const [filtered] = filterFullCiComparisonViews([view()], "9002");

  assert.equal(filtered.ongoing.length, 1);
  assert.equal(filtered.fixed.length, 1);
});

test("a query matches a condition summary and its culprit pull request", () => {
  assert.equal(
    filterFullCiComparisonViews([view()], "async output processor").length,
    1,
  );
  assert.equal(
    filterFullCiComparisonViews([view()], "Rework async output").length,
    1,
  );
});
