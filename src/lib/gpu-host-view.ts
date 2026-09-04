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
 * plumbing) never drive the cell, and the container-plumbing ones are hidden
 * from the drill-down entirely — see isContainerPlumbingMount.
 */
export const ALERTABLE_DISK_ROLES: readonly DiskRole[] = [
  "workspace",
  "images",
  "data",
  "system",
];

/**
 * Mounts that are container or pod plumbing rather than real host storage:
 * overlay snapshots of the root filesystem, per-container shm mounts, kubelet
 * projected service-account volumes. They duplicate a real mount (an overlay
 * shows the same usage as the underlying disk) or can never fill up, and a
 * busy node accumulates dozens of them, so the drill-down filters them out.
 */
export function isContainerPlumbingMount(
  disk: Pick<NormalizedDiskMetric, "mount_point" | "device">,
): boolean {
  if (disk.device?.startsWith("overlay")) return true;
  const mount = disk.mount_point ?? "";
  return /^\/(run\/.+|var\/lib\/kubelet|sys\/fs\/cgroup)(\/|$)/.test(mount);
}

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

export type HostSortKey =
  | "host"
  | "gpuType"
  | "gpuUtil"
  | "gpuTemp"
  | "gpuMemory"
  | "cpu"
  | "ram"
  | "disk"
  | "lastSeen";

export type SortDirection = "asc" | "desc";

/** Sort keys whose useful first click is highest-first; the rest sort A→Z. */
export const DESCENDING_FIRST_SORT_KEYS: ReadonlySet<HostSortKey> = new Set([
  "gpuUtil",
  "gpuTemp",
  "gpuMemory",
  "cpu",
  "ram",
  "disk",
  "lastSeen",
]);

function hostSortValue(
  row: HostRow,
  host: HostLatest | undefined,
  key: HostSortKey,
): string | number | null {
  switch (key) {
    case "host":
      return row.hostname;
    case "gpuType":
      return row.gpuType;
    case "gpuUtil":
      return row.gpuCount > 0 ? row.gpuUtil / row.gpuCount : null;
    case "gpuTemp":
      return row.maxTemperatureC;
    case "gpuMemory":
      return row.memTotalMb > 0 ? (row.memUsedMb / row.memTotalMb) * 100 : null;
    case "cpu":
      return host?.cpu_util ?? null;
    case "ram":
      return host?.ram_used_bytes != null &&
        host.ram_total_bytes != null &&
        host.ram_total_bytes > 0
        ? (host.ram_used_bytes / host.ram_total_bytes) * 100
        : null;
    case "disk":
      return worstAlertableDisk(host?.disks ?? null)?.usedPct ?? null;
    case "lastSeen":
      return Date.parse(row.lastSeen);
  }
}

/**
 * Returns a new array of rows sorted by the given column. Rows with no value
 * for the column (unreported CPU/RAM/disk, no temperature) always sort last,
 * regardless of direction, so missing data never masquerades as "best".
 */
export function sortHostRows(
  rows: HostRow[],
  hostsByName: Map<string, HostLatest>,
  key: HostSortKey,
  direction: SortDirection,
): HostRow[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const aValue = hostSortValue(a, hostsByName.get(a.hostname), key);
    const bValue = hostSortValue(b, hostsByName.get(b.hostname), key);
    if (aValue == null && bValue == null) return 0;
    if (aValue == null) return 1;
    if (bValue == null) return -1;
    const compared =
      typeof aValue === "string" && typeof bValue === "string"
        ? aValue.localeCompare(bValue)
        : Number(aValue) - Number(bValue);
    if (compared !== 0) return compared * sign;
    return a.hostname.localeCompare(b.hostname);
  });
}
