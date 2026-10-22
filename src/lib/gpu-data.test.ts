import assert from "node:assert/strict";
import test from "node:test";
import { summarizeGpuHistory } from "./gpu-data";
import type { GpuSnapshot } from "./gpu-types";

function snapshot(overrides: Partial<GpuSnapshot> = {}): GpuSnapshot {
  return {
    time_bucket: "2026-10-22T00:00:00.000Z",
    hostname: "h1",
    gpu_name: "GPU",
    mem_pct_sum: 100,
    gpu_util_sum: 0,
    gpu_util_count: 0,
    sample_count: 2,
    ...overrides,
  };
}

test("overview utilization divides by utilization samples only", () => {
  const [point] = summarizeGpuHistory({
    hours: 24,
    snapshots: [
      snapshot({ hostname: "h1", gpu_util_sum: 80, gpu_util_count: 1 }),
      snapshot({ hostname: "h2", gpu_util_sum: 20, gpu_util_count: 2 }),
      snapshot({ hostname: "mig" }),
    ],
  });
  assert.equal(point.memoryP50, 50);
  assert.equal(point.gpuPeak, 80);
  assert.equal(point.gpuP50, 45);
  assert.equal(point.gpuP90, 73);
});

test("a bucket with no utilization samples has no GPU values, not 0%", () => {
  const [point] = summarizeGpuHistory({ hours: 24, snapshots: [snapshot()] });
  assert.equal(point.memoryP50, 50);
  assert.deepEqual([point.gpuP50, point.gpuP90, point.gpuPeak], [null, null, null]);
});

test("overview buckets come out in time order and skip empty hosts", () => {
  const points = summarizeGpuHistory({
    hours: 24,
    snapshots: [
      snapshot({ time_bucket: "2026-10-22T00:05:00.000Z", mem_pct_sum: 60, sample_count: 1 }),
      snapshot({ time_bucket: "2026-10-22T00:00:00.000Z", mem_pct_sum: 30, sample_count: 1 }),
      snapshot({ time_bucket: "2026-10-22T00:00:00.000Z", hostname: "h2", mem_pct_sum: 0, sample_count: 0 }),
    ],
  });
  assert.deepEqual(
    points.map((p) => [p.time, p.memoryP50, p.memoryPeak]),
    [
      [Date.parse("2026-10-22T00:00:00.000Z"), 30, 30],
      [Date.parse("2026-10-22T00:05:00.000Z"), 60, 60],
    ],
  );
});
