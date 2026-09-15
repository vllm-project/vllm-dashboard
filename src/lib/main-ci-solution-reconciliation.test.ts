import assert from "node:assert/strict";
import test from "node:test";
import type {
  MainCiAlertUpdate,
  MainCiJobAlert,
} from "./alerts-main-ci";
import {
  reconcileMainCiSolution,
  reconcileMainCiSolutions,
  summarizeMainCiSolutionReconciliation,
} from "./main-ci-solution-reconciliation";

const FIX = {
  number: 70001,
  url: "https://github.com/vllm-project/vllm/pull/70001",
  title: "Fix the failure",
};

function update(
  overrides: Partial<MainCiAlertUpdate> = {},
): MainCiAlertUpdate {
  return {
    updateId: "1",
    failureJobId: "job-2",
    failureSignature: "gpu test | runtimeerror | stable marker",
    kind: "diagnosis",
    message: "Investigating the failure.",
    fixPrs: [],
    solution: null,
    author: "Sherlock",
    createdAt: "2026-09-15T17:00:00.000Z",
    stale: false,
    carriedFixPrs: [],
    fixOwnershipStatus: "current",
    ...overrides,
  };
}

function alert(overrides: Partial<MainCiJobAlert> = {}): MainCiJobAlert {
  return {
    alertId: "42",
    jobKey: "step:gpu|name:GPU test",
    jobName: "GPU test",
    status: "open",
    openedAt: "2026-09-15T16:00:00.000Z",
    firstFailure: {
      buildkiteJobId: "job-1",
      state: "failed",
      finishedAt: "2026-09-15T16:00:00.000Z",
      buildkiteBuildId: "build-100",
      buildNumber: 100,
      buildUrl: "https://buildkite.com/vllm/ci/builds/100",
      jobUrl: "https://example.test/job-1",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    lastFailure: {
      buildkiteJobId: "job-2",
      state: "failed",
      finishedAt: "2026-09-15T17:00:00.000Z",
      buildkiteBuildId: "build-101",
      buildNumber: 101,
      buildUrl: "https://buildkite.com/vllm/ci/builds/101",
      jobUrl: "https://example.test/job-2",
      commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    failureCount: 2,
    resolvedAt: null,
    resolution: null,
    resolutionKind: null,
    analysis: null,
    updates: [],
    solutionCoverage: {
      kind: "untriaged",
      owner: null,
      action: null,
      sourceUpdateId: null,
      updatedAt: null,
      issues: ["missing_current_solution"],
    },
    ...overrides,
  };
}

test("a verified current or carried PR is the accountable code-fix path", () => {
  const coverage = reconcileMainCiSolution(
    alert({
      updates: [
        update({
          kind: "fix_opened",
          message: "Land the narrow fix after the exact lane passes.",
          fixPrs: [FIX],
          carriedFixPrs: [FIX],
          solution: {
            kind: "code_fix",
            owner: "CI on-call",
            action: "Land PR #70001 after the exact lane passes.",
          },
        }),
      ],
    }),
  );

  assert.deepEqual(coverage, {
    kind: "code_fix",
    owner: "CI on-call",
    action: "Land PR #70001 after the exact lane passes.",
    sourceUpdateId: "1",
    updatedAt: "2026-09-15T17:00:00.000Z",
    issues: [],
  });
});

test("an exact non-code solution covers an alert without inventing a PR", () => {
  const coverage = reconcileMainCiSolution(
    alert({
      updates: [
        update({
          solution: {
            kind: "infra_action",
            owner: "H200 fleet",
            action: "Repair the git mirror lock, then rerun this lane once.",
          },
        }),
      ],
    }),
  );

  assert.equal(coverage.kind, "infra_action");
  assert.equal(coverage.owner, "H200 fleet");
  assert.deepEqual(coverage.issues, []);
});

test("a merged fix remains coverage but is flagged until main contains it", () => {
  const coverage = reconcileMainCiSolution(
    alert({
      updates: [
        update({
          kind: "fix_opened",
          message: "The fix merged; wait for a containing main run.",
          fixPrs: [FIX],
          carriedFixPrs: [FIX],
          fixOwnershipStatus: "merged_pending",
        }),
      ],
    }),
  );

  assert.equal(coverage.kind, "code_fix");
  assert.deepEqual(coverage.issues, ["fix_merged_pending"]);
});

test("analysis suggestions alone remain explicitly untriaged", () => {
  const coverage = reconcileMainCiSolution(
    alert({
      analysis: {
        analyzedFailureJobId: "job-2",
        failureSignature: "gpu test | runtimeerror | stable marker",
        classification: "code",
        confidence: "medium",
        summary: "A possible source regression.",
        evidenceUrls: [],
        recommendedAction: "Inspect the suspect change.",
        suspectedFixPrs: [FIX],
        modelVersion: "analyzer",
        analyzedAt: "2026-09-15T17:01:00.000Z",
        stale: false,
      },
    }),
  );

  assert.equal(coverage.kind, "untriaged");
  assert.deepEqual(coverage.issues, ["missing_current_solution"]);
});

test("reconciliation explains stale actions and invalid fix ownership", () => {
  const coverage = reconcileMainCiSolution(
    alert({
      updates: [
        update({
          failureJobId: "job-1",
          stale: true,
          fixPrs: [FIX],
          fixOwnershipStatus: "signature_changed",
          solution: {
            kind: "code_fix",
            owner: "Sherlock",
            action: "Land the old repair.",
          },
        }),
      ],
    }),
  );

  assert.equal(coverage.kind, "untriaged");
  assert.deepEqual(new Set(coverage.issues), new Set([
    "missing_current_solution",
    "signature_changed",
    "stale_action",
  ]));
});

test("the hourly summary counts only open alerts", () => {
  const covered = reconcileMainCiSolutions([
    alert({
      updates: [
        update({
          solution: {
            kind: "monitoring",
            owner: "CI on-call",
            action: "Watch the next ordinary main run.",
          },
        }),
      ],
    }),
    alert({ alertId: "43" }),
    alert({ alertId: "44", status: "resolved" }),
  ]);
  const summary = summarizeMainCiSolutionReconciliation(
    covered,
    new Date("2026-09-15T18:00:00.000Z"),
  );

  assert.deepEqual(summary, {
    checkedAt: "2026-09-15T18:00:00.000Z",
    openAlerts: 2,
    coveredAlerts: 1,
    untriagedAlerts: 1,
    issueCounts: { missing_current_solution: 1 },
  });
});
