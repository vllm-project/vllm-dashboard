import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_STALE_MINUTES,
  HOST_UNREPORTING_MINUTES,
  buildHostRows,
  hostReportStatus,
} from "./gpu-host-view";
import type { GpuLatest } from "./gpu-types";

function gpu(overrides: Partial<GpuLatest> = {}): GpuLatest {
  return {
    hostname: "h200-ci-1",
    gpu_index: 0,
    gpu_name: "NVIDIA H200",
    gpu_util: 10,
    mem_used_mb: 1000,
    mem_total_mb: 143771,
    temperature_c: 40,
    power_draw_w: 100,
    power_limit_w: 700,
    reported_at: "2026-09-02T19:00:00.000Z",
    ...overrides,
  };
}

const gpuType = (name: string | null) => name ?? "Unknown";

test("a host stays fresh right up to the stale threshold", () => {
  assert.equal(hostReportStatus(0), "fresh");
  assert.equal(hostReportStatus(HOST_STALE_MINUTES), "fresh");
});

test("a host turns stale past five minutes and unreporting past ten", () => {
  assert.equal(hostReportStatus(HOST_STALE_MINUTES + 1), "stale");
  assert.equal(hostReportStatus(HOST_UNREPORTING_MINUTES), "stale");
  assert.equal(hostReportStatus(HOST_UNREPORTING_MINUTES + 1), "unreporting");
});

test("host temperature is the hottest GPU, not an average", () => {
  const rows = buildHostRows(
    [
      gpu({ gpu_index: 0, temperature_c: 41 }),
      gpu({ gpu_index: 1, temperature_c: 87 }),
      gpu({ gpu_index: 2, temperature_c: 52 }),
    ],
    gpuType,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].maxTemperatureC, 87);
});

test("host power sums only the GPUs that reported it", () => {
  const rows = buildHostRows(
    [
      gpu({ gpu_index: 0, power_draw_w: 120, power_limit_w: 700 }),
      gpu({ gpu_index: 1, power_draw_w: null, power_limit_w: null }),
      gpu({ gpu_index: 2, power_draw_w: 80, power_limit_w: 700 }),
    ],
    gpuType,
  );
  assert.equal(rows[0].powerDrawW, 200);
  assert.equal(rows[0].powerLimitW, 1400);
});

test("hosts reporting no temperature or power stay null rather than zero", () => {
  const rows = buildHostRows(
    [gpu({ temperature_c: null, power_draw_w: null, power_limit_w: null })],
    gpuType,
  );
  assert.equal(rows[0].maxTemperatureC, null);
  assert.equal(rows[0].powerDrawW, null);
  assert.equal(rows[0].powerLimitW, null);
});

test("hosts are sorted, GPUs ordered by index, last seen is the newest report", () => {
  const rows = buildHostRows(
    [
      gpu({ hostname: "h200-ci-2", gpu_index: 1, reported_at: "2026-09-02T19:00:30.000Z" }),
      gpu({ hostname: "h200-ci-2", gpu_index: 0, reported_at: "2026-09-02T19:00:00.000Z" }),
      gpu({ hostname: "dgxb200-01", gpu_index: 0 }),
    ],
    gpuType,
  );
  assert.deepEqual(rows.map((r) => r.hostname), ["dgxb200-01", "h200-ci-2"]);
  assert.deepEqual(rows[1].gpus.map((g) => g.index), [0, 1]);
  assert.equal(rows[1].lastSeen, "2026-09-02T19:00:30.000Z");
});
