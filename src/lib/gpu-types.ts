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
  sample_count: number;
}

export interface GpuLatest {
  hostname: string;
  gpu_index: number;
  gpu_name: string | null;
  gpu_util: number;
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

export interface GpuOverviewPoint {
  time: number;
  memoryP50: number;
  memoryP90: number;
  memoryPeak: number;
  gpuP50: number;
  gpuP90: number;
  gpuPeak: number;
}

export interface GpuLatestResponse {
  latest: GpuLatest[];
  hosts: HostLatest[];
  checked_at: string;
  error?: string;
}
