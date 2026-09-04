import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GpuHostTable } from "./gpu-host-table";
import type { HostLatest } from "../lib/gpu-types";
import type { NormalizedDiskMetric } from "../lib/gpu-report";
import type { HostRow } from "../lib/gpu-host-view";

const NOW = new Date("2026-09-02T19:05:00.000Z").getTime();

function hostRow(overrides: Partial<HostRow> = {}): HostRow {
  return {
    hostname: "h200-ci-1",
    gpuType: "H200",
    gpuCount: 2,
    gpuUtil: 120,
    memUsedMb: 2000,
    memTotalMb: 287542,
    maxTemperatureC: 61,
    powerDrawW: 300,
    powerLimitW: 1400,
    lastSeen: "2026-09-02T19:04:00.000Z",
    gpus: [
      {
        index: 0,
        gpuUtil: 55,
        memUsedMb: 1000,
        memTotalMb: 143771,
        temperatureC: 61,
        powerDrawW: 300,
        powerLimitW: 700,
      },
      {
        index: 1,
        gpuUtil: 65,
        memUsedMb: 1000,
        memTotalMb: 143771,
        temperatureC: 58,
        powerDrawW: null,
        powerLimitW: null,
      },
    ],
    ...overrides,
  };
}

function disk(overrides: Partial<NormalizedDiskMetric> = {}): NormalizedDiskMetric {
  return {
    mount_point: "/",
    device: "/dev/nvme0n1p2",
    fstype: "ext4",
    role: "system",
    used_bytes: 40 * 1024 ** 3,
    total_bytes: 100 * 1024 ** 3,
    error: null,
    ...overrides,
  };
}

function hostLatest(overrides: Partial<HostLatest> = {}): HostLatest {
  return {
    hostname: "h200-ci-1",
    cpu_util: 42,
    cpu_count: 64,
    ram_used_bytes: 96 * 1024 ** 3,
    ram_total_bytes: 256 * 1024 ** 3,
    ram_available_bytes: 160 * 1024 ** 3,
    disks: [disk()],
    reporter_status: "ok",
    last_error: null,
    node_conditions: null,
    reported_at: "2026-09-02T19:04:30.000Z",
    ...overrides,
  };
}

function render(
  hostRows: HostRow[],
  hosts: HostLatest[],
  defaultExpanded: string | null = null,
): string {
  return renderToStaticMarkup(
    createElement(GpuHostTable, {
      hostRows,
      hosts,
      now: NOW,
      defaultExpanded,
    }),
  );
}

test("a fresh host renders a health dot, hostname, and metric bars", () => {
  const markup = render([hostRow()], [hostLatest()]);

  assert.match(markup, /aria-label="Status: fresh"/);
  assert.match(markup, /h200-ci-1/);
  assert.doesNotMatch(markup, /Stale|Unreporting/);
  // CPU 42%, RAM 37.5% -> 38%, disk 40%.
  assert.match(markup, />42%</);
  assert.match(markup, />38%</);
  assert.match(markup, />40%</);
});

test("stale and unreporting hosts keep their badges and dot colors", () => {
  const markup = render(
    [
      hostRow({
        hostname: "h200-ci-stale",
        lastSeen: "2026-09-02T18:58:00.000Z",
      }),
      hostRow({
        hostname: "h200-ci-dead",
        lastSeen: "2026-09-02T18:40:00.000Z",
      }),
    ],
    [],
  );

  assert.match(markup, /aria-label="Status: stale"/);
  assert.match(markup, /aria-label="Status: unreporting"/);
  assert.match(markup, />Stale</);
  assert.match(markup, />Unreporting</);
  assert.match(markup, />7m ago</);
  assert.match(markup, />25m ago</);
});

test("a host without host metrics shows empty cells and a graceful drill-down", () => {
  const markup = render([hostRow()], [], "h200-ci-1");

  // CPU, RAM, and Disk cells all render the em-dash empty state.
  const dashes = markup.match(/>—</g) ?? [];
  assert.ok(dashes.length >= 3, `expected >= 3 empty cells, got ${dashes.length}`);
  assert.match(markup, /No host-level metrics reported yet/);
  // GPU detail still renders in the drill-down.
  assert.match(markup, /GPU 0/);
  assert.match(markup, /No disk metrics reported/);
});

test("the disk cell shows the worst alertable mount, never an 'other' mount", () => {
  const markup = render(
    [hostRow()],
    [
      hostLatest({
        disks: [
          disk({
            mount_point: "/dev/shm",
            device: "tmpfs",
            fstype: "tmpfs",
            role: "other",
            used_bytes: 99 * 1024 ** 3,
          }),
          disk({
            mount_point: "/data",
            device: "/dev/nvme1n1",
            role: "data",
            used_bytes: 60 * 1024 ** 3,
          }),
        ],
      }),
    ],
  );

  // 60% (the data mount) drives the cell, not the 99% tmpfs mount.
  assert.match(markup, />60%</);
  assert.doesNotMatch(markup, />99%</);
});

test("tmpfs mounts are labeled as RAM-backed in the drill-down", () => {
  const markup = render(
    [hostRow()],
    [
      hostLatest({
        disks: [
          disk({
            mount_point: "/dev/shm",
            device: "tmpfs",
            fstype: "tmpfs",
            role: "other",
            used_bytes: 10 * 1024 ** 3,
          }),
        ],
      }),
    ],
    "h200-ci-1",
  );

  assert.match(markup, /\/dev\/shm/);
  assert.match(markup, /RAM-backed/);
});

test("the drill-down surfaces a degraded reporter and its last error", () => {
  const markup = render(
    [hostRow()],
    [
      hostLatest({
        reporter_status: "degraded",
        last_error: "nvidia-smi timed out after 30s",
      }),
    ],
    "h200-ci-1",
  );

  assert.match(markup, /reporter: degraded/);
  assert.match(markup, /last error: nvidia-smi timed out after 30s/);
});

test("a cordoned-but-Ready node is visibly marked as both", () => {
  const markup = render(
    [hostRow()],
    [
      hostLatest({
        node_conditions: {
          ready: true,
          disk_pressure: true,
          memory_pressure: false,
          pid_pressure: false,
          unschedulable: true,
        },
      }),
    ],
    "h200-ci-1",
  );

  assert.match(markup, />Ready</);
  assert.match(markup, />Cordoned</);
  assert.match(markup, />DiskPressure</);
  assert.doesNotMatch(markup, /MemoryPressure/);
});

test("a NotReady node renders the NotReady chip", () => {
  const markup = render(
    [hostRow()],
    [
      hostLatest({
        node_conditions: {
          ready: false,
          disk_pressure: false,
          memory_pressure: true,
          pid_pressure: false,
          unschedulable: false,
        },
      }),
    ],
    "h200-ci-1",
  );

  assert.match(markup, />NotReady</);
  assert.match(markup, />MemoryPressure</);
  assert.doesNotMatch(markup, />Cordoned</);
});

test("mounts with a per-mount error show the error instead of a bar", () => {
  const markup = render(
    [hostRow()],
    [
      hostLatest({
        disks: [
          disk({
            mount_point: "/mnt/ephemeral",
            device: "/dev/nvme2n1",
            role: "workspace",
            used_bytes: null,
            total_bytes: null,
            error: "i/o error while statfs",
          }),
        ],
      }),
    ],
    "h200-ci-1",
  );

  assert.match(markup, /\/mnt\/ephemeral/);
  assert.match(markup, /i\/o error while statfs/);
});

test("the drill-down lists per-GPU utilization, memory, and temperature", () => {
  const markup = render([hostRow()], [hostLatest()], "h200-ci-1");

  assert.match(markup, /GPU 0/);
  assert.match(markup, /GPU 1/);
  assert.match(markup, />55%</);
  assert.match(markup, />65%</);
  assert.match(markup, /61°C/);
});

test("an empty roster keeps the deployment hint", () => {
  const markup = render([], []);

  assert.match(markup, /No GPU data found/);
});

test("the drill-down hides container plumbing mounts and says how many", () => {
  const markup = render(
    [hostRow()],
    [
      hostLatest({
        disks: [
          disk({ mount_point: "/" }),
          disk({ mount_point: "/data", device: "/dev/md127", role: "data" }),
          disk({ device: "overlay_0-569", mount_point: null, role: "other" }),
          disk({
            mount_point:
              "/run/containerd/io.containerd.grpc.v1.cri/sandboxes/abc123/shm",
            device: "shm",
            fstype: "tmpfs",
            role: "other",
          }),
          disk({
            mount_point:
              "/var/lib/kubelet/pods/0102f2e2/volumes/kubernetes.io~projected/kube-api-access-gjhj7",
            device: "tmpfs",
            fstype: "tmpfs",
            role: "other",
          }),
        ],
      }),
    ],
    "h200-ci-1",
  );

  assert.match(markup, /\/data/);
  assert.doesNotMatch(markup, /overlay_0-569/);
  assert.doesNotMatch(markup, /sandboxes/);
  assert.doesNotMatch(markup, /kube-api-access/);
  assert.match(markup, /3 container\/pod mounts hidden/);
});
