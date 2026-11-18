import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import {
  NICHE_EXAMPLE,
  SCORING,
  TIERS,
  WORKED_EXAMPLE,
  roundHalfEven,
  scoreExample,
} from "./triage-scoring-config";

function loadYaml(name: string): unknown {
  return yaml.load(readFileSync(join(process.cwd(), "triage", "config", name), "utf8"));
}

test("the guide's numbers match triage/config/scoring.yaml exactly", () => {
  assert.deepEqual(loadYaml("scoring.yaml"), SCORING);
});

test("the guide's tier lists match triage/config/tiers.yaml exactly", () => {
  assert.deepEqual(loadYaml("tiers.yaml"), TIERS);
});

test("rounding matches Python's round()", () => {
  assert.equal(roundHalfEven(2.5), 2);
  assert.equal(roundHalfEven(3.5), 4);
  assert.equal(roundHalfEven(-2.5), -2);
  assert.equal(roundHalfEven(50 * 1.15), 57); // 57.49999999999999 in floating point
  assert.equal(roundHalfEven(10.4), 10);
  assert.equal(roundHalfEven(10.6), 11);
});

// Expected values were produced by triage/scoring.py's score_item() for the
// same inputs (see the PR description); the guide must show the router's math.
test("worked example: serving broken on DeepSeek, H100, default flags → 83, P0", () => {
  assert.deepEqual(scoreExample(WORKED_EXAMPLE), {
    score: 83,
    band: "page",
    factors: [
      {
        factor: "severity.serving_broken",
        points: 57,
        detail: "50 base; model tier1 x1; hw tier1 x1; config default x1.15",
      },
      { factor: "type.bug", points: 3 },
      { factor: "popularity.model.tier1", points: 6, detail: "deepseek-v3" },
      { factor: "popularity.hardware.tier1", points: 3, detail: "H100" },
      { factor: "recency.affects_latest_release", points: 10, detail: "0.27.1" },
      { factor: "evidence.has_repro", points: 4 },
    ],
  });
});

test("contrast example: the same outage on a niche setup → 12, P3", () => {
  assert.deepEqual(scoreExample(NICHE_EXAMPLE), {
    score: 12,
    band: "ignore",
    factors: [
      {
        factor: "severity.serving_broken",
        points: 9,
        detail: "50 base; model other x0.6; hw other x0.55; config exotic x0.55",
      },
      { factor: "type.bug", points: 3 },
    ],
  });
});

test("a named model outside the tier lists gets reach.model.other, not unknown", () => {
  const onH100 = { ...NICHE_EXAMPLE, hardwareTier: "tier1", hardware: "H100", config: "default" } as const;
  assert.deepEqual(scoreExample(onH100), {
    score: 40,
    band: "route",
    factors: [
      {
        factor: "severity.serving_broken",
        points: 34,
        detail: "50 base; model other x0.6; hw tier1 x1; config default x1.15",
      },
      { factor: "type.bug", points: 3 },
      { factor: "popularity.hardware.tier1", points: 3, detail: "H100" },
    ],
  });
  // No model named at all: the "unknown" multiplier.
  assert.deepEqual(scoreExample({ ...onH100, modelTier: null, model: undefined }), {
    score: 49,
    band: "route",
    factors: [
      {
        factor: "severity.serving_broken",
        points: 43,
        detail: "50 base; model unknown x0.75; hw tier1 x1; config default x1.15",
      },
      { factor: "type.bug", points: 3 },
      { factor: "popularity.hardware.tier1", points: 3, detail: "H100" },
    ],
  });
});

test("features don't get severity points, PRs get half, security ignores reach", () => {
  const feature = scoreExample({ ...WORKED_EXAMPLE, type: "feature" });
  assert.ok(!feature.factors.some((factor) => factor.factor.startsWith("severity.")));
  const pr = scoreExample({ ...WORKED_EXAMPLE, kind: "pr" });
  assert.equal(pr.factors[0].points, roundHalfEven(50 * 1.15 * 0.5));
  assert.match(pr.factors[0].detail ?? "", /; pr x0\.5$/);
  const security = scoreExample({ ...NICHE_EXAMPLE, severity: "security" });
  assert.deepEqual(security.factors[0], { factor: "severity.security", points: 50, detail: "50 base" });
});

test("thresholds give the P-levels in order", () => {
  const { page, route, watch } = SCORING.thresholds;
  assert.ok(page > route && route > watch && watch > 0);
});
