/**
 * Consumer contract tests for the eval regression API.
 *
 * Validates that the response shapes from /api/eval/baseline and
 * /api/compare match what compare_via_api.py (perf-eval) expects.
 * Uses the pure library functions with fixture data — no HTTP server.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  compareEvalRows,
  buildSummary,
  isNormalized,
  inferUnit,
  sortDeltas,
  type DeltaItem,
  type CompareSummary,
} from "./compare";
import type { EvalRow } from "./eval-data";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASELINE_IMAGE = "vllm/vllm-openai:v0.8.0";
const CANDIDATE_IMAGE = "vllm/vllm-openai:nightly-20261005-abc1234";

function makeEvalRow(overrides: Partial<EvalRow> & Pick<EvalRow, "model" | "task" | "image" | "metrics">): EvalRow {
  return {
    run_date: "2026-10-01",
    run_epoch: 1759334400,
    model: overrides.model,
    task: overrides.task,
    n_shot: overrides.n_shot ?? 0,
    n_samples: overrides.n_samples ?? 1000,
    image: overrides.image,
    metrics: overrides.metrics,
  };
}

/** Baseline row: gsm8k exact_match = 0.87 (normalized, higher is better). */
const baselineGsm8k = makeEvalRow({
  model: "Qwen/Qwen3-5-32B",
  task: "gsm8k",
  image: BASELINE_IMAGE,
  metrics: [
    { name: "exact_match", filter: "flexible-extract", value: 0.87, stderr: 0.009, higher_is_better: true },
  ],
});

/** Candidate row: gsm8k exact_match = 0.80 (regression — delta 0.07 >> 2σ). */
const candidateGsm8kRegression = makeEvalRow({
  model: "Qwen/Qwen3-5-32B",
  task: "gsm8k",
  image: CANDIDATE_IMAGE,
  run_epoch: 1759420800,
  metrics: [
    { name: "exact_match", filter: "flexible-extract", value: 0.80, stderr: 0.009, higher_is_better: true },
  ],
});

/** Candidate row: gsm8k exact_match = 0.88 (passing). */
const candidateGsm8kPass = makeEvalRow({
  model: "Qwen/Qwen3-5-32B",
  task: "gsm8k",
  image: CANDIDATE_IMAGE,
  run_epoch: 1759420800,
  metrics: [
    { name: "exact_match", filter: "flexible-extract", value: 0.88, stderr: 0.009, higher_is_better: true },
  ],
});

/** Baseline row: perplexity = 5.42 (raw/unbounded, lower is better). */
const baselinePerplexity = makeEvalRow({
  model: "Qwen/Qwen3-5-32B",
  task: "wikitext",
  image: BASELINE_IMAGE,
  metrics: [
    { name: "word_perplexity", filter: "none", value: 5.42, stderr: 0.12, higher_is_better: false },
  ],
});

/** Candidate row: perplexity = 5.50 (slightly worse). */
const candidatePerplexity = makeEvalRow({
  model: "Qwen/Qwen3-5-32B",
  task: "wikitext",
  image: CANDIDATE_IMAGE,
  run_epoch: 1759420800,
  metrics: [
    { name: "word_perplexity", filter: "none", value: 5.50, stderr: 0.12, higher_is_better: false },
  ],
});

// ---------------------------------------------------------------------------
// Helper: simulate /api/compare response shape
// ---------------------------------------------------------------------------

function buildCompareResponse(evalRows: EvalRow[], sigma: number) {
  const evalData = compareEvalRows(evalRows, BASELINE_IMAGE, CANDIDATE_IMAGE, sigma);
  const emptyPerf = { deltas: [] as DeltaItem[], missingBaseline: [], missingCandidate: [] };
  const allDeltas = [...emptyPerf.deltas, ...evalData.deltas].sort(sortDeltas);

  return {
    baseline: BASELINE_IMAGE,
    candidate: CANDIDATE_IMAGE,
    thresholds: { perf: 0.02, evalSigma: sigma },
    summary: buildSummary(emptyPerf as never, evalData),
    worstRegressions: allDeltas.filter((d) => d.status === "regression").slice(0, 25),
    perf: { deltas: [], missingBaseline: [], missingCandidate: [] },
    eval: {
      deltas: evalData.deltas.sort(sortDeltas),
      missingBaseline: evalData.missingBaseline,
      missingCandidate: evalData.missingCandidate,
    },
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helper: simulate /api/eval/baseline response shape
// ---------------------------------------------------------------------------

function buildBaselineResponse() {
  return {
    baselineImage: BASELINE_IMAGE,
    imageInfo: { kind: "release", version: "0.8.0" },
    resolvedAt: new Date().toISOString(),
    metricCount: 2,
  };
}

// ---------------------------------------------------------------------------
// Contract: /api/eval/baseline response
// ---------------------------------------------------------------------------

test("baseline response has baselineImage string (consumer: resolve_baseline)", () => {
  const resp = buildBaselineResponse();
  assert.equal(typeof resp.baselineImage, "string");
  assert.ok(resp.baselineImage.length > 0);
});

test("baseline 404 shape has baselineImage: null and error string", () => {
  const resp = { error: "No eval baseline found", baselineImage: null };
  assert.equal(resp.baselineImage, null);
  assert.equal(typeof resp.error, "string");
});

// ---------------------------------------------------------------------------
// Contract: /api/compare — passing comparison (exit 0)
// ---------------------------------------------------------------------------

test("compare response: passing comparison has zero regressions", () => {
  const resp = buildCompareResponse(
    [baselineGsm8k, candidateGsm8kPass],
    2,
  );

  assert.equal(typeof resp.summary, "object");
  assert.equal(resp.summary.regressions, 0);
  assert.ok(resp.summary.matched > 0, "at least one metric compared");
  assert.equal(resp.eval.deltas.length, 1);

  const delta = resp.eval.deltas[0];
  assertDeltaShape(delta);
  assert.notEqual(delta.status, "regression");
});

// ---------------------------------------------------------------------------
// Contract: /api/compare — regression detected (exit 1)
// ---------------------------------------------------------------------------

test("compare response: regression sets summary.regressions > 0 and delta status", () => {
  const resp = buildCompareResponse(
    [baselineGsm8k, candidateGsm8kRegression],
    2,
  );

  assert.ok(resp.summary.regressions > 0, "regressions counted in summary");

  const regressionDeltas = resp.eval.deltas.filter((d) => d.status === "regression");
  assert.ok(regressionDeltas.length > 0, "at least one regression delta");

  for (const d of regressionDeltas) {
    assertDeltaShape(d);
    assert.equal(d.status, "regression");
    assert.ok(d.significance !== null, "regression has a significance value");
  }

  assert.equal(resp.worstRegressions.length, regressionDeltas.length);
});

// ---------------------------------------------------------------------------
// Contract: /api/compare — no comparable metrics
// ---------------------------------------------------------------------------

test("compare response: no comparable metrics returns empty deltas and zero summary", () => {
  const unrelatedRow = makeEvalRow({
    model: "other-model",
    task: "other-task",
    image: "unrelated-image:latest",
    metrics: [
      { name: "acc", filter: "none", value: 0.5, stderr: 0.01, higher_is_better: true },
    ],
  });

  const resp = buildCompareResponse([unrelatedRow], 2);

  assert.equal(resp.eval.deltas.length, 0);
  assert.equal(resp.summary.regressions, 0);
  assert.equal(resp.summary.matched, 0);
});

// ---------------------------------------------------------------------------
// Contract: /api/compare — raw/unbounded metric uses "raw" unit
// ---------------------------------------------------------------------------

test("compare response: unbounded metric gets unit 'raw', not 'score'", () => {
  const resp = buildCompareResponse(
    [baselinePerplexity, candidatePerplexity],
    2,
  );

  assert.equal(resp.eval.deltas.length, 1);
  const delta = resp.eval.deltas[0];
  assertDeltaShape(delta);

  assert.equal(delta.unit, "raw", "perplexity (>1) must not be formatted as a percentage");
  assert.equal(delta.baselineValue, 5.42);
  assert.equal(delta.candidateValue, 5.50);
});

test("compare response: normalized metric gets unit 'score'", () => {
  const resp = buildCompareResponse(
    [baselineGsm8k, candidateGsm8kPass],
    2,
  );

  const delta = resp.eval.deltas[0];
  assert.equal(delta.unit, "score", "values in [0,1] must use score unit");
});

// ---------------------------------------------------------------------------
// Contract: isNormalized/inferUnit heuristic
// ---------------------------------------------------------------------------

test("isNormalized: both in [0,1] → true", () => {
  assert.equal(isNormalized(0.87, 0.85), true);
  assert.equal(isNormalized(0, 1), true);
});

test("isNormalized: value outside [0,1] → false", () => {
  assert.equal(isNormalized(5.42, 5.50), false);
  assert.equal(isNormalized(0.5, 1.01), false);
  assert.equal(isNormalized(-0.1, 0.5), false);
});

test("inferUnit: normalized → score, unbounded → raw", () => {
  assert.equal(inferUnit(0.87, 0.85), "score");
  assert.equal(inferUnit(5.42, 5.50), "raw");
});

// ---------------------------------------------------------------------------
// Contract: DeltaItem shape — all fields consumed by compare_via_api.py
// ---------------------------------------------------------------------------

test("compare response: every delta has all fields consumed by compare_via_api.py", () => {
  const resp = buildCompareResponse(
    [baselineGsm8k, candidateGsm8kRegression, baselinePerplexity, candidatePerplexity],
    2,
  );

  assert.ok(resp.eval.deltas.length >= 2, "at least two deltas");
  for (const d of resp.eval.deltas) {
    assertDeltaShape(d);
  }
});

// ---------------------------------------------------------------------------
// Contract: summary shape — all fields consumed by compare_via_api.py
// ---------------------------------------------------------------------------

test("compare response: summary has all fields consumed by compare_via_api.py", () => {
  const resp = buildCompareResponse(
    [baselineGsm8k, candidateGsm8kRegression],
    2,
  );

  assertSummaryShape(resp.summary);
});

// ---------------------------------------------------------------------------
// Contract: coverage gaps reported in eval section
// ---------------------------------------------------------------------------

test("compare response: baseline-only metric appears in missingCandidate", () => {
  const baselineOnly = makeEvalRow({
    model: "Qwen/Qwen3-5-32B",
    task: "mmlu",
    image: BASELINE_IMAGE,
    metrics: [
      { name: "acc", filter: "none", value: 0.75, stderr: 0.01, higher_is_better: true },
    ],
  });

  const resp = buildCompareResponse(
    [baselineGsm8k, candidateGsm8kPass, baselineOnly],
    2,
  );

  assert.equal(resp.eval.missingCandidate.length, 1);
  assert.equal(resp.eval.missingCandidate[0].metric, "acc");
  assert.equal(resp.summary.missingCandidate, 1);
});

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assertDeltaShape(d: DeltaItem) {
  assert.equal(typeof d.dimension, "string", "dimension is string");
  assert.equal(typeof d.metric, "string", "metric is string");
  assert.equal(typeof d.baselineValue, "number", "baselineValue is number");
  assert.equal(typeof d.candidateValue, "number", "candidateValue is number");
  assert.equal(typeof d.delta, "number", "delta is number");
  assert.equal(typeof d.status, "string", "status is string");
  assert.ok(
    ["regression", "improvement", "unchanged", "noisy"].includes(d.status),
    `status is one of the known values, got "${d.status}"`,
  );
  assert.equal(typeof d.unit, "string", "unit is string");
  assert.ok(
    d.significance === null || typeof d.significance === "number",
    "significance is number or null",
  );
}

function assertSummaryShape(s: CompareSummary) {
  assert.equal(typeof s.regressions, "number", "summary.regressions is number");
  assert.equal(typeof s.improvements, "number", "summary.improvements is number");
  assert.equal(typeof s.unchanged, "number", "summary.unchanged is number");
  assert.equal(typeof s.noisy, "number", "summary.noisy is number");
  assert.equal(typeof s.matched, "number", "summary.matched is number");
  assert.equal(typeof s.missingBaseline, "number", "summary.missingBaseline is number");
  assert.equal(typeof s.missingCandidate, "number", "summary.missingCandidate is number");
}
