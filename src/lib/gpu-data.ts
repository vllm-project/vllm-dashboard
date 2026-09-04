import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { joinGpuHostsToAgents } from "@/lib/buildkite-agent-query";
import { queryHostLatest } from "@/lib/gpu-host-data";
import type {
  GpuHistoryResponse,
  GpuHostAgent,
  GpuLatest,
  GpuLatestResponse,
  GpuOverviewPoint,
  GpuSnapshot,
} from "@/lib/gpu-types";

const LATEST_LOOKBACK_HOURS = 720;

type DbValue = string | number | Date | null;
type DbRow = Record<string, DbValue>;

function isoString(value: DbValue): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function parseGpuHours(value: string | null): number {
  return Math.min(Math.max(parseInt(value ?? "24", 10) || 24, 1), 720);
}

export function gpuBucketMinutes(hours: number): number {
  if (hours <= 1) return 1;
  if (hours <= 6) return 2;
  if (hours <= 24) return 5;
  if (hours <= 168) return 30;
  if (hours <= 336) return 60;
  return 120;
}

function normalizeSnapshots(rows: DbRow[]): GpuSnapshot[] {
  return rows.map((row) => ({
    time_bucket: isoString(row.time_bucket),
    hostname: String(row.hostname),
    gpu_name: row.gpu_name == null ? null : String(row.gpu_name),
    mem_pct_sum: Number(row.mem_pct_sum),
    gpu_util_sum: Number(row.gpu_util_sum),
    sample_count: Number(row.sample_count),
  }));
}

function nullableNumber(value: DbValue): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLatest(rows: DbRow[]): GpuLatest[] {
  return rows.map((row) => ({
    hostname: String(row.hostname),
    gpu_index: Number(row.gpu_index),
    gpu_name: row.gpu_name == null ? null : String(row.gpu_name),
    gpu_util: Number(row.gpu_util),
    mem_used_mb: Number(row.mem_used_mb),
    mem_total_mb: Number(row.mem_total_mb),
    temperature_c: nullableNumber(row.temperature_c),
    power_draw_w: nullableNumber(row.power_draw_w),
    power_limit_w: nullableNumber(row.power_limit_w),
    reported_at: isoString(row.reported_at),
  }));
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarizeGpuHistory(
  history: GpuHistoryResponse,
): GpuOverviewPoint[] {
  const buckets = new Map<
    number,
    Map<string, { memPctSum: number; gpuUtilSum: number; sampleCount: number }>
  >();

  for (const snapshot of history.snapshots) {
    const time = new Date(snapshot.time_bucket).getTime();
    const hosts = buckets.get(time) ?? new Map();
    const host = hosts.get(snapshot.hostname) ?? {
      memPctSum: 0,
      gpuUtilSum: 0,
      sampleCount: 0,
    };
    host.memPctSum += snapshot.mem_pct_sum;
    host.gpuUtilSum += snapshot.gpu_util_sum;
    host.sampleCount += snapshot.sample_count;
    hosts.set(snapshot.hostname, host);
    buckets.set(time, hosts);
  }

  return [...buckets.entries()]
    .map(([time, hosts]) => {
      const activeHosts = [...hosts.values()].filter(
        (host) => host.sampleCount > 0,
      );
      const memoryValues = activeHosts.map(
        (host) => host.memPctSum / host.sampleCount,
      );
      const gpuValues = activeHosts.map(
        (host) => host.gpuUtilSum / host.sampleCount,
      );
      return {
        time,
        memoryP50: Math.round(percentile(memoryValues, 0.5)),
        memoryP90: Math.round(percentile(memoryValues, 0.9)),
        memoryPeak: Math.round(Math.max(...memoryValues, 0)),
        gpuP50: Math.round(percentile(gpuValues, 0.5)),
        gpuP90: Math.round(percentile(gpuValues, 0.9)),
        gpuPeak: Math.round(Math.max(...gpuValues, 0)),
      };
    })
    .sort((a, b) => a.time - b.time);
}

export async function queryGpuHistory(
  requestedHours: number,
  hostname = "",
): Promise<GpuHistoryResponse> {
  const hours = Math.min(Math.max(requestedHours || 24, 1), 720);
  const bucketMinutes = gpuBucketMinutes(hours);
  const db = getDb();
  const hostFilter = hostname ? db`AND hostname = ${hostname}` : db``;

  // Preserve the fine 1m/2m resolution for short interactive windows. All
  // longer ranges use the incremental 5-minute rollup populated at ingestion.
  const rows = hours <= 6
    ? await db`
        SELECT
          date_bin(
            INTERVAL '1 minute' * ${bucketMinutes},
            reported_at,
            TIMESTAMPTZ 'epoch'
          ) AS time_bucket,
          hostname,
          gpu_name,
          ROUND(SUM(CASE
            WHEN mem_total_mb > 0 THEN mem_used_mb / mem_total_mb * 100
            ELSE 0
          END)::numeric, 2) AS mem_pct_sum,
          ROUND(SUM(gpu_util)::numeric, 2) AS gpu_util_sum,
          COUNT(*)::bigint AS sample_count
        FROM gpu_snapshots
        WHERE reported_at > NOW() - INTERVAL '1 hour' * ${hours}
          ${hostFilter}
        GROUP BY time_bucket, hostname, gpu_name
        ORDER BY time_bucket ASC, hostname ASC, gpu_name ASC
      `
    : await db`
        SELECT
          date_bin(
            INTERVAL '1 minute' * ${bucketMinutes},
            time_bucket,
            TIMESTAMPTZ 'epoch'
          ) AS time_bucket,
          hostname,
          NULLIF(gpu_name, 'Unknown') AS gpu_name,
          ROUND(SUM(mem_pct_sum)::numeric, 2) AS mem_pct_sum,
          ROUND(SUM(gpu_util_sum)::numeric, 2) AS gpu_util_sum,
          SUM(sample_count)::bigint AS sample_count
        FROM gpu_history_5m
        WHERE time_bucket > NOW() - INTERVAL '1 hour' * ${hours}
          ${hostFilter}
        GROUP BY 1, hostname, NULLIF(gpu_name, 'Unknown')
        ORDER BY 1 ASC, hostname ASC, gpu_name ASC
      `;

  return {
    hours,
    snapshots: normalizeSnapshots(rows as unknown as DbRow[]),
  };
}

export async function queryGpuLatest(): Promise<GpuLatest[]> {
  const db = getDb();
  const rows = await db`
    WITH RECURSIVE gpu_keys(hostname, gpu_index) AS (
      (
        SELECT hostname, gpu_index
        FROM gpu_snapshots
        WHERE reported_at > NOW() - INTERVAL '1 hour' * ${LATEST_LOOKBACK_HOURS}
        ORDER BY hostname, gpu_index
        LIMIT 1
      )
      UNION ALL
      SELECT next_key.hostname, next_key.gpu_index
      FROM gpu_keys current_key
      CROSS JOIN LATERAL (
        SELECT hostname, gpu_index
        FROM gpu_snapshots
        WHERE (hostname, gpu_index) > (current_key.hostname, current_key.gpu_index)
          AND reported_at > NOW() - INTERVAL '1 hour' * ${LATEST_LOOKBACK_HOURS}
        ORDER BY hostname, gpu_index
        LIMIT 1
      ) next_key
    )
    SELECT l.hostname, l.gpu_index, l.gpu_name, l.gpu_util,
           l.mem_used_mb, l.mem_total_mb,
           l.temperature_c, l.power_draw_w, l.power_limit_w,
           l.reported_at
    FROM gpu_keys k
    CROSS JOIN LATERAL (
      SELECT hostname, gpu_index, gpu_name, gpu_util, mem_used_mb, mem_total_mb,
             temperature_c, power_draw_w, power_limit_w, reported_at
      FROM gpu_snapshots s
      WHERE s.hostname = k.hostname AND s.gpu_index = k.gpu_index
      ORDER BY s.reported_at DESC
      LIMIT 1
    ) l
    ORDER BY l.hostname, l.gpu_index
  `;

  return normalizeLatest(rows as unknown as DbRow[]);
}

// Joins each GPU host to the connected Buildkite agent running on it, matched
// by normalized hostname (see normalizeHostname). Hosts with no matching
// agent — reporters without an agent, or agents whose Buildkite hostname does
// not line up with the reported GPU hostname — come back with null agent
// fields so the mismatch is visible instead of silently dropped.
export async function queryGpuHostAgents(): Promise<GpuHostAgent[]> {
  const db = getDb();
  const [hostRows, agentRows] = await Promise.all([
    db`
      SELECT DISTINCT hostname
      FROM gpu_snapshots
      WHERE reported_at > NOW() - INTERVAL '1 hour' * ${LATEST_LOOKBACK_HOURS}
      ORDER BY hostname
    `,
    db`
      SELECT DISTINCT ON (agent_name)
        agent_name, hostname, queues,
        job_id, job_label, build_number, job_url, polled_at
      FROM buildkite_agent_snapshots
      WHERE polled_at > NOW() - INTERVAL '1 hour'
      ORDER BY agent_name, polled_at DESC
    `,
  ]);

  const agents = (agentRows as unknown as DbRow[]).map((row) => ({
    agentName: String(row.agent_name),
    hostname: row.hostname == null ? null : String(row.hostname),
    queues: Array.isArray(row.queues) ? (row.queues as unknown[]).map(String) : [],
    job:
      row.job_id == null
        ? null
        : {
            id: String(row.job_id),
            label: row.job_label == null ? null : String(row.job_label),
            buildNumber: row.build_number == null ? null : Number(row.build_number),
            url: row.job_url == null ? null : String(row.job_url),
          },
  }));
  const polledAtByAgent = new Map(
    (agentRows as unknown as DbRow[]).map((row) => [
      String(row.agent_name),
      isoString(row.polled_at),
    ]),
  );

  const hostnames = (hostRows as unknown as DbRow[]).map((row) =>
    String(row.hostname),
  );
  const joined = joinGpuHostsToAgents(hostnames, agents);

  return hostnames.map((hostname) => {
    const agent = joined.get(hostname) ?? null;
    return {
      hostname,
      agentName: agent?.agentName ?? null,
      queues: agent?.queues ?? [],
      currentJob: agent?.job ?? null,
      polledAt: agent ? (polledAtByAgent.get(agent.agentName) ?? null) : null,
    };
  });
}

const getCachedInitialHistory = unstable_cache(
  () => queryGpuHistory(24),
  ["gpu-initial-history-v2"],
  { revalidate: 60, tags: ["gpu-history"] },
);

const getCachedInitialLatest = unstable_cache(
  async (): Promise<GpuLatestResponse> => {
    const [latest, hosts] = await Promise.all([
      queryGpuLatest(),
      queryHostLatest(),
    ]);
    return { latest, hosts, checked_at: new Date().toISOString() };
  },
  ["gpu-initial-latest-v4"],
  { revalidate: 30, tags: ["gpu-latest"] },
);

export async function getInitialGpuData() {
  const [history, latestResponse] = await Promise.all([
    getCachedInitialHistory(),
    getCachedInitialLatest(),
  ]);
  return {
    overview: summarizeGpuHistory(history),
    latest: latestResponse.latest,
    hosts: latestResponse.hosts,
    latestCheckedAt: latestResponse.checked_at,
    asOf: Date.now(),
  };
}
