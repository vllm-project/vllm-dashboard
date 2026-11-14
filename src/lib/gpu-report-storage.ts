import type postgres from "postgres";
import { getDb } from "@/lib/db";
import type { NormalizedGpuMetric, NormalizedGpuReport } from "@/lib/gpu-report";

function jsonValue(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

/**
 * One 5-minute rollup row per GPU model. GPUs that can't report utilization
 * still count toward memory, so utilization keeps its own sample count.
 */
export function buildGpuRollups(
  gpus: NormalizedGpuMetric[],
  hostname: string,
  bucket: Date,
) {
  const rollupsByName = new Map<
    string,
    { memPctSum: number; gpuUtilSum: number; gpuUtilCount: number; count: number }
  >();
  for (const gpu of gpus) {
    const name = gpu.name ?? "Unknown";
    const current = rollupsByName.get(name) ?? {
      memPctSum: 0,
      gpuUtilSum: 0,
      gpuUtilCount: 0,
      count: 0,
    };
    current.memPctSum +=
      gpu.mem_total_mb > 0 ? (gpu.mem_used_mb / gpu.mem_total_mb) * 100 : 0;
    if (gpu.gpu_util != null) {
      current.gpuUtilSum += gpu.gpu_util;
      current.gpuUtilCount += 1;
    }
    current.count += 1;
    rollupsByName.set(name, current);
  }
  return [...rollupsByName.entries()].map(([gpuName, values]) => ({
    time_bucket: bucket,
    hostname,
    gpu_name: gpuName,
    mem_pct_sum: values.memPctSum,
    gpu_util_sum: values.gpuUtilSum,
    gpu_util_count: values.gpuUtilCount,
    sample_count: values.count,
  }));
}

/** Stores the raw GPU/host observations and both rollups atomically. */
export async function storeGpuReport(
  report: NormalizedGpuReport,
  reportedAt = new Date(),
) {
  const db = getDb();
  const bucket = new Date(
    Math.floor(reportedAt.getTime() / 300_000) * 300_000,
  );
  const snapshots = report.gpus.map((gpu) => ({
    reported_at: reportedAt,
    hostname: report.hostname,
    gpu_index: gpu.index,
    gpu_name: gpu.name,
    gpu_util: gpu.gpu_util,
    mem_used_mb: gpu.mem_used_mb,
    mem_total_mb: gpu.mem_total_mb,
    temperature_c: gpu.temperature_c,
    power_draw_w: gpu.power_draw_w,
    power_limit_w: gpu.power_limit_w,
    dead_proc_mem_mb: gpu.dead_proc_mem_mb,
    recovery_action: gpu.recovery_action,
    remapped_rows_failure: gpu.remapped_rows_failure,
    ecc_uncorrected: gpu.ecc_uncorrected,
  }));
  const xidEvents = (report.xids ?? []).map((event) => ({
    hostname: report.hostname,
    bus_id: event.bus_id,
    xid: event.xid,
    at: event.at,
    message: event.message,
  }));

  const rollups = buildGpuRollups(report.gpus, report.hostname, bucket);

  const host = report.host;
  const hostSnapshot = {
    reported_at: reportedAt,
    hostname: report.hostname,
    cpu_util: host?.cpu_util ?? null,
    cpu_count: host?.cpu_count ?? null,
    ram_used_bytes: host?.ram_used_bytes ?? null,
    ram_total_bytes: host?.ram_total_bytes ?? null,
    ram_available_bytes: host?.ram_available_bytes ?? null,
    disks: host?.disks == null ? null : db.json(jsonValue(host.disks)),
    reporter_status: report.reporter_status,
    last_error: report.last_error,
    node_conditions:
      report.node_conditions == null
        ? null
        : db.json(jsonValue(report.node_conditions)),
    mig_slices: report.mig_slices,
    root_owned_slots:
      report.root_owned_slots == null
        ? null
        : db.json(jsonValue(report.root_owned_slots)),
    allocatable_gpus: report.allocatable_gpus,
    capacity_gpus: report.capacity_gpus,
    gpu_query_hung: report.gpu_query_hung,
    gpu_query_error: report.gpu_query_error,
    docker_ok: report.docker_ok,
    docker_error: report.docker_error,
    network_probes:
      report.network_probes == null
        ? null
        : db.json(jsonValue(report.network_probes)),
  };
  const cpuSampleCount = host?.cpu_util == null ? 0 : 1;
  const ramSampleCount = host?.ram_used_bytes == null ? 0 : 1;
  const hostRollup = {
    time_bucket: bucket,
    hostname: report.hostname,
    latest_reported_at: reportedAt,
    cpu_util_sum: host?.cpu_util ?? 0,
    cpu_util_max: host?.cpu_util ?? null,
    cpu_sample_count: cpuSampleCount,
    cpu_count: host?.cpu_count ?? null,
    ram_used_bytes_sum: host?.ram_used_bytes ?? 0,
    ram_total_bytes_sum: host?.ram_total_bytes ?? 0,
    ram_available_bytes_sum: host?.ram_available_bytes ?? 0,
    ram_sample_count: ramSampleCount,
    disks: hostSnapshot.disks,
    reporter_status: report.reporter_status,
    last_error: report.last_error,
    node_conditions: hostSnapshot.node_conditions,
    sample_count: 1,
  };

  await db.begin(async (transaction) => {
    // postgres.js' TransactionSql type omits call signatures even though the
    // runtime transaction object is the same callable tagged-template API.
    const tx = transaction as unknown as typeof db;
    if (snapshots.length > 0) {
      await tx`
        INSERT INTO gpu_snapshots ${tx(
          snapshots,
          "reported_at",
          "hostname",
          "gpu_index",
          "gpu_name",
          "gpu_util",
          "mem_used_mb",
          "mem_total_mb",
          "temperature_c",
          "power_draw_w",
          "power_limit_w",
          "dead_proc_mem_mb",
          "recovery_action",
          "remapped_rows_failure",
          "ecc_uncorrected",
        )}
      `;
    }
    if (xidEvents.length > 0) {
      await tx`
        INSERT INTO gpu_xid_events ${tx(
          xidEvents,
          "hostname",
          "bus_id",
          "xid",
          "at",
          "message",
        )}
        ON CONFLICT (hostname, bus_id, xid, at) DO NOTHING
      `;
    }
    if (rollups.length > 0) {
      await tx`
        INSERT INTO gpu_history_5m ${tx(
          rollups,
          "time_bucket",
          "hostname",
          "gpu_name",
          "mem_pct_sum",
          "gpu_util_sum",
          "gpu_util_count",
          "sample_count",
        )}
        ON CONFLICT (time_bucket, hostname, gpu_name) DO UPDATE SET
          mem_pct_sum = gpu_history_5m.mem_pct_sum + EXCLUDED.mem_pct_sum,
          gpu_util_sum = gpu_history_5m.gpu_util_sum + EXCLUDED.gpu_util_sum,
          gpu_util_count = COALESCE(gpu_history_5m.gpu_util_count, gpu_history_5m.sample_count)
            + EXCLUDED.gpu_util_count,
          sample_count = gpu_history_5m.sample_count + EXCLUDED.sample_count
      `;
    }
    await tx`
      INSERT INTO host_snapshots ${tx(
        hostSnapshot,
        "reported_at",
        "hostname",
        "cpu_util",
        "cpu_count",
        "ram_used_bytes",
        "ram_total_bytes",
        "ram_available_bytes",
        "disks",
        "reporter_status",
        "last_error",
        "node_conditions",
        "mig_slices",
        "root_owned_slots",
        "allocatable_gpus",
        "capacity_gpus",
        "gpu_query_hung",
        "gpu_query_error",
        "network_probes",
        "docker_ok",
        "docker_error",
      )}
    `;
    await tx`
      INSERT INTO host_history_5m ${tx(
        hostRollup,
        "time_bucket",
        "hostname",
        "latest_reported_at",
        "cpu_util_sum",
        "cpu_util_max",
        "cpu_sample_count",
        "cpu_count",
        "ram_used_bytes_sum",
        "ram_total_bytes_sum",
        "ram_available_bytes_sum",
        "ram_sample_count",
        "disks",
        "reporter_status",
        "last_error",
        "node_conditions",
        "sample_count",
      )}
      ON CONFLICT (time_bucket, hostname) DO UPDATE SET
        latest_reported_at = GREATEST(
          host_history_5m.latest_reported_at,
          EXCLUDED.latest_reported_at
        ),
        cpu_util_sum = host_history_5m.cpu_util_sum + EXCLUDED.cpu_util_sum,
        cpu_util_max = CASE
          WHEN EXCLUDED.cpu_util_max IS NULL THEN host_history_5m.cpu_util_max
          WHEN host_history_5m.cpu_util_max IS NULL THEN EXCLUDED.cpu_util_max
          ELSE GREATEST(host_history_5m.cpu_util_max, EXCLUDED.cpu_util_max)
        END,
        cpu_sample_count = host_history_5m.cpu_sample_count + EXCLUDED.cpu_sample_count,
        cpu_count = CASE
          WHEN EXCLUDED.latest_reported_at >= host_history_5m.latest_reported_at
            THEN EXCLUDED.cpu_count
          ELSE host_history_5m.cpu_count
        END,
        ram_used_bytes_sum = host_history_5m.ram_used_bytes_sum + EXCLUDED.ram_used_bytes_sum,
        ram_total_bytes_sum = host_history_5m.ram_total_bytes_sum + EXCLUDED.ram_total_bytes_sum,
        ram_available_bytes_sum = host_history_5m.ram_available_bytes_sum + EXCLUDED.ram_available_bytes_sum,
        ram_sample_count = host_history_5m.ram_sample_count + EXCLUDED.ram_sample_count,
        disks = CASE
          WHEN EXCLUDED.latest_reported_at >= host_history_5m.latest_reported_at
            THEN EXCLUDED.disks
          ELSE host_history_5m.disks
        END,
        reporter_status = CASE
          WHEN EXCLUDED.latest_reported_at >= host_history_5m.latest_reported_at
            THEN EXCLUDED.reporter_status
          ELSE host_history_5m.reporter_status
        END,
        last_error = CASE
          WHEN EXCLUDED.latest_reported_at >= host_history_5m.latest_reported_at
            THEN EXCLUDED.last_error
          ELSE host_history_5m.last_error
        END,
        node_conditions = CASE
          WHEN EXCLUDED.latest_reported_at >= host_history_5m.latest_reported_at
            THEN EXCLUDED.node_conditions
          ELSE host_history_5m.node_conditions
        END,
        sample_count = host_history_5m.sample_count + EXCLUDED.sample_count
    `;
  });

  return { reportedAt };
}
