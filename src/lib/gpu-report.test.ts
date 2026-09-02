import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GPU_REPORT_MAX_BYTES,
  GpuReportValidationError,
  gpuReportAuthResult,
  gpuReportMaxBytes,
  parseGpuReportPayload,
} from "./gpu-report";

const legacyPayload = {
  hostname: "DGXB200-09",
  gpus: [
    {
      index: 0,
      name: "NVIDIA B200",
      gpu_util: 42,
      mem_used_mb: 10,
      mem_total_mb: 100,
      temperature_c: 61,
      power_draw_w: 410,
      power_limit_w: 1000,
    },
  ],
};

test("accepts the legacy GPU-only payload and normalizes hostname identity", () => {
  const report = parseGpuReportPayload(legacyPayload);

  assert.equal(report.hostname, "dgxb200-09");
  assert.equal(report.reporter_status, "ok");
  assert.equal(report.host, null);
  assert.equal(report.node_conditions, null);
});

test("accepts host metrics, per-mount errors, and Kubernetes node conditions", () => {
  const report = parseGpuReportPayload({
    ...legacyPayload,
    host: {
      cpu_util: 12.5,
      cpu_count: 160,
      ram_used_bytes: 1000,
      ram_total_bytes: 4000,
      ram_available_bytes: 2800,
      disks: [
        {
          mount_point: "/",
          device: "/dev/vda1",
          fstype: "ext4",
          role: "system",
          used_bytes: 90,
          total_bytes: 100,
        },
        {
          device: "nfs.example:/vllm-ci",
          fstype: "nfs4",
          role: "data",
          error: "stat timed out",
        },
      ],
    },
    reporter_status: "degraded",
    last_error: "one mount could not be read",
    node_conditions: {
      ready: true,
      disk_pressure: false,
      memory_pressure: false,
      pid_pressure: null,
      unschedulable: true,
    },
  });

  assert.equal(report.host?.cpu_count, 160);
  assert.equal(report.host?.disks?.[1].used_bytes, null);
  assert.equal(report.node_conditions?.unschedulable, true);
});

test("accepts an explicit degraded heartbeat without GPU rows", () => {
  const report = parseGpuReportPayload({
    hostname: "h200-ci-1",
    gpus: [],
    reporter_status: "degraded",
    last_error: "nvidia-smi timed out",
  });

  assert.equal(report.gpus.length, 0);
  assert.equal(report.reporter_status, "degraded");
});

test("rejects invalid ranges, partial RAM values, and unknown fields", () => {
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, gpus: [{ ...legacyPayload.gpus[0], gpu_util: 101 }] }),
    GpuReportValidationError,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, host: { ram_total_bytes: 1000 } }),
    /all RAM values together/,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, unexpected: true }),
    /unsupported field/,
  );
});

test("requires a useful error for degraded and failed metric payloads", () => {
  assert.throws(
    () =>
      parseGpuReportPayload({
        hostname: "h200-ci-1",
        gpus: [],
        reporter_status: "degraded",
      }),
    /last_error/,
  );
  assert.throws(
    () => parseGpuReportPayload({ hostname: "h200-ci-1", gpus: [] }),
    /at least one GPU/,
  );
});

test("GPU report authentication fails closed and compares bearer tokens", () => {
  assert.equal(gpuReportAuthResult(undefined, null), "not-configured");
  assert.equal(gpuReportAuthResult("secret", null), "unauthorized");
  assert.equal(gpuReportAuthResult("secret", "Bearer wrong"), "unauthorized");
  assert.equal(gpuReportAuthResult("secret", "Bearer secret"), "authorized");
});

test("request size configuration is bounded", () => {
  assert.equal(gpuReportMaxBytes(undefined), DEFAULT_GPU_REPORT_MAX_BYTES);
  assert.equal(gpuReportMaxBytes("1048576"), 1_048_576);
  assert.equal(gpuReportMaxBytes("0"), DEFAULT_GPU_REPORT_MAX_BYTES);
  assert.equal(gpuReportMaxBytes("999999999"), DEFAULT_GPU_REPORT_MAX_BYTES);
});
