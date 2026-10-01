import assert from "node:assert/strict";
import test from "node:test";
import { isQueueMetricFresh } from "./queue-metrics";

test("queue readings remain fresh through poll and cache delays, then expire", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  assert.equal(isQueueMetricFresh(at(15), now), true);
  assert.equal(isQueueMetricFresh(at(20), now), true);
  assert.equal(isQueueMetricFresh(at(20 + 1 / 60), now), false);
  assert.equal(isQueueMetricFresh(at(-1), now), true);
  assert.equal(isQueueMetricFresh(at(-2), now), false);
  assert.equal(isQueueMetricFresh("invalid", now), false);
});
