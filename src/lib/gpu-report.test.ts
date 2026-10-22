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

test("accepts null utilization from GPUs that can't report it", () => {
  const report = parseGpuReportPayload({
    ...legacyPayload,
    gpus: [{ ...legacyPayload.gpus[0], gpu_util: null }],
  });
  assert.equal(report.gpus[0].gpu_util, null);
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, gpus: [{ ...legacyPayload.gpus[0], gpu_util: -1 }] }),
    /gpus\[0\]\.gpu_util/,
  );
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

test("accepts dead_proc_mem_mb as a number, null, or omitted", () => {
  const withNumber = parseGpuReportPayload({
    ...legacyPayload,
    gpus: [{ ...legacyPayload.gpus[0], dead_proc_mem_mb: 4096.5 }],
  });
  assert.equal(withNumber.gpus[0].dead_proc_mem_mb, 4096.5);

  const withNull = parseGpuReportPayload({
    ...legacyPayload,
    gpus: [{ ...legacyPayload.gpus[0], dead_proc_mem_mb: null }],
  });
  assert.equal(withNull.gpus[0].dead_proc_mem_mb, null);

  const omitted = parseGpuReportPayload(legacyPayload);
  assert.equal(omitted.gpus[0].dead_proc_mem_mb, null);
});

test("rejects out-of-range or non-numeric dead_proc_mem_mb", () => {
  assert.throws(
    () =>
      parseGpuReportPayload({
        ...legacyPayload,
        gpus: [{ ...legacyPayload.gpus[0], dead_proc_mem_mb: -1 }],
      }),
    /dead_proc_mem_mb/,
  );
  assert.throws(
    () =>
      parseGpuReportPayload({
        ...legacyPayload,
        gpus: [{ ...legacyPayload.gpus[0], dead_proc_mem_mb: "4096" }],
      }),
    /dead_proc_mem_mb/,
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

const faultGpu = {
  ...legacyPayload.gpus[0],
  recovery_action: "None",
  remapped_rows_failure: null,
  ecc_uncorrected: 0,
};
const xid = {
  bus_id: "0000:7f:00",
  xid: 48,
  at: "2026-10-11T00:00:00.123456+00:00",
  message: "",
};

test("legacy reporters that omit the fault fields normalize them to null", () => {
  const report = parseGpuReportPayload(legacyPayload);
  assert.equal(report.gpus[0].recovery_action, null);
  assert.equal(report.gpus[0].remapped_rows_failure, null);
  assert.equal(report.gpus[0].ecc_uncorrected, null);
  assert.equal(report.xids, null);
  assert.equal(report.mig_slices, null);
  assert.equal(report.root_owned_slots, null);
  assert.equal(report.allocatable_gpus, null);
  assert.equal(report.capacity_gpus, null);
});

test("accepts the per-GPU and per-host fault fields", () => {
  const report = parseGpuReportPayload({
    ...legacyPayload,
    gpus: [faultGpu, { ...faultGpu, index: 1, remapped_rows_failure: true, ecc_uncorrected: 3 }],
    xids: [xid],
    mig_slices: 56,
    root_owned_slots: ["/mnt/local/buildkite-agent/builds/h200-ci-2-1/vllm/ci"],
    allocatable_gpus: 7,
    capacity_gpus: 8,
  });
  assert.equal(report.gpus[0].recovery_action, "None");
  assert.equal(report.gpus[0].remapped_rows_failure, null);
  assert.equal(report.gpus[1].remapped_rows_failure, true);
  assert.equal(report.gpus[1].ecc_uncorrected, 3);
  assert.equal(report.xids?.[0].at.toISOString(), "2026-10-11T00:00:00.123Z");
  assert.equal(report.xids?.[0].message, "");
  assert.equal(report.mig_slices, 56);
  assert.deepEqual(report.root_owned_slots, [
    "/mnt/local/buildkite-agent/builds/h200-ci-2-1/vllm/ci",
  ]);
  assert.equal(report.allocatable_gpus, 7);
  assert.equal(report.capacity_gpus, 8);
});

test("an empty xids list is a reading, distinct from a missing one", () => {
  const read = parseGpuReportPayload({ ...legacyPayload, xids: [], root_owned_slots: [] });
  assert.deepEqual(read.xids, []);
  assert.deepEqual(read.root_owned_slots, []);
  const missing = parseGpuReportPayload({ ...legacyPayload, xids: null, mig_slices: null });
  assert.equal(missing.xids, null);
  assert.equal(missing.mig_slices, null);
});

test("accepts an empty bus_id for Xids that cannot be tied to a GPU", () => {
  const report = parseGpuReportPayload({ ...legacyPayload, xids: [{ ...xid, bus_id: "" }] });
  assert.equal(report.xids?.[0].bus_id, "");
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, xids: [{ ...xid, bus_id: null }] }),
    /xids\[0\]\.bus_id/,
  );
});

test("rejects malformed fault fields", () => {
  const withGpu = (patch: object) => ({
    ...legacyPayload,
    gpus: [{ ...legacyPayload.gpus[0], ...patch }],
  });
  assert.throws(
    () => parseGpuReportPayload(withGpu({ remapped_rows_failure: "No" })),
    /remapped_rows_failure/,
  );
  assert.throws(
    () => parseGpuReportPayload(withGpu({ ecc_uncorrected: -1 })),
    /ecc_uncorrected/,
  );
  assert.throws(
    () => parseGpuReportPayload(withGpu({ recovery_action: 0 })),
    /recovery_action/,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, xids: [{ ...xid, at: "yesterday" }] }),
    /xids\[0\]\.at/,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, xids: [{ ...xid, xid: "48" }] }),
    /xids\[0\]\.xid/,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, xids: [{ ...xid, extra: 1 }] }),
    /unsupported field 'extra'/,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, xids: Array(501).fill(xid) }),
    /xids must be an array/,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, mig_slices: -1 }),
    /mig_slices/,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, root_owned_slots: "/x" }),
    /root_owned_slots/,
  );
});

const probe = { target: "registry", ok: false, error: "timeout", latency_ms: null };

test("accepts the GPU-hang flag and network probe results", () => {
  const report = parseGpuReportPayload({
    ...legacyPayload,
    gpus: [],
    reporter_status: "degraded",
    last_error: "nvidia-smi timed out",
    gpu_query_hung: true,
    gpu_query_error: "Command 'nvidia-smi' timed out after 30 seconds",
    network_probes: [{ target: "github", ok: true, error: null, latency_ms: 142 }, probe],
  });
  assert.equal(report.gpu_query_hung, true);
  assert.match(report.gpu_query_error ?? "", /timed out/);
  assert.deepEqual(report.network_probes?.[1], probe);
  const legacy = parseGpuReportPayload(legacyPayload);
  assert.equal(legacy.gpu_query_hung, null);
  assert.equal(legacy.network_probes, null);
});

test("rejects malformed GPU-hang and network probe fields", () => {
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, gpu_query_hung: "yes" }),
    /gpu_query_hung/,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, network_probes: [{ ...probe, ok: null }] }),
    /network_probes\[0\]\.ok/,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, network_probes: [{ ...probe, url: "x" }] }),
    /unsupported field 'url'/,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, network_probes: Array(9).fill(probe) }),
    /network_probes must be an array/,
  );
});

test("accepts the Docker health fields, and leaves them null when absent", () => {
  const report = parseGpuReportPayload({
    ...legacyPayload,
    docker_ok: false,
    docker_error: "the docker0 bridge is missing",
  });
  assert.equal(report.docker_ok, false);
  assert.equal(report.docker_error, "the docker0 bridge is missing");
  const legacy = parseGpuReportPayload(legacyPayload);
  assert.equal(legacy.docker_ok, null);
  assert.equal(legacy.docker_error, null);
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, docker_ok: "no" }),
    /docker_ok/,
  );
  assert.throws(
    () => parseGpuReportPayload({ ...legacyPayload, docker_error: "x".repeat(5000) }),
    /docker_error/,
  );
});
