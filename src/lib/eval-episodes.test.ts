import assert from "node:assert/strict";
import test from "node:test";
import { planEpisodes, shouldNotify, type OpenEpisode } from "./eval-episodes";
import type { DeltaItem } from "./compare";

function makeDelta(overrides: Partial<DeltaItem> & { key: string }): DeltaItem {
  const { key, ...rest } = overrides;
  return {
    area: "eval",
    key,
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
    ...rest,
  };
}

function makeAlert(id: number, key: string): OpenEpisode {
  const parts = key.split("|");
  return {
    alert_id: id,
    model: parts[0],
    task: parts[1],
    n_shot: parseInt(parts[2], 10),
    metric: parts[3],
    filter: parts[4],
  };
}

// --- planEpisodes ---

test("planEpisodes: compared-clean key resolves open episode", () => {
  const key = "Qwen/Qwen3-5-32B|gsm8k|0|exact_match|flexible-extract";
  const alerts = [makeAlert(1, key)];
  const allDeltas = [makeDelta({ key, status: "unchanged" })];
  const regressions: DeltaItem[] = [];

  const plan = planEpisodes(alerts, allDeltas, regressions);
  assert.deepEqual(plan.toResolve, [1]);
  assert.equal(plan.toUpsert.length, 0);
  assert.equal(plan.unchanged.length, 0);
});

test("planEpisodes: regressing key stays open", () => {
  const key = "Qwen/Qwen3-5-32B|gsm8k|0|exact_match|flexible-extract";
  const alerts = [makeAlert(1, key)];
  const reg = makeDelta({ key, status: "regression" });
  const allDeltas = [reg];

  const plan = planEpisodes(alerts, allDeltas, [reg]);
  assert.equal(plan.toResolve.length, 0);
  assert.equal(plan.toUpsert.length, 1);
  assert.deepEqual(plan.unchanged, [1]);
});

test("planEpisodes: uncovered key left alone", () => {
  const coveredKey = "Qwen/Qwen3-5-32B|gsm8k|0|exact_match|flexible-extract";
  const uncoveredKey = "Qwen/Qwen3-5-32B|mmlu|5|acc|none";
  const alerts = [makeAlert(1, uncoveredKey)];
  const allDeltas = [makeDelta({ key: coveredKey, status: "unchanged" })];

  const plan = planEpisodes(alerts, allDeltas, []);
  assert.equal(plan.toResolve.length, 0);
  assert.deepEqual(plan.unchanged, [1]);
});

test("planEpisodes: new regression with no prior episode opens one", () => {
  const key = "Qwen/Qwen3-5-32B|gsm8k|0|exact_match|flexible-extract";
  const alerts: OpenEpisode[] = [];
  const reg = makeDelta({ key, status: "regression" });

  const plan = planEpisodes(alerts, [reg], [reg]);
  assert.equal(plan.toUpsert.length, 1);
  assert.equal(plan.toResolve.length, 0);
  assert.equal(plan.unchanged.length, 0);
});

test("planEpisodes: malformed key delta is skipped", () => {
  const alerts: OpenEpisode[] = [];
  const bad = makeDelta({ key: "malformed", status: "regression" });

  const plan = planEpisodes(alerts, [bad], [bad]);
  assert.equal(plan.toUpsert.length, 0);
});

test("planEpisodes: mixed — one resolves, one stays, one opens", () => {
  const resolveKey = "Qwen/Qwen3-5-32B|gsm8k|0|exact_match|flexible-extract";
  const stayKey = "Qwen/Qwen3-5-32B|mmlu|5|acc|none";
  const newKey = "Qwen/Qwen3-5-32B|hellaswag|0|acc_norm|none";

  const alerts = [makeAlert(1, resolveKey), makeAlert(2, stayKey)];
  const newReg = makeDelta({ key: newKey, status: "regression" });
  const allDeltas = [
    makeDelta({ key: resolveKey, status: "unchanged" }),
    newReg,
    // stayKey is NOT in allDeltas — uncovered
  ];

  const plan = planEpisodes(alerts, allDeltas, [newReg]);
  assert.deepEqual(plan.toResolve, [1]);
  assert.deepEqual(plan.unchanged, [2]);
  assert.equal(plan.toUpsert.length, 1);
});

// --- shouldNotify ---

test("shouldNotify: no prior notification, healthy → no notification (no daily all-clear)", () => {
  assert.equal(shouldNotify("pass", new Set(), null, null), false);
});

test("shouldNotify: no prior notification, regression → notify", () => {
  assert.equal(shouldNotify("regression", new Set(["k1"]), null, null), true);
});

test("shouldNotify: pass → regression → notify", () => {
  assert.equal(shouldNotify("regression", new Set(["k1"]), "pass", []), true);
});

test("shouldNotify: regression → pass → notify", () => {
  assert.equal(shouldNotify("pass", new Set(), "regression", ["k1"]), true);
});

test("shouldNotify: same regression, same keys → no notification", () => {
  assert.equal(
    shouldNotify("regression", new Set(["k1", "k2"]), "regression", ["k1", "k2"]),
    false,
  );
});

test("shouldNotify: same regression, new key added (escalation) → notify", () => {
  assert.equal(
    shouldNotify("regression", new Set(["k1", "k2", "k3"]), "regression", ["k1", "k2"]),
    true,
  );
});

test("shouldNotify: same regression, key removed (partial recovery) → notify", () => {
  assert.equal(
    shouldNotify("regression", new Set(["k1"]), "regression", ["k1", "k2"]),
    true,
  );
});

test("shouldNotify: pass → pass across days → no notification", () => {
  assert.equal(shouldNotify("pass", new Set(), "pass", []), false);
});
