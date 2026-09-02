import type { GpuLatest, HostLatest } from "./gpu-types";
import type { DiskRole, NormalizedDiskMetric } from "./gpu-report";

/** A host is dimmed as Stale once its newest report is this old. */
export const HOST_STALE_MINUTES = 5;
/** A host is badged Unreporting once its newest report is this old. */
export const HOST_UNREPORTING_MINUTES = 10;

export type HostReportStatus = "fresh" | "stale" | "unreporting";

/**
 * Freshness of a host's newest report. "Unreporting" says only that no report
 * arrived, never that the machine is down: a stopped timer, a broken
 * nvidia-smi, a bad secret or an ingestion failure look identical from here.
 */
export function hostReportStatus(minutesAgo: number): HostReportStatus {
  if (minutesAgo > HOST_UNREPORTING_MINUTES) return "unreporting";
  if (minutesAgo > HOST_STALE_MINUTES) return "stale";
  return "fresh";
}

export interface HostGpuRow {
  index: number;
  gpuUtil: number;
  memUsedMb: number;
  memTotalMb: number;
  temperatureC: number | null;
  powerDrawW: number | null;
  powerLimitW: number | null;
}

export interface HostRow {
  hostname: string;
  gpuType: string;
  gpuCount: number;
  gpuUtil: number;
  memUsedMb: number;
  memTotalMb: number;
  /** Hottest GPU on the host, or null when no GPU reported a temperature. */
  maxTemperatureC: number | null;
  /** Host totals, summed over the GPUs that reported them. */
  powerDrawW: number | null;
  powerLimitW: number | null;
  lastSeen: string;
  gpus: HostGpuRow[];
}

function addNullable(total: number | null, value: number | null): number | null {
  if (value == null) return total;
  return (total ?? 0) + value;
}

function maxNullable(current: number | null, value: number | null): number | null {
  if (value == null) return current;
  return current == null ? value : Math.max(current, value);
}

/** Collapses per-GPU rows into one row per host, sorted by hostname. */
export function buildHostRows(
  latest: GpuLatest[],
  gpuType: (name: string | null) => string,
): HostRow[] {
  const map = new Map<string, HostRow>();
  for (const g of latest) {
    const gpu: HostGpuRow = {
      index: g.gpu_index,
      gpuUtil: g.gpu_util,
      memUsedMb: g.mem_used_mb,
      memTotalMb: g.mem_total_mb,
      temperatureC: g.temperature_c,
      powerDrawW: g.power_draw_w,
      powerLimitW: g.power_limit_w,
    };
    const existing = map.get(g.hostname);
    if (!existing) {
      map.set(g.hostname, {
        hostname: g.hostname,
        gpuType: gpuType(g.gpu_name),
        gpuCount: 1,
        gpuUtil: g.gpu_util,
        memUsedMb: g.mem_used_mb,
        memTotalMb: g.mem_total_mb,
        maxTemperatureC: g.temperature_c,
        powerDrawW: g.power_draw_w,
        powerLimitW: g.power_limit_w,
        lastSeen: g.reported_at,
        gpus: [gpu],
      });
      continue;
    }
    existing.gpuCount++;
    existing.gpuUtil += g.gpu_util;
    existing.memUsedMb += g.mem_used_mb;
    existing.memTotalMb += g.mem_total_mb;
    existing.maxTemperatureC = maxNullable(existing.maxTemperatureC, g.temperature_c);
    existing.powerDrawW = addNullable(existing.powerDrawW, g.power_draw_w);
    existing.powerLimitW = addNullable(existing.powerLimitW, g.power_limit_w);
    existing.gpus.push(gpu);
    if (g.reported_at > existing.lastSeen) existing.lastSeen = g.reported_at;
  }
  for (const row of map.values()) {
    row.gpus.sort((a, b) => a.index - b.index);
  }
  return [...map.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
}

/**
 * Disk roles that can fill up a job and therefore drive alerting and the
 * summary Disk cell. "other" mounts (cgroup, tmpfs snapshots, container
 * plumbing) are shown in the drill-down but never drive the cell.
 */
export const ALERTABLE_DISK_ROLES: readonly DiskRole[] = [
  "workspace",
  "images",
  "data",
  "system",
];

/** RAM-backed filesystems consume memory, not disk; the UI labels them. */
export function isRamBackedMount(disk: Pick<NormalizedDiskMetric, "fstype">): boolean {
  return disk.fstype === "tmpfs" || disk.fstype === "ramfs";
}

/** Percentage used, or null when the mount reported no usage (error mounts). */
export function diskUsedPct(
  disk: Pick<NormalizedDiskMetric, "used_bytes" | "total_bytes">,
): number | null {
  if (disk.used_bytes == null || disk.total_bytes == null) return null;
  if (disk.total_bytes <= 0) return null;
  return (disk.used_bytes / disk.total_bytes) * 100;
}

export interface WorstDisk {
  disk: NormalizedDiskMetric;
  usedPct: number;
}

/**
 * The alertable mount with the highest usage, or null when no alertable
 * mount reported usage. Mounts with a per-mount error (no usage values) and
 * "other" mounts are skipped.
 */
export function worstAlertableDisk(
  disks: NormalizedDiskMetric[] | null,
): WorstDisk | null {
  if (!disks) return null;
  let worst: WorstDisk | null = null;
  for (const disk of disks) {
    if (!ALERTABLE_DISK_ROLES.includes(disk.role)) continue;
    const usedPct = diskUsedPct(disk);
    if (usedPct == null) continue;
    if (!worst || usedPct > worst.usedPct) worst = { disk, usedPct };
  }
  return worst;
}

/**
 * One HostLatest per hostname, keeping the newest row when duplicates slip
 * in. queryHostLatest already returns one row per host; this keeps the
 * client-side join safe regardless.
 */
export function indexHostsByName(hosts: HostLatest[]): Map<string, HostLatest> {
  const map = new Map<string, HostLatest>();
  for (const host of hosts) {
    const existing = map.get(host.hostname);
    if (!existing || host.reported_at > existing.reported_at) {
      map.set(host.hostname, host);
    }
  }
  return map;
}
