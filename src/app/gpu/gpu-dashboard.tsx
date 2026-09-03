"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { SearchableSelect } from "@/components/searchable-select";
import type { GpuChartMode } from "@/components/gpu-util-chart";
import type {
  GpuHistoryResponse,
  GpuLatest,
  GpuLatestResponse,
  GpuOverviewPoint,
} from "@/lib/gpu-types";

const GpuMemChart = dynamic(
  () => import("@/components/gpu-util-chart").then((module) => module.GpuMemChart),
  {
    ssr: false,
    loading: () => <div className="h-[360px] animate-pulse rounded bg-zinc-100 dark:bg-zinc-900 sm:h-[420px]" />,
  },
);

async function fetcher<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(body.error ?? `Request failed with ${response.status}`);
  }
  return body as T;
}

const HOURS_OPTIONS = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "14d", value: 336 },
  { label: "30d", value: 720 },
];

const OVERVIEW_SERIES = [
  "Typical (P50)",
  "High (P90)",
  "Peak",
] as const;
const EMPTY_SNAPSHOTS: GpuHistoryResponse["snapshots"] = [];
type GpuMetric = "memory" | "utilization";

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function formatCapacityGb(gb: number): string {
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${Math.round(gb)} GB`;
}

function formatAgo(minutes: number): string {
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function formatCheckedAgo(checkedAt: string, now: number): string {
  if (!checkedAt || now <= 0) return "recently";
  const checkedTime = new Date(checkedAt).getTime();
  if (!Number.isFinite(checkedTime)) return "recently";
  const seconds = Math.max(
    0,
    Math.round((now - checkedTime) / 1000),
  );
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return formatAgo(Math.round(seconds / 60));
}

function gpuType(name: string | null): string {
  if (!name) return "Unknown";
  const match = name.match(/\b(A100|H100|H200|B200|B100|L40S?|A10G?|T4|V100|GB200|GB300)\b/i);
  return match ? match[1].toUpperCase() : name;
}

interface GpuDashboardProps {
  initialOverview: GpuOverviewPoint[];
  initialLatest: GpuLatest[];
  initialLatestCheckedAt: string;
  initialNow: number;
}

export function GpuDashboard({
  initialOverview,
  initialLatest,
  initialLatestCheckedAt,
  initialNow,
}: GpuDashboardProps) {
  const [gpuTypeFilter, setGpuTypeFilter] = useState("");
  const [hostFilter, setHostFilter] = useState("");
  const [hours, setHours] = useState(24);
  const [metric, setMetric] = useState<GpuMetric>("memory");
  const [chartMode, setChartMode] = useState<GpuChartMode>("overview");
  const [now, setNow] = useState(initialNow);

  useEffect(() => {
    const immediate = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.clearTimeout(immediate);
      window.clearInterval(timer);
    };
  }, []);

  const {
    data: latestData,
    error: latestError,
    isValidating: latestIsValidating,
    mutate: refreshLatest,
  } = useSWR<GpuLatestResponse>("/api/gpu/latest", fetcher, {
    fallbackData: {
      latest: initialLatest,
      checked_at: initialLatestCheckedAt,
    },
    // Server-rendered data makes the page useful immediately; this request is
    // the explicit freshness check users see in the status line.
    revalidateOnMount: true,
    refreshInterval: 30_000,
  });

  const needsRawHistory =
    hours !== 24 ||
    Boolean(hostFilter) ||
    Boolean(gpuTypeFilter) ||
    chartMode !== "overview";
  const historyUrl = needsRawHistory
    ? `/api/gpu/history?hours=${hours}${
        hostFilter ? `&hostname=${encodeURIComponent(hostFilter)}` : ""
      }`
    : null;
  const {
    data: historyData,
    error: historyError,
    isLoading: historyIsLoading,
    isValidating: historyIsValidating,
  } = useSWR<GpuHistoryResponse>(historyUrl, fetcher, {
    keepPreviousData: true,
    refreshInterval: 60_000,
  });

  const latest = latestData?.latest ?? initialLatest;
  const latestCheckedAt = latestData?.checked_at ?? initialLatestCheckedAt;
  const snapshots = needsRawHistory
    ? historyData?.snapshots ?? EMPTY_SNAPSHOTS
    : EMPTY_SNAPSHOTS;
  const displayedHours = historyData?.hours ?? hours;
  const historyPending =
    needsRawHistory && (historyIsLoading || historyIsValidating);

  const gpuTypes = useMemo(() => {
    const types = new Set(latest.map((g) => gpuType(g.gpu_name)));
    return [...types].sort();
  }, [latest]);

  const allHostnames = useMemo(() => {
    return [...new Set(latest.map((g) => g.hostname))].sort();
  }, [latest]);

  const filtered = useMemo(() => {
    let rows = latest;
    if (gpuTypeFilter) rows = rows.filter((g) => gpuType(g.gpu_name) === gpuTypeFilter);
    if (hostFilter) rows = rows.filter((g) => g.hostname === hostFilter);
    return rows;
  }, [latest, gpuTypeFilter, hostFilter]);

  const filteredHosts = useMemo(() => {
    return [...new Set(filtered.map((g) => g.hostname))].sort();
  }, [filtered]);

  const hostCapacityGb = useMemo(() => {
    const capacities = new Map<string, number>();
    for (const gpu of filtered) {
      capacities.set(
        gpu.hostname,
        (capacities.get(gpu.hostname) ?? 0) + gpu.mem_total_mb / 1024,
      );
    }
    return capacities;
  }, [filtered]);

  const totalCapacityGb = useMemo(
    () => [...hostCapacityGb.values()].reduce((sum, capacity) => sum + capacity, 0),
    [hostCapacityGb],
  );

  const chartData = useMemo(() => {
    if (
      chartMode === "overview" &&
      hours === 24 &&
      !hostFilter &&
      !gpuTypeFilter &&
      snapshots.length === 0
    ) {
      return {
        data: initialOverview.map((point) => ({
          time: point.time,
          [OVERVIEW_SERIES[0]]:
            metric === "memory" ? point.memoryP50 : point.gpuP50,
          [OVERVIEW_SERIES[1]]:
            metric === "memory" ? point.memoryP90 : point.gpuP90,
          [OVERVIEW_SERIES[2]]:
            metric === "memory" ? point.memoryPeak : point.gpuPeak,
        })),
        hosts: [...OVERVIEW_SERIES],
      };
    }
    if (snapshots.length === 0) return { data: [] as Array<Record<string, number>>, hosts: [] as string[] };

    const relevantHosts = new Set(filteredHosts);
    // Only chart hosts that actually have data points in the selected window —
    // offline hosts still belong in the roster/table but would otherwise add
    // empty legend lines here.
    const hostsWithData = new Set<string>();

    const bucketMap = new Map<
      number,
      Map<string, { memPctSum: number; gpuUtilSum: number; count: number }>
    >();

    for (const row of snapshots) {
      if (!relevantHosts.has(row.hostname)) continue;
      if (gpuTypeFilter && gpuType(row.gpu_name) !== gpuTypeFilter) continue;

      hostsWithData.add(row.hostname);
      const t = new Date(row.time_bucket).getTime();
      if (!bucketMap.has(t)) bucketMap.set(t, new Map());
      const hostMap = bucketMap.get(t)!;
      if (!hostMap.has(row.hostname)) {
        hostMap.set(row.hostname, { memPctSum: 0, gpuUtilSum: 0, count: 0 });
      }
      const entry = hostMap.get(row.hostname)!;
      entry.memPctSum += Number(row.mem_pct_sum);
      entry.gpuUtilSum += Number(row.gpu_util_sum);
      entry.count += Number(row.sample_count);
    }

    const hosts = [...hostsWithData].sort();
    const overviewSeries = hosts.length === 1 ? ["Utilization"] : [...OVERVIEW_SERIES];
    const rows = [...bucketMap.entries()]
      .map(([time, hostMap]) => {
        const row: Record<string, number> = { time };
        const utilizationValues: number[] = [];
        for (const host of hosts) {
          const entry = hostMap.get(host);
          if (entry) {
            const total = metric === "memory"
              ? entry.memPctSum
              : entry.gpuUtilSum;
            const averagePercent = total / entry.count;
            utilizationValues.push(averagePercent);
            if (chartMode === "stacked") {
              row[host] =
                Math.round(
                  (averagePercent / 100) *
                    (hostCapacityGb.get(host) ?? 0) *
                    10,
                ) / 10;
            } else if (chartMode === "hosts") {
              row[host] = Math.round(averagePercent);
            }
          }
        }
        if (chartMode === "overview" && utilizationValues.length > 0) {
          if (overviewSeries.length === 1) {
            row[overviewSeries[0]] = Math.round(utilizationValues[0]);
          } else {
            row[OVERVIEW_SERIES[0]] = Math.round(
              percentile(utilizationValues, 0.5),
            );
            row[OVERVIEW_SERIES[1]] = Math.round(
              percentile(utilizationValues, 0.9),
            );
            row[OVERVIEW_SERIES[2]] = Math.round(
              Math.max(...utilizationValues),
            );
          }
        }
        return row;
      })
      .sort((a, b) => a.time - b.time);

    return {
      data: rows,
      hosts: chartMode === "overview" ? overviewSeries : hosts,
    };
  }, [
    snapshots,
    filteredHosts,
    gpuTypeFilter,
    chartMode,
    hostCapacityGb,
    hours,
    hostFilter,
    initialOverview,
    metric,
  ]);

  const tickInterval = Math.max(1, Math.floor(chartData.data.length / 10));

  const hostRows = useMemo(() => {
    const map = new Map<string, {
      hostname: string;
      gpuType: string;
      gpuCount: number;
      gpuUtil: number;
      memUsedMb: number;
      memTotalMb: number;
      lastSeen: string;
      gpus: Array<{
        index: number;
        gpuUtil: number;
        memUsedMb: number;
        memTotalMb: number;
      }>;
    }>();
    for (const g of filtered) {
      const existing = map.get(g.hostname);
      const gpu = {
        index: g.gpu_index,
        gpuUtil: g.gpu_util,
        memUsedMb: g.mem_used_mb,
        memTotalMb: g.mem_total_mb,
      };
      if (!existing) {
        map.set(g.hostname, {
          hostname: g.hostname,
          gpuType: gpuType(g.gpu_name),
          gpuCount: 1,
          gpuUtil: g.gpu_util,
          memUsedMb: g.mem_used_mb,
          memTotalMb: g.mem_total_mb,
          lastSeen: g.reported_at,
          gpus: [gpu],
        });
      } else {
        existing.gpuCount++;
        existing.gpuUtil += g.gpu_util;
        existing.memUsedMb += g.mem_used_mb;
        existing.memTotalMb += g.mem_total_mb;
        existing.gpus.push(gpu);
        if (g.reported_at > existing.lastSeen) existing.lastSeen = g.reported_at;
      }
    }
    for (const row of map.values()) {
      row.gpus.sort((a, b) => a.index - b.index);
    }
    return [...map.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
  }, [filtered]);

  function formatXTick(t: number): string {
    const d = new Date(t);
    if (displayedHours <= 24) {
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    } else if (displayedHours <= 168) {
      return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", hour12: true });
    }
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  return (
    <div className="space-y-6">
      {needsRawHistory && historyError && snapshots.length === 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          GPU history could not be loaded. Current host readings may still be available below.
        </div>
      )}
      <div className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-[-0.03em]">GPU Metrics</h1>
            <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              {filteredHosts.length.toLocaleString()} hosts · {filtered.length.toLocaleString()} GPUs ·{" "}
              {formatCapacityGb(totalCapacityGb)} total memory
            </p>
          </div>
          <div
            className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 text-xs lg:max-w-xl lg:justify-end"
            role="status"
            aria-live="polite"
          >
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 font-medium ${
                latestIsValidating
                  ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/80 dark:bg-blue-950/50 dark:text-blue-300"
                  : latestError
                    ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/50 dark:text-amber-300"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/50 dark:text-emerald-300"
              }`}
            >
              {latestIsValidating ? (
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-70 motion-reduce:animate-none" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                </span>
              ) : (
                <span
                  className={`h-2 w-2 rounded-full ${
                    latestError ? "bg-amber-500" : "bg-emerald-500"
                  }`}
                  aria-hidden="true"
                />
              )}
              {latestIsValidating
                ? latest.length > 0
                  ? "Checking for fresh readings"
                  : "Loading GPU readings"
                : latestError
                  ? latest.length > 0
                    ? "Refresh paused"
                    : "Live readings unavailable"
                  : `Checked ${formatCheckedAgo(latestCheckedAt, now)}`}
            </span>
            <span className="text-zinc-500 dark:text-zinc-400">
              {latestIsValidating && latest.length > 0
                ? "Showing the last update while new data loads."
                : latestError
                  ? latest.length > 0
                    ? `Showing readings checked ${formatCheckedAgo(latestCheckedAt, now)}.`
                    : "Retry to load the current GPU state."
                  : "Automatically refreshes every 30 seconds."}
            </span>
            <button
              type="button"
              onClick={() => void refreshLatest()}
              disabled={latestIsValidating}
              className="dashboard-control inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 py-2 font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-wait disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 sm:min-h-10"
              aria-label={latestError ? "Retry GPU data refresh" : "Refresh GPU data now"}
            >
              <svg
                className={`h-3.5 w-3.5 ${latestIsValidating ? "animate-spin motion-reduce:animate-none" : ""}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 7v5h-5M4 17v-5h5" />
                <path strokeLinecap="round" d="M6.1 8.5A7 7 0 0 1 18.7 7M17.9 15.5A7 7 0 0 1 5.3 17" />
              </svg>
              {latestError ? "Retry" : "Refresh"}
            </button>
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 sm:p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <SearchableSelect
                label="Host"
                value={hostFilter}
                onChange={setHostFilter}
                options={allHostnames}
                allLabel="All Hosts"
              />
              <SearchableSelect
                label="GPU Type"
                value={gpuTypeFilter}
                onChange={setGpuTypeFilter}
                options={gpuTypes}
                allLabel="All Types"
              />
            </div>
            <div className="min-w-0">
              <div className="mb-1 block text-xs font-medium tracking-[0.01em] text-zinc-500 dark:text-zinc-400">
                Time Range
              </div>
              <div className="scrollbar-hidden -mx-1 overflow-x-auto px-1">
                <div
                  className="flex min-w-max gap-1 rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700"
                  role="group"
                  aria-label="GPU history time range"
                >
                  {HOURS_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setHours(opt.value)}
                      aria-pressed={hours === opt.value}
                      className={`dashboard-control min-h-11 rounded px-3 py-2 text-sm font-medium sm:min-h-10 ${
                        hours === opt.value
                          ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                          : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Per-host GPU metric chart */}
      <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-none sm:p-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.02em]">
              {metric === "utilization"
                ? chartMode === "overview"
                  ? "Fleet GPU Utilization Overview"
                  : "GPU Utilization by Host"
                : chartMode === "overview"
                  ? "Fleet Memory Overview"
                  : chartMode === "hosts"
                    ? "Memory Utilization by Host"
                    : "Stacked Memory by Host"}
            </h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {chartMode === "overview"
                ? filteredHosts.length === 1
                  ? "Utilization for the selected host."
                  : `Typical, high, and peak utilization across ${chartData.hosts.length > 0 ? filteredHosts.length : 0} hosts.`
                : chartMode === "hosts"
                  ? `${chartData.hosts.length} individual host lines. Filter to a host for close inspection.`
                  : `Aggregate usage across ${filtered.length} GPUs, stacked by host.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {historyPending && (
              <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400" role="status">
                <span className="h-3 w-3 animate-spin rounded-full border border-zinc-300 border-t-zinc-600 motion-reduce:animate-none dark:border-zinc-700 dark:border-t-zinc-300" aria-hidden="true" />
                Updating {HOURS_OPTIONS.find((option) => option.value === hours)?.label ?? `${hours}h`} chart…
              </span>
            )}
            <div
              className="flex gap-1 rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700"
              role="group"
              aria-label="GPU chart metric"
            >
              {([
                { label: "Memory", value: "memory" },
                { label: "GPU Utilization", value: "utilization" },
              ] as const).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setMetric(option.value);
                    if (option.value === "utilization" && chartMode === "stacked") {
                      setChartMode("overview");
                    }
                  }}
                  aria-pressed={metric === option.value}
                  className={`dashboard-control min-h-11 rounded px-3 py-2 text-sm font-medium sm:min-h-10 ${
                    metric === option.value
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div
              className="flex gap-1 rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700"
              role="group"
              aria-label="GPU chart mode"
            >
              {([
                { label: "Overview", value: "overview" },
                { label: "Hosts", value: "hosts" },
                { label: "Stacked", value: "stacked" },
              ] as const)
                .filter((option) => metric === "memory" || option.value !== "stacked")
                .map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setChartMode(option.value)}
                    aria-pressed={chartMode === option.value}
                    className={`dashboard-control min-h-11 rounded px-3 py-2 text-sm font-medium sm:min-h-10 ${
                      chartMode === option.value
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                        : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
            </div>
          </div>
        </div>
        <GpuMemChart
          data={chartData.data}
          hosts={chartData.hosts}
          formatXTick={formatXTick}
          tickInterval={tickInterval}
          mode={chartMode}
          totalCapacityGb={totalCapacityGb}
          totalGpuCount={filtered.length}
        />
      </div>

      {/* Host summary table */}
      <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-none">
        <div className="flex min-h-14 items-center justify-between gap-4 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800 sm:px-6">
          <h2 className="text-lg font-semibold tracking-[-0.02em]">Host Summary</h2>
          <span className="text-sm tabular-nums text-zinc-500 dark:text-zinc-400">
            {hostRows.length} hosts
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-5 py-3 font-medium sm:px-6">Host</th>
                <th className="px-5 py-3 font-medium sm:px-6">GPU Type</th>
                <th className="px-5 py-3 font-medium sm:px-6">Memory</th>
                <th className="px-5 py-3 font-medium sm:px-6">GPU Utilization</th>
                <th className="px-5 py-3 font-medium sm:px-6">Per-GPU Memory</th>
                <th className="px-5 py-3 font-medium sm:px-6">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {hostRows.map((h) => {
                const memPct = h.memTotalMb > 0 ? Math.round((h.memUsedMb / h.memTotalMb) * 100) : 0;
                const gpuUtil = h.gpuCount > 0 ? Math.round(h.gpuUtil / h.gpuCount) : 0;
                const ago = now > 0
                  ? Math.round((now - new Date(h.lastSeen).getTime()) / 60_000)
                  : 0;
                const offline = now > 0 && ago > 10;
                const stale = now > 0 && ago > 5;
                return (
                  <tr
                    key={h.hostname}
                    className={`border-b border-zinc-100 last:border-0 dark:border-zinc-800/50 ${stale ? "opacity-50" : ""}`}
                  >
                    <td className="px-5 py-3.5 font-medium sm:px-6">
                      {h.hostname}
                      {offline && (
                        <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
                          Offline
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 sm:px-6">{h.gpuType}</td>
                    <td className="px-5 py-3.5 sm:px-6">
                      <span className={memPct > 90 ? "font-medium text-red-600 dark:text-red-400" : ""}>
                        {formatMemory(h.memUsedMb)}
                      </span>
                      <span className="text-zinc-400"> / {formatMemory(h.memTotalMb)}</span>
                      <span className="ml-1 text-xs text-zinc-400">({memPct}%)</span>
                    </td>
                    <td className="px-5 py-3.5 sm:px-6">
                      <div className="flex min-w-28 items-center gap-2">
                        <span className="w-10 tabular-nums">{gpuUtil}%</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                          <div
                            className="h-full rounded-full bg-emerald-500 dark:bg-emerald-400"
                            style={{ width: `${Math.min(Math.max(gpuUtil, 0), 100)}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 sm:px-6">
                      <div className="flex items-end gap-1.5" style={{ height: 40 }}>
                        {h.gpus.map((gpu) => {
                          const pct = gpu.memTotalMb > 0 ? Math.round((gpu.memUsedMb / gpu.memTotalMb) * 100) : 0;
                          const barColor = pct > 90
                            ? "bg-red-500 dark:bg-red-400"
                            : pct > 60
                            ? "bg-blue-500 dark:bg-blue-400"
                            : "bg-blue-400 dark:bg-blue-500";
                          return (
                            <div
                              key={gpu.index}
                              className="group relative flex flex-col items-center"
                            >
                              <div
                                className="relative w-3 rounded-sm bg-zinc-100 dark:bg-zinc-800"
                                style={{ height: 40 }}
                              >
                                <div
                                  className={`absolute bottom-0 w-full rounded-sm ${barColor}`}
                                  style={{ height: `${Math.max(pct, 2)}%` }}
                                />
                              </div>
                              <div className="pointer-events-none absolute -top-14 left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap rounded border border-zinc-200 bg-white px-2 py-1 text-xs shadow-lg group-hover:block dark:border-zinc-700 dark:bg-zinc-900">
                                <span className="font-medium">GPU {gpu.index}</span>
                                <span className="ml-1 text-zinc-400">
                                  {formatMemory(gpu.memUsedMb)} / {formatMemory(gpu.memTotalMb)} ({pct}%)
                                </span>
                                <span className="block text-zinc-400">
                                  GPU utilization: {Math.round(gpu.gpuUtil)}%
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </td>
                    <td
                      className={`whitespace-nowrap px-5 py-3.5 sm:px-6 ${
                        offline
                          ? "text-red-600 dark:text-red-400"
                          : stale
                          ? "text-yellow-600 dark:text-yellow-400"
                          : "text-zinc-500 dark:text-zinc-400"
                      }`}
                    >
                      {stale ? formatAgo(ago) : "just now"}
                    </td>
                  </tr>
                );
              })}
              {hostRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-zinc-400">
                    No GPU data found. Deploy the reporting script to start collecting metrics.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
