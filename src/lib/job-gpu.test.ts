import assert from "node:assert/strict";
import test from "node:test";
import { parseGpuEvents, summarizeGpuSamples, gpuSegments, type JobGpuSample } from "./job-gpu";

function event(ms: number, attributes: Record<string, unknown> = {}) {
  return { name: "ci.gpu.sample", timeUnixNano: String(ms * 1e6), attributes: {
    "gpu.uuid": "GPU-a", "gpu.index": 0, "gpu.name": "H200", "gpu.utilization": 0,
    "gpu.memory.used": 1024, "gpu.memory.total": 4096, ...attributes,
  } };
}

test("intervals are half-open so adjacent tests do not share a boundary sample", () => {
  const events = [event(999), event(1000), event(1999), event(2000)];
  assert.deepEqual(parseGpuEvents(events, 1000, 2000).map((s) => s.timestamp), [1000, 1999]);
  assert.equal(parseGpuEvents(events, 1500, 1600).length, 0);
});

test("invalid, missing and MIG metrics stay unknown, while measured zero stays zero", () => {
  const result = parseGpuEvents([
    event(1000), event(1100, { "gpu.utilization": "N/A", "gpu.memory.used": -1 }),
    event(1200, { "gpu.utilization": 101, "gpu.memory.used": 5000 }),
    event(1300, { "gpu.status": "unsupported_mig", "gpu.utilization": 70 }),
    { name: "other", timeUnixNano: "1000000000" }, null,
  ], 1000, 2000);
  assert.equal(result[0].utilization, 0);
  for (const sample of result.slice(1)) {
    assert.equal(sample.utilization, null);
    assert.equal(sample.memoryUsedBytes, null);
  }
  assert.equal(result[3].memoryTotalBytes, null);
});

test("summaries isolate GPU UUIDs, deduplicate retries, and retain coverage gaps", () => {
  const samples = parseGpuEvents([
    event(1000, { "gpu.utilization": 20 }), event(2000, { "gpu.utilization": 80 }),
    event(2000, { "gpu.utilization": 80 }),
    event(1000, { "gpu.uuid": "GPU-b", "gpu.index": 1, "gpu.utilization": 0 }),
    event(9000, { "gpu.utilization": 100 }),
  ], 0, 10_000);
  const summaries = summarizeGpuSamples(samples, 0, 4000, 1000);
  assert.equal(summaries[0].samples.length, 2);
  assert.equal(summaries[0].meanUtilization, 50);
  assert.equal(summaries[0].coverage, 0.5);
  assert.equal(summaries[1].meanUtilization, 0);
  assert.equal(summaries[1].coverage, 0.25);
  assert.deepEqual(summarizeGpuSamples(samples, 2500, 2700, 1000), []);
});

test("charts break lines on unknown readings and sampling gaps", () => {
  const samples = parseGpuEvents([
    event(0), event(1000), event(2000, { "gpu.utilization": "N/A" }),
    event(3000), event(7000), event(8000),
  ], 0, 9000);
  assert.deepEqual(gpuSegments(samples, "utilization", 1000).map((s) => s.map((p) => p.timestamp)), [[0, 1000], [3000], [7000, 8000]]);
  assert.equal(gpuSegments(samples, "memoryUsedBytes", 1000).length, 2);
});

test("unsupported utilization cannot become an idle mean or full coverage", () => {
  const sample = parseGpuEvents([event(1000, { "gpu.utilization": "N/A" })], 0, 2000)[0] as JobGpuSample;
  const summary = summarizeGpuSamples([sample], 0, 2000, 1000)[0];
  assert.equal(summary.meanUtilization, null);
  assert.equal(summary.coverage, 0);
  assert.equal(summary.peakMemoryBytes, 1024);
});
