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
  checked_at: string;
  error?: string;
}
