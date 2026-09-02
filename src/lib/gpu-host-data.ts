import { getDb } from "@/lib/db";
import type { HostLatest } from "@/lib/gpu-types";
import type {
  NormalizedDiskMetric,
  NormalizedNodeConditions,
} from "@/lib/gpu-report";

// Same lookback as queryGpuLatest: a host stays on the dashboard as long as
// any report of it exists within the retention window.
const LATEST_LOOKBACK_HOURS = 720;

type DbRow = Record<string, unknown>;

function isoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  // postgres.js may surface bigint columns (ram_*_bytes) as strings or
  // BigInt depending on the driver options; Number() handles both.
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNodeConditions(value: unknown): value is NormalizedNodeConditions {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as NormalizedNodeConditions).unschedulable === "boolean"
  );
}

/**
 * Coerces one host_snapshots row into the API shape. The table's CHECK
 * constraints and the ingestion-time validation in gpu-report.ts guarantee
 * the structural shape; this layer only normalizes driver representations
 * (bigint strings, parsed jsonb).
 */
export function normalizeHostRow(row: DbRow): HostLatest {
  return {
    hostname: String(row.hostname),
    cpu_util: nullableNumber(row.cpu_util),
    cpu_count: nullableNumber(row.cpu_count),
    ram_used_bytes: nullableNumber(row.ram_used_bytes),
    ram_total_bytes: nullableNumber(row.ram_total_bytes),
    ram_available_bytes: nullableNumber(row.ram_available_bytes),
    disks: Array.isArray(row.disks)
      ? (row.disks as NormalizedDiskMetric[])
      : null,
    reporter_status: row.reporter_status === "degraded" ? "degraded" : "ok",
    last_error: row.last_error == null ? null : String(row.last_error),
    node_conditions: isNodeConditions(row.node_conditions)
      ? row.node_conditions
      : null,
    reported_at: isoString(row.reported_at),
  };
}

/**
 * Latest host_snapshots row per hostname. Same skip-scan shape as
 * queryGpuLatest: walk the distinct keys via the (hostname, reported_at)
 * index, then a lateral latest-row lookup per host.
 */
export async function queryHostLatest(): Promise<HostLatest[]> {
  const db = getDb();
  const rows = await db`
    WITH RECURSIVE host_keys(hostname) AS (
      (
        SELECT hostname
        FROM host_snapshots
        WHERE reported_at > NOW() - INTERVAL '1 hour' * ${LATEST_LOOKBACK_HOURS}
        ORDER BY hostname
        LIMIT 1
      )
      UNION ALL
      SELECT next_key.hostname
      FROM host_keys current_key
      CROSS JOIN LATERAL (
        SELECT hostname
        FROM host_snapshots
        WHERE hostname > current_key.hostname
          AND reported_at > NOW() - INTERVAL '1 hour' * ${LATEST_LOOKBACK_HOURS}
        ORDER BY hostname
        LIMIT 1
      ) next_key
    )
    SELECT l.hostname, l.cpu_util, l.cpu_count,
           l.ram_used_bytes, l.ram_total_bytes, l.ram_available_bytes,
           l.disks, l.reporter_status, l.last_error, l.node_conditions,
           l.reported_at
    FROM host_keys k
    CROSS JOIN LATERAL (
      SELECT hostname, cpu_util, cpu_count,
             ram_used_bytes, ram_total_bytes, ram_available_bytes,
             disks, reporter_status, last_error, node_conditions, reported_at
      FROM host_snapshots s
      WHERE s.hostname = k.hostname
      ORDER BY s.reported_at DESC
      LIMIT 1
    ) l
    ORDER BY l.hostname
  `;

  return (rows as unknown as DbRow[]).map(normalizeHostRow);
}
