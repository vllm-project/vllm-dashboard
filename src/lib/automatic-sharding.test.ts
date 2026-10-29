import assert from "node:assert/strict";
import test from "node:test";

import { classifyShardingJobs, summarizeSharding } from "./automatic-sharding";
import type { ObservedStep } from "./automatic-sharding-query";
import { parseTestStep, type TestArea } from "./test-areas";

const ran = (step: string, sharded: number, unsharded: number): ObservedStep => ({
  step,
  shardedBuilds: sharded,
  unshardedBuilds: unsharded,
  latestShards: sharded > 0 ? 4 : null,
  maxShards: sharded > 0 ? 4 : null,
  lastSeen: "2026-10-27T00:00:00Z",
  p50WallSecs: 600,
});

test("parseTestStep reads the sharding fields", () => {
  const step = parseTestStep({
    label: ":nvidia: (H200) Model Executor",
    automatic_shard: true,
    parallelism: 2,
    num_nodes: 2,
    mirror: { amd: { label: ":amd: (MI300) Model Executor", automatic_shard: true } },
  });
  assert.equal(step?.automaticShard, true);
  assert.equal(step?.parallelism, 2);
  assert.equal(step?.numNodes, 2);
  assert.equal(step?.amdMirrorAutomaticShard, true);
});

test("classifyShardingJobs sorts each job and its AMD mirror by how it ran", () => {
  const areas: TestArea[] = [
    {
      group: "Model Executor",
      steps: [
        {
          label: ":nvidia: (H200) Model Executor",
          automaticShard: true,
          amdMirrorLabel: ":amd: (MI300) Model Executor",
        },
        { label: ":nvidia: (L4) Multi-node", automaticShard: true, numNodes: 2 },
        { label: ":nvidia: (L4) Kernels Shard %N", parallelism: 4 },
        { label: "CPU Tests" },
        { label: ":nvidia: (B200) Rarely run", automaticShard: true },
      ],
    },
  ];
  const jobs = classifyShardingJobs(areas, [
    ran(":nvidia: (H200) Model Executor", 140, 0),
    ran(":amd: (MI300) Model Executor", 0, 30),
    ran(":nvidia: (L4) Multi-node", 0, 12),
  ]);
  assert.deepEqual(
    jobs.map((job) => [job.label, job.platform, job.status]),
    [
      [":nvidia: (H200) Model Executor", "nvidia", "sharding"],
      // The step is flagged but its mirror is not: the mirror runs as one job.
      [":amd: (MI300) Model Executor", "amd", "not-flagged"],
      [":nvidia: (L4) Multi-node", "nvidia", "flagged-one-job"],
      [":nvidia: (L4) Kernels Shard %N", "nvidia", "fixed-split"],
      ["CPU Tests", "other", "not-flagged"],
      [":nvidia: (B200) Rarely run", "nvidia", "flagged-not-run"],
    ],
  );
  assert.equal(jobs[2].multiNode, true);
  assert.deepEqual(summarizeSharding(jobs), {
    jobs: 6,
    flagged: 3,
    sharding: 1,
    byPlatform: {
      nvidia: { jobs: 4, flagged: 3, sharding: 1 },
      amd: { jobs: 1, flagged: 0, sharding: 0 },
      other: { jobs: 1, flagged: 0, sharding: 0 },
    },
  });
});

test("classifyShardingJobs counts a label repeated across YAML files once", () => {
  const areas: TestArea[] = [
    { group: "A", steps: [{ label: "Same" }] },
    { group: "B", steps: [{ label: "Same", automaticShard: true }] },
  ];
  assert.equal(classifyShardingJobs(areas, []).length, 1);
});
