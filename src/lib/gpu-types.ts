export interface GpuSnapshot {
  time_bucket: string;
  hostname: string;
  gpu_name: string | null;
  mem_pct_sum: number;
  sample_count: number;
}

export interface GpuLatest {
  hostname: string;
  gpu_index: number;
  gpu_name: string | null;
  mem_used_mb: number;
  mem_total_mb: number;
  reported_at: string;
}

export interface GpuHistoryResponse {
  hours: number;
  snapshots: GpuSnapshot[];
  error?: string;
}

export interface GpuLatestResponse {
  latest: GpuLatest[];
  error?: string;
}
