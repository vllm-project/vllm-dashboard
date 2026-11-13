import assert from "node:assert/strict";
import test from "node:test";

import {
  computePricingCoverage,
  getQueueCost,
  QUEUE_COSTS,
} from "./queue-costs";

test("getQueueCost returns known and estimated pricing", () => {
  assert.deepEqual(getQueueCost("gpu_1_queue"), {
    instanceType: "g6.4xlarge",
    costPerHour: 1.3232,
  });
  const h200 = getQueueCost("h200_35gb");
  assert.equal(h200?.estimated, true);
  assert.ok(h200?.costPerHour && h200.costPerHour > 0);
  assert.ok(h200?.source, "estimated rates must document their source");
  assert.equal(getQueueCost("definitely-not-a-queue"), null);
});

test("every estimated rate documents a source", () => {
  for (const [queue, pricing] of Object.entries(QUEUE_COSTS)) {
    assert.ok(pricing.costPerHour > 0, `${queue} has a positive rate`);
    if (pricing.estimated) {
      assert.ok(pricing.source, `${queue} is estimated but has no source`);
    }
  }
});

test("the largest unpriced queues are now covered", () => {
  // The queues that made the Cost page total misleading (see #cost-priced-coverage).
  for (const queue of ["h200_35gb", "amd_mi300_1", "amd_mi355_1", "b200-k8s"]) {
    assert.ok(getQueueCost(queue), `${queue} should be priced`);
  }
});

test("computePricingCoverage splits priced, estimated, and unpriced hours", () => {
  const coverage = computePricingCoverage([
    { queue: "gpu_1_queue", total_hours: 10 }, // confirmed rate
    { queue: "h200_35gb", total_hours: 30 }, // estimated rate
    { queue: "mystery_queue", total_hours: 60 }, // unpriced
  ]);
  assert.equal(coverage.totalHours, 100);
  assert.equal(coverage.pricedHours, 10);
  assert.equal(coverage.estimatedHours, 30);
  assert.equal(coverage.unpricedHours, 60);
  assert.equal(coverage.pricedHoursShare, 0.1);
  assert.equal(coverage.estimatedHoursShare, 0.3);
});

test("computePricingCoverage handles empty input", () => {
  const coverage = computePricingCoverage([]);
  assert.equal(coverage.totalHours, 0);
  assert.equal(coverage.pricedHoursShare, 0);
  assert.equal(coverage.estimatedHoursShare, 0);
});
