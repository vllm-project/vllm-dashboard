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
} from "@/lib/gpu-types";

const GpuMemChart = dynamic(
  () => import("@/components/gpu-util-chart").then((module) => module.GpuMemChart),
  {
    ssr: false,
    loading: () => <div className="h-[300px] animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />,
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

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function formatFleetMemory(mb: number): string {
  if (mb >= 1024 * 1024) return `${(mb / (1024 * 1024)).toFixed(1)} TB`;
  if (mb >= 1024) return `${Math.round(mb / 1024).toLocaleString()} GB`;
  return `${Math.round(mb)} MB`;
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
  initialHistory: GpuHistoryResponse;
  initialLatest: GpuLatest[];
  initialLatestCheckedAt: string;
  initialNow: number;
}

export function GpuDashboard({
  initialHistory,
  initialLatest,
  initialLatestCheckedAt,
  initialNow,
}: GpuDashboardProps) {
  const [gpuTypeFilter, setGpuTypeFilter] = useState("");
  const [hostFilter, setHostFilter] = useState("");
  const [hours, setHours] = useState(24);
  const [chartMode, setChartMode] = useState<GpuChartMode>("lines");
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

  const historyUrl = `/api/gpu/history?hours=${hours}${
    hostFilter ? `&hostname=${encodeURIComponent(hostFilter)}` : ""
  }`;
  const {
    data: historyData,
    error: historyError,
    isLoading: historyIsLoading,
    isValidating: historyIsValidating,
  } = useSWR<GpuHistoryResponse>(historyUrl, fetcher, {
    fallbackData: hours === 24 && !hostFilter ? initialHistory : undefined,
    keepPreviousData: true,
    revalidateOnMount:
      initialHistory.snapshots.length === 0 || hours !== 24 || Boolean(hostFilter),
    refreshInterval: 60_000,
  });

  const latest = latestData?.latest ?? initialLatest;
  const latestCheckedAt = latestData?.checked_at ?? initialLatestCheckedAt;
  const snapshots = historyData?.snapshots ?? initialHistory.snapshots;
  const displayedHours = historyData?.hours ?? initialHistory.hours;
  const historyPending = historyIsLoading || historyIsValidating;

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

  const fleetMemory = useMemo(() => {
    const usedMb = filtered.reduce((sum, gpu) => sum + gpu.mem_used_mb, 0);
    const totalMb = filtered.reduce((sum, gpu) => sum + gpu.mem_total_mb, 0);
    return {
      usedMb,
      totalMb,
      utilization: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0,
    };
  }, [filtered]);

  const chartData = useMemo(() => {
    if (snapshots.length === 0) return { data: [] as Array<Record<string, number>>, hosts: [] as string[] };

    const relevantHosts = new Set(filteredHosts);
    // Only chart hosts that actually have data points in the selected window —
    // offline hosts still belong in the roster/table but would otherwise add
    // empty legend lines here.
    const hostsWithData = new Set<string>();

    const bucketMap = new Map<number, Map<string, { memPctSum: number; count: number }>>();

    for (const row of snapshots) {
      if (!relevantHosts.has(row.hostname)) continue;
      if (gpuTypeFilter && gpuType(row.gpu_name) !== gpuTypeFilter) continue;

      hostsWithData.add(row.hostname);
      const t = new Date(row.time_bucket).getTime();
      if (!bucketMap.has(t)) bucketMap.set(t, new Map());
      const hostMap = bucketMap.get(t)!;
      if (!hostMap.has(row.hostname)) hostMap.set(row.hostname, { memPctSum: 0, count: 0 });
      const entry = hostMap.get(row.hostname)!;
      entry.memPctSum += Number(row.mem_pct_sum);
      entry.count += Number(row.sample_count);
    }

    const hosts = [...hostsWithData].sort();
    const rows = [...bucketMap.entries()]
      .map(([time, hostMap]) => {
        const row: Record<string, number> = { time };
        for (const host of hosts) {
          const entry = hostMap.get(host);
          if (entry) {
            const averagePercent = entry.memPctSum / entry.count;
            row[host] = chartMode === "stacked"
              ? Math.round((averagePercent / 100) * (hostCapacityGb.get(host) ?? 0) * 10) / 10
              : Math.round(averagePercent);
          }
        }
        return row;
      })
      .sort((a, b) => a.time - b.time);

    return { data: rows, hosts };
  }, [snapshots, filteredHosts, gpuTypeFilter, chartMode, hostCapacityGb]);

  const tickInterval = Math.max(1, Math.floor(chartData.data.length / 10));

  const hostRows = useMemo(() => {
    const map = new Map<string, {
      hostname: string;
      gpuType: string;
      gpuCount: number;
      memUsedMb: number;
      memTotalMb: number;
      lastSeen: string;
      gpus: Array<{ index: number; memUsedMb: number; memTotalMb: number }>;
    }>();
    for (const g of filtered) {
      const existing = map.get(g.hostname);
      const gpu = { index: g.gpu_index, memUsedMb: g.mem_used_mb, memTotalMb: g.mem_total_mb };
      if (!existing) {
        map.set(g.hostname, {
          hostname: g.hostname,
          gpuType: gpuType(g.gpu_name),
          gpuCount: 1,
          memUsedMb: g.mem_used_mb,
          memTotalMb: g.mem_total_mb,
          lastSeen: g.reported_at,
          gpus: [gpu],
        });
      } else {
        existing.gpuCount++;
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
    <div className="gpu-command-center space-y-6">
      {historyError && snapshots.length === 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          GPU history could not be loaded. Current host readings may still be available below.
        </div>
      )}
      <section className="gpu-glass-panel relative overflow-hidden rounded-[28px] border border-blue-500/15 bg-white/70 p-5 shadow-[0_24px_80px_rgba(37,99,235,0.08)] backdrop-blur-xl dark:border-blue-400/15 dark:bg-zinc-950/65 dark:shadow-[0_28px_90px_rgba(0,0,0,0.28)] sm:p-7">
        <div
          className="pointer-events-none absolute -right-20 -top-28 h-72 w-72 rounded-full bg-blue-500/10 blur-3xl dark:bg-blue-400/15"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute right-32 top-10 h-44 w-44 rounded-full bg-violet-500/10 blur-3xl dark:bg-violet-400/10"
          aria-hidden="true"
        />
        <div className="relative">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-blue-500/15 bg-blue-500/[0.07] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-700 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500 shadow-[0_0_12px_rgba(59,130,246,0.9)]" />
                Live fleet telemetry
              </div>
              <h1 className="text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
                GPU <span className="gpu-accent-text">command center.</span>
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-500 dark:text-zinc-400 sm:text-base">
                Memory pressure, fleet capacity, and host health in one live operational view.
              </p>
            </div>
            <div
              className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-xs lg:max-w-sm lg:justify-end"
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
              <button
                type="button"
                onClick={() => void refreshLatest()}
                disabled={latestIsValidating}
                className="dashboard-control inline-flex items-center gap-1 rounded-full px-2 py-1 font-medium text-zinc-500 hover:bg-white/70 hover:text-zinc-900 disabled:cursor-wait disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
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
              <p className="w-full text-zinc-500 dark:text-zinc-400 lg:text-right">
                {latestIsValidating && latest.length > 0
                  ? "Showing the last update while new data loads."
                  : latestError
                    ? latest.length > 0
                      ? `Showing readings checked ${formatCheckedAgo(latestCheckedAt, now)}.`
                      : "Retry to load the current GPU state."
                    : "Automatically refreshes every 30 seconds."}
              </p>
            </div>
          </div>

          <div className="mt-7 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              {
                label: "Hosts",
                value: filteredHosts.length.toLocaleString(),
                detail: hostFilter ? "selected host" : "in this view",
                accent: "bg-blue-500",
              },
              {
                label: "Accelerators",
                value: filtered.length.toLocaleString(),
                detail: gpuTypeFilter || "all GPU types",
                accent: "bg-violet-500",
              },
              {
                label: "Fleet memory",
                value: formatFleetMemory(fleetMemory.totalMb),
                detail: `${formatFleetMemory(fleetMemory.usedMb)} allocated`,
                accent: "bg-cyan-500",
              },
              {
                label: "Utilization",
                value: `${fleetMemory.utilization}%`,
                detail: fleetMemory.utilization > 80 ? "high pressure" : "healthy headroom",
                accent: fleetMemory.utilization > 80 ? "bg-amber-500" : "bg-emerald-500",
              },
            ].map((metric) => (
              <div
                key={metric.label}
                className="gpu-metric-card rounded-2xl border border-white/70 p-4 dark:border-white/[0.07]"
              >
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.13em] text-zinc-500 dark:text-zinc-400">
                  <span className={`h-1.5 w-1.5 rounded-full ${metric.accent}`} aria-hidden="true" />
                  {metric.label}
                </div>
                <div className="mt-2 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">
                  {metric.value}
                </div>
                <div className="mt-1 truncate text-xs text-zinc-400">{metric.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="gpu-glass-panel rounded-2xl border border-zinc-200/80 bg-white/70 p-4 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/60 sm:p-5">
        <div className="mb-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
            Focus the fleet
          </div>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Slice live telemetry without leaving the command view.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
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
          <div className="flex gap-1 rounded-lg border border-zinc-200 bg-zinc-50/80 p-0.5 dark:border-zinc-700 dark:bg-zinc-900/70">
            {HOURS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setHours(opt.value)}
                className={`dashboard-control rounded-md px-2.5 py-1 text-xs font-medium ${
                  hours === opt.value
                    ? "bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-md shadow-blue-500/20"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Per-host memory chart */}
      <div className="gpu-command-panel min-w-0 overflow-hidden rounded-[22px] border p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-600 dark:text-blue-300">
              <span className="h-px w-6 bg-gradient-to-r from-blue-500 to-violet-500" />
              Memory telemetry
            </div>
            <h3 className="text-base font-semibold tracking-[-0.02em]">
              {chartMode === "stacked" ? "Stacked Memory by Host" : "Memory Utilization by Host"}
            </h3>
            {chartMode === "stacked" && (
              <p className="mt-1 text-xs text-zinc-400">
                Aggregate usage across {filtered.length} GPUs, stacked by host.
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {historyPending && (
              <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400" role="status">
                <span className="h-3 w-3 animate-spin rounded-full border border-zinc-300 border-t-zinc-600 motion-reduce:animate-none dark:border-zinc-700 dark:border-t-zinc-300" aria-hidden="true" />
                Updating {HOURS_OPTIONS.find((option) => option.value === hours)?.label ?? `${hours}h`} chart…
              </span>
            )}
            <div
              className="flex gap-1 rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700"
              role="group"
              aria-label="GPU chart mode"
            >
              {([
                { label: "Lines", value: "lines" },
                { label: "Stacked", value: "stacked" },
              ] as const).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setChartMode(option.value)}
                  aria-pressed={chartMode === option.value}
                  className={`dashboard-control rounded px-2.5 py-1 text-xs font-medium ${
                    chartMode === option.value
                      ? "bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-md shadow-blue-500/20"
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
      <div className="min-w-0 overflow-hidden rounded-[22px] border border-zinc-200/80 bg-white/80 shadow-[0_16px_50px_rgba(24,24,27,0.06)] backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/70 dark:shadow-[0_20px_60px_rgba(0,0,0,0.18)]">
        <div className="flex items-center justify-between border-b border-zinc-200/80 px-5 py-4 dark:border-white/10">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              Fleet roster
            </div>
            <h3 className="mt-1 text-base font-semibold tracking-[-0.02em]">
              Host Summary
            </h3>
          </div>
          <span className="rounded-full border border-blue-500/15 bg-blue-500/[0.07] px-2.5 py-1 text-xs font-medium text-blue-700 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200">
            {hostRows.length} hosts
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-5 py-2.5 font-medium">Host</th>
                <th className="px-5 py-2.5 font-medium">GPU Type</th>
                <th className="px-5 py-2.5 font-medium">Memory</th>
                <th className="px-5 py-2.5 font-medium">Per-GPU</th>
                <th className="px-5 py-2.5 font-medium">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {hostRows.map((h) => {
                const memPct = h.memTotalMb > 0 ? Math.round((h.memUsedMb / h.memTotalMb) * 100) : 0;
                const ago = now > 0
                  ? Math.round((now - new Date(h.lastSeen).getTime()) / 60_000)
                  : 0;
                const offline = now > 0 && ago > 10;
                const stale = now > 0 && ago > 5;
                return (
                  <tr
                    key={h.hostname}
                    className={`border-b border-zinc-100 hover:bg-blue-500/[0.035] last:border-0 dark:border-zinc-800/50 dark:hover:bg-blue-400/[0.045] ${stale ? "opacity-50" : ""}`}
                  >
                    <td className="px-5 py-2.5 font-medium">
                      {h.hostname}
                      {offline && (
                        <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
                          Offline
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-2.5">{h.gpuType}</td>
                    <td className="px-5 py-2.5">
                      <span className={memPct > 90 ? "font-medium text-red-600 dark:text-red-400" : ""}>
                        {formatMemory(h.memUsedMb)}
                      </span>
                      <span className="text-zinc-400"> / {formatMemory(h.memTotalMb)}</span>
                      <span className="ml-1 text-xs text-zinc-400">({memPct}%)</span>
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex items-end gap-1" style={{ height: 36 }}>
                        {h.gpus.map((gpu) => {
                          const pct = gpu.memTotalMb > 0 ? Math.round((gpu.memUsedMb / gpu.memTotalMb) * 100) : 0;
                          const barColor = pct > 90
                            ? "from-red-600 to-orange-400"
                            : pct > 60
                            ? "from-blue-700 to-violet-400"
                            : "from-blue-600 to-cyan-400";
                          return (
                            <div
                              key={gpu.index}
                              className="group relative flex flex-col items-center"
                            >
                              <div
                                className="relative w-3 rounded-sm bg-zinc-100 dark:bg-zinc-800"
                                style={{ height: 36 }}
                              >
                                <div
                                  className={`absolute bottom-0 w-full rounded-sm bg-gradient-to-t ${barColor}`}
                                  style={{ height: `${Math.max(pct, 2)}%` }}
                                />
                              </div>
                              <div className="pointer-events-none absolute -top-10 left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap rounded border border-zinc-200 bg-white px-2 py-1 text-xs shadow-lg group-hover:block dark:border-zinc-700 dark:bg-zinc-900">
                                <span className="font-medium">GPU {gpu.index}</span>
                                <span className="ml-1 text-zinc-400">
                                  {formatMemory(gpu.memUsedMb)} / {formatMemory(gpu.memTotalMb)} ({pct}%)
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </td>
                    <td
                      className={`whitespace-nowrap px-5 py-2.5 ${
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
                  <td colSpan={5} className="px-5 py-8 text-center text-zinc-400">
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
