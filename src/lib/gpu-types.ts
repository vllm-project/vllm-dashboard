import type {
  NormalizedDiskMetric,
  NormalizedNodeConditions,
  ReporterStatus,
} from "./gpu-report";

export interface GpuSnapshot {
  time_bucket: string;
  hostname: string;
  gpu_name: string | null;
  mem_pct_sum: number;
  gpu_util_sum: number;
  /** Samples that carried a utilization; sample_count also counts MIG GPUs. */
  gpu_util_count: number;
  sample_count: number;
}

export interface GpuLatest {
  hostname: string;
  gpu_index: number;
  gpu_name: string | null;
  gpu_util: number | null;
  mem_used_mb: number;
  mem_total_mb: number;
  temperature_c: number | null;
  power_draw_w: number | null;
  power_limit_w: number | null;
  reported_at: string;
}

/** Latest host-level report for one hostname, as stored in host_snapshots. */
export interface HostLatest {
  hostname: string;
  cpu_util: number | null;
  cpu_count: number | null;
  ram_used_bytes: number | null;
  ram_total_bytes: number | null;
  ram_available_bytes: number | null;
  disks: NormalizedDiskMetric[] | null;
  reporter_status: ReporterStatus;
  last_error: string | null;
  node_conditions: NormalizedNodeConditions | null;
  reported_at: string;
}

export interface GpuHistoryResponse {
  hours: number;
  snapshots: GpuSnapshot[];
  error?: string;
}

export interface GpuAgentJob {
  id: string;
  label: string | null;
  buildNumber: number | null;
  url: string | null;
}

export interface GpuHostAgent {
  hostname: string;
  agentName: string | null;
  queues: string[];
  currentJob: GpuAgentJob | null;
  polledAt: string | null;
}

export interface GpuHostAgentsResponse {
  hosts: GpuHostAgent[];
  checked_at: string;
  error?: string;
}

export interface GpuOverviewPoint {
  time: number;
  memoryP50: number;
  memoryP90: number;
  memoryPeak: number;
  /** Null when no GPU in the bucket reported utilization (all MIG). */
  gpuP50: number | null;
  gpuP90: number | null;
  gpuPeak: number | null;
}

export interface GpuLatestResponse {
  latest: GpuLatest[];
  hosts: HostLatest[];
  checked_at: string;
  error?: string;
}
