import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_STALE_MINUTES,
  HOST_UNREPORTING_MINUTES,
  buildHostRows,
  diskUsedPct,
  hostReportStatus,
  indexHostsByName,
  isRamBackedMount,
  worstAlertableDisk,
} from "./gpu-host-view";
import type { GpuLatest, HostLatest } from "./gpu-types";
import type { NormalizedDiskMetric } from "./gpu-report";

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

function disk(overrides: Partial<NormalizedDiskMetric> = {}): NormalizedDiskMetric {
  return {
    mount_point: "/",
    device: "/dev/nvme0n1p2",
    fstype: "ext4",
    role: "system",
    used_bytes: 50,
    total_bytes: 100,
    error: null,
    ...overrides,
  };
}

test("worstAlertableDisk picks the fullest alertable mount", () => {
  const worst = worstAlertableDisk([
    disk({ mount_point: "/", role: "system", used_bytes: 40 }),
    disk({ mount_point: "/data", role: "data", used_bytes: 90 }),
    disk({ mount_point: "/workspace", role: "workspace", used_bytes: 70 }),
  ]);
  assert.equal(worst?.disk.mount_point, "/data");
  assert.equal(worst?.usedPct, 90);
});

test("worstAlertableDisk never lets 'other' mounts drive the cell", () => {
  const worst = worstAlertableDisk([
    disk({ mount_point: "/dev/shm", fstype: "tmpfs", role: "other", used_bytes: 99 }),
    disk({ mount_point: "/", role: "system", used_bytes: 40 }),
  ]);
  assert.equal(worst?.disk.mount_point, "/");
});

test("worstAlertableDisk skips error mounts with no usage values", () => {
  const worst = worstAlertableDisk([
    disk({
      mount_point: "/data",
      role: "data",
      used_bytes: null,
      total_bytes: null,
      error: "i/o error",
    }),
    disk({ mount_point: "/", role: "system", used_bytes: 40 }),
  ]);
  assert.equal(worst?.disk.mount_point, "/");
});

test("worstAlertableDisk returns null without usable alertable mounts", () => {
  assert.equal(worstAlertableDisk(null), null);
  assert.equal(worstAlertableDisk([]), null);
  assert.equal(
    worstAlertableDisk([disk({ role: "other", used_bytes: 99 })]),
    null,
  );
  assert.equal(
    worstAlertableDisk([
      disk({ used_bytes: null, total_bytes: null, error: "i/o error" }),
    ]),
    null,
  );
});

test("diskUsedPct guards against zero totals and missing values", () => {
  assert.equal(diskUsedPct(disk({ used_bytes: 25, total_bytes: 100 })), 25);
  assert.equal(diskUsedPct(disk({ used_bytes: 0, total_bytes: 0 })), null);
  assert.equal(
    diskUsedPct(disk({ used_bytes: null, total_bytes: null })),
    null,
  );
});

test("isRamBackedMount flags tmpfs and ramfs only", () => {
  assert.equal(isRamBackedMount(disk({ fstype: "tmpfs" })), true);
  assert.equal(isRamBackedMount(disk({ fstype: "ramfs" })), true);
  assert.equal(isRamBackedMount(disk({ fstype: "ext4" })), false);
  assert.equal(isRamBackedMount(disk({ fstype: "overlay" })), false);
});

function hostLatest(overrides: Partial<HostLatest> = {}): HostLatest {
  return {
    hostname: "h200-ci-1",
    cpu_util: 42,
    cpu_count: 64,
    ram_used_bytes: 96,
    ram_total_bytes: 256,
    ram_available_bytes: 160,
    disks: null,
    reporter_status: "ok",
    last_error: null,
    node_conditions: null,
    reported_at: "2026-09-02T19:00:00.000Z",
    ...overrides,
  };
}

test("indexHostsByName keeps one row per host, the newest one", () => {
  const map = indexHostsByName([
    hostLatest({ cpu_util: 10, reported_at: "2026-09-02T18:59:00.000Z" }),
    hostLatest({ hostname: "h200-ci-2" }),
    hostLatest({ cpu_util: 55, reported_at: "2026-09-02T19:00:00.000Z" }),
  ]);
  assert.equal(map.size, 2);
  assert.equal(map.get("h200-ci-1")?.cpu_util, 55);
  assert.equal(map.get("h200-ci-2")?.cpu_util, 42);
});
