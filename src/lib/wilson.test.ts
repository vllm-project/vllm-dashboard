import assert from "node:assert/strict";
import test from "node:test";

import { wilsonLowerBound } from "./wilson";

test("returns 0 when there are no runs", () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.equal(wilsonLowerBound(3, 0), 0);
});

test("returns 0 when nothing failed", () => {
  assert.equal(wilsonLowerBound(0, 10), 0);
  assert.equal(wilsonLowerBound(0, 1000), 0);
});

test("matches the known 95% bound for 5/5 failures", () => {
  // center = 1 + z²/10, margin = z·sqrt(z²/100); with z = 1.96 both extra
  // terms are 0.38416, so the bound is exactly 1 / (1 + z²/5).
  assert.ok(Math.abs(wilsonLowerBound(5, 5) - 0.5655) < 1e-3);
});

test("matches the known 95% bound for 29/45 failures", () => {
  assert.ok(Math.abs(wilsonLowerBound(29, 45) - 0.4984) < 1e-3);
});

test("more runs at the same rate raise the lower bound", () => {
  const fewRuns = wilsonLowerBound(16, 25);
  const manyRuns = wilsonLowerBound(64, 100);
  assert.ok(manyRuns > fewRuns);
});

test("the bound never exceeds the raw rate and stays within [0, 1]", () => {
  for (const [failures, total] of [
    [1, 3],
    [7, 9],
    [50, 100],
    [100, 100],
  ]) {
    const lower = wilsonLowerBound(failures, total);
    assert.ok(lower >= 0);
    assert.ok(lower <= failures / total);
    assert.ok(lower <= 1);
  }
});
