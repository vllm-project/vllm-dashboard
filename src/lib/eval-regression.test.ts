import assert from "node:assert/strict";
import test from "node:test";
import { classifyDeltas } from "./eval-regression";
import type { DeltaItem } from "./compare";

function makeDelta(overrides: Partial<DeltaItem>): DeltaItem {
  return {
    area: "eval",
    key: "test|gsm8k|0|exact_match|flexible-extract",
    model: "Qwen/Qwen3-5-32B",
    dimension: "gsm8k - 0-shot - flexible-extract",
    metric: "exact_match",
    metricLabel: "exact_match (flexible-extract)",
    unit: "score",
    higherIsBetter: true,
    baselineValue: 0.87,
    candidateValue: 0.85,
    delta: -0.02,
    deltaPct: -0.023,
    status: "unchanged",
    severity: 0.02,
    significance: 1.5,
    baselineRun: "2026-09-10T00:00:00Z",
    candidateRun: "2026-10-01T00:00:00Z",
    baselineDetail: "n=1319 - abc1234",
    candidateDetail: "n=1319 - def5678",
    ...overrides,
  };
}

test("classifies as pass when no regressions", () => {
  const { status, summary } = classifyDeltas(
    [
      makeDelta({ status: "unchanged", key: "k1" }),
      makeDelta({ status: "improvement", key: "k2" }),
    ],
    0,
  );
  assert.equal(status, "pass");
  assert.equal(summary.regressed, 0);
  assert.equal(summary.passed, 2);
});

test("classifies as regression when any delta is a regression", () => {
  const { status, summary } = classifyDeltas(
    [
      makeDelta({ status: "regression", key: "k1" }),
      makeDelta({ status: "unchanged", key: "k2" }),
    ],
    0,
  );
  assert.equal(status, "regression");
  assert.equal(summary.regressed, 1);
  assert.equal(summary.passed, 1);
});

test("counts noisy as passed, not regressed", () => {
  const { status, summary } = classifyDeltas(
    [makeDelta({ status: "noisy", key: "k1" })],
    0,
  );
  assert.equal(status, "pass");
  assert.equal(summary.noisy, 1);
  assert.equal(summary.passed, 1);
  assert.equal(summary.regressed, 0);
});

test("multiple regressions are all counted", () => {
  const { status, summary } = classifyDeltas(
    [
      makeDelta({ status: "regression", severity: 0.02, key: "k1" }),
      makeDelta({ status: "regression", severity: 0.05, key: "k2" }),
      makeDelta({ status: "unchanged", severity: 0, key: "k3" }),
    ],
    0,
  );
  assert.equal(status, "regression");
  assert.equal(summary.regressed, 2);
  assert.equal(summary.total, 3);
});

test("empty deltas classify as skipped", () => {
  const { status, summary } = classifyDeltas([], 0);
  assert.equal(status, "skipped");
  assert.equal(summary.total, 0);
  assert.equal(summary.regressed, 0);
});

test("missing candidate data does not suppress evidence (coverage gaps are normal)", () => {
  const { status, summary } = classifyDeltas(
    [makeDelta({ status: "unchanged", key: "k1" })],
    3,
  );
  assert.equal(status, "pass");
  assert.equal(summary.missingCandidate, 3);
  assert.equal(summary.total, 1);
});

test("regressions surface even with missing candidate (per-key evidence)", () => {
  const { status, summary } = classifyDeltas(
    [makeDelta({ status: "regression", key: "k1" })],
    2,
  );
  assert.equal(status, "regression");
  assert.equal(summary.regressed, 1);
  assert.equal(summary.missingCandidate, 2);
});
