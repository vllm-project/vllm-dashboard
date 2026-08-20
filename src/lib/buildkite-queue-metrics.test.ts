import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateQueueSnapshots,
  calculateWaitPercentiles,
} from "./buildkite-queue-metrics";

const NOW = new Date("2026-08-20T12:00:00.000Z");

test("calculateWaitPercentiles uses nearest-rank wait ages", () => {
  const result = calculateWaitPercentiles(
    [10, 20, 30, 40, 100].map(
      (seconds) => new Date(NOW.getTime() - seconds * 1000).toISOString(),
    ),
    NOW,
  );

  assert.deepEqual(result, {
    p50: 30,
    p90: 100,
    p95: 100,
    p99: 100,
    sampleSize: 5,
  });
});

test("calculateWaitPercentiles ignores missing dates and clamps future timestamps", () => {
  const result = calculateWaitPercentiles(
    [null, "not-a-date", new Date(NOW.getTime() + 10_000).toISOString()],
    NOW,
  );

  assert.deepEqual(result, {
    p50: 0,
    p90: 0,
    p95: 0,
    p99: 0,
    sampleSize: 1,
  });
});

test("aggregateQueueSnapshots keeps Buildkite counts and groups waits by queue", () => {
  const snapshots = aggregateQueueSnapshots(
    [
      {
        id: "queue-a",
        key: "gpu_4_queue",
        metrics: {
          connectedAgentsCount: 13,
          runningJobsCount: 13,
          waitingJobsCount: 3,
        },
      },
      {
        id: "queue-b",
        key: "H200",
        metrics: {
          connectedAgentsCount: 1,
          runningJobsCount: 1,
          waitingJobsCount: 0,
        },
      },
      {
        id: "queue-c",
        key: "gpu_4_queue",
        metrics: {
          connectedAgentsCount: 2,
          runningJobsCount: 1,
          waitingJobsCount: 1,
        },
      },
    ],
    [
      ...[10, 20, 60].map((seconds) => ({
        clusterQueueId: "queue-a",
        runnableAt: new Date(NOW.getTime() - seconds * 1000).toISOString(),
      })),
      {
        clusterQueueId: "queue-c",
        runnableAt: new Date(NOW.getTime() - 120 * 1000).toISOString(),
      },
    ],
    NOW,
  );

  assert.deepEqual(snapshots, [
    {
      queue: "gpu_4_queue",
      polledAt: NOW.toISOString(),
      connectedAgents: 15,
      runningJobs: 14,
      waitingJobs: 4,
      p50: 20,
      p90: 120,
      p95: 120,
      p99: 120,
      sampleSize: 4,
    },
    {
      queue: "H200",
      polledAt: NOW.toISOString(),
      connectedAgents: 1,
      runningJobs: 1,
      waitingJobs: 0,
      p50: null,
      p90: null,
      p95: null,
      p99: null,
      sampleSize: 0,
    },
  ]);
});
