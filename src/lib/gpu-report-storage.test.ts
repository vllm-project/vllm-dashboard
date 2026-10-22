import assert from "node:assert/strict";
import test from "node:test";
import { buildGpuRollups } from "./gpu-report-storage";
import type { NormalizedGpuMetric } from "./gpu-report";

function gpu(overrides: Partial<NormalizedGpuMetric> = {}): NormalizedGpuMetric {
  return {
    index: 0,
    name: "NVIDIA H200",
    gpu_util: 40,
    mem_used_mb: 50,
    mem_total_mb: 100,
    temperature_c: null,
    power_draw_w: null,
    power_limit_w: null,
    dead_proc_mem_mb: null,
    recovery_action: null,
    remapped_rows_failure: null,
    ecc_uncorrected: null,
    ...overrides,
  };
}

test("rollups count utilization samples apart from memory samples", () => {
  const bucket = new Date("2026-10-22T00:00:00Z");
  const rollups = buildGpuRollups(
    [
      gpu({ index: 0, gpu_util: 40 }),
      gpu({ index: 1, gpu_util: null, mem_used_mb: 100 }),
      gpu({ index: 2, name: null, gpu_util: 10 }),
    ],
    "h200-ci-2",
    bucket,
  );
  assert.deepEqual(rollups, [
    {
      time_bucket: bucket,
      hostname: "h200-ci-2",
      gpu_name: "NVIDIA H200",
      mem_pct_sum: 150,
      gpu_util_sum: 40,
      gpu_util_count: 1,
      sample_count: 2,
    },
    {
      time_bucket: bucket,
      hostname: "h200-ci-2",
      gpu_name: "Unknown",
      mem_pct_sum: 50,
      gpu_util_sum: 10,
      gpu_util_count: 1,
      sample_count: 1,
    },
  ]);
});

test("rollups give zero-memory GPUs a 0% memory sample", () => {
  const [rollup] = buildGpuRollups([gpu({ mem_total_mb: 0 })], "h", new Date(0));
  assert.equal(rollup.mem_pct_sum, 0);
});
