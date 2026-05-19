"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { StatCard } from "@/components/stat-card";
import { SearchableSelect } from "@/components/searchable-select";
import { GpuMemChart } from "@/components/gpu-util-chart";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface GpuSnapshot {
  time_bucket: string;
  hostname: string;
  gpu_index: number;
  gpu_name: string | null;
  mem_used_mb: number;
  mem_total_mb: number;
}

interface GpuLatest {
  hostname: string;
  gpu_index: number;
  gpu_name: string | null;
  mem_used_mb: number;
  mem_total_mb: number;
  reported_at: string;
}

interface GpuResponse {
  snapshots: GpuSnapshot[];
  hostnames: string[];
  latest: GpuLatest[];
  error?: string;
}

const HOURS_OPTIONS = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
];

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function gpuType(name: string | null): string {
  if (!name) return "Unknown";
  const match = name.match(/\b(A100|H100|H200|B200|B100|L40S?|A10G?|T4|V100|GB200|GB300)\b/i);
  return match ? match[1].toUpperCase() : name;
}

export default function GpuPage() {
  const [gpuTypeFilter, setGpuTypeFilter] = useState("");
  const [hours, setHours] = useState(24);

  const url = `/api/gpu?hours=${hours}`;
  const { data, error, isLoading } = useSWR<GpuResponse>(url, fetcher, {
    refreshInterval: 60_000,
  });

  const gpuTypes = useMemo(() => {
    const latest = data?.latest ?? [];
    const types = new Set(latest.map((g) => gpuType(g.gpu_name)));
    return [...types].sort();
  }, [data]);

  const filtered = useMemo(() => {
    const latest = data?.latest ?? [];
    if (!gpuTypeFilter) return latest;
    return latest.filter((g) => gpuType(g.gpu_name) === gpuTypeFilter);
  }, [data, gpuTypeFilter]);

  const filteredHosts = useMemo(() => {
    return [...new Set(filtered.map((g) => g.hostname))].sort();
  }, [filtered]);

  const chartData = useMemo(() => {
    const snapshots = data?.snapshots ?? [];
    if (snapshots.length === 0) return { data: [] as Array<Record<string, number>>, hosts: [] as string[] };

    const relevantHosts = new Set(filteredHosts);

    const bucketMap = new Map<number, Map<string, { memPctSum: number; count: number }>>();

    for (const row of snapshots) {
      if (!relevantHosts.has(row.hostname)) continue;
      if (gpuTypeFilter && gpuType(row.gpu_name) !== gpuTypeFilter) continue;

      const t = new Date(row.time_bucket).getTime();
      if (!bucketMap.has(t)) bucketMap.set(t, new Map());
      const hostMap = bucketMap.get(t)!;
      if (!hostMap.has(row.hostname)) hostMap.set(row.hostname, { memPctSum: 0, count: 0 });
      const entry = hostMap.get(row.hostname)!;
      entry.memPctSum += row.mem_total_mb > 0 ? (Number(row.mem_used_mb) / Number(row.mem_total_mb)) * 100 : 0;
      entry.count++;
    }

    const hosts = [...relevantHosts].sort();
    const rows = [...bucketMap.entries()]
      .map(([time, hostMap]) => {
        const row: Record<string, number> = { time };
        for (const host of hosts) {
          const entry = hostMap.get(host);
          if (entry) row[host] = Math.round(entry.memPctSum / entry.count);
        }
        return row;
      })
      .sort((a, b) => a.time - b.time);

    return { data: rows, hosts };
  }, [data, filteredHosts, gpuTypeFilter]);

  const tickInterval = Math.max(1, Math.floor(chartData.data.length / 10));

  function formatXTick(t: number): string {
    const d = new Date(t);
    if (hours <= 24) {
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    } else if (hours <= 168) {
      return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", hour12: true });
    }
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading GPU data...
      </div>
    );
  }

  if (error || data?.error) {
    return (
      <div className="flex h-64 items-center justify-center text-red-400">
        Failed to load GPU data. Check DATABASE_URL configuration.
      </div>
    );
  }

  const totalGpus = filtered.length;
  const avgMemPct = totalGpus > 0
    ? Math.round(filtered.reduce((s, g) => s + (g.mem_total_mb > 0 ? (g.mem_used_mb / g.mem_total_mb) * 100 : 0), 0) / totalGpus)
    : 0;
  const totalMemUsedGb = filtered.reduce((s, g) => s + g.mem_used_mb, 0) / 1024;
  const totalMemGb = filtered.reduce((s, g) => s + g.mem_total_mb, 0) / 1024;
  const uniqueHosts = filteredHosts.length;

  // Aggregate per-host for the table
  const hostRows = useMemo(() => {
    const map = new Map<string, { hostname: string; gpuType: string; gpuCount: number; memUsedMb: number; memTotalMb: number; lastSeen: string }>();
    for (const g of filtered) {
      const existing = map.get(g.hostname);
      if (!existing) {
        map.set(g.hostname, {
          hostname: g.hostname,
          gpuType: gpuType(g.gpu_name),
          gpuCount: 1,
          memUsedMb: g.mem_used_mb,
          memTotalMb: g.mem_total_mb,
          lastSeen: g.reported_at,
        });
      } else {
        existing.gpuCount++;
        existing.memUsedMb += g.mem_used_mb;
        existing.memTotalMb += g.mem_total_mb;
        if (g.reported_at > existing.lastSeen) existing.lastSeen = g.reported_at;
      }
    }
    return [...map.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
  }, [filtered]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">GPU Memory</h1>
        <div className="flex gap-3">
          <SearchableSelect
            label="GPU Type"
            value={gpuTypeFilter}
            onChange={setGpuTypeFilter}
            options={gpuTypes}
            allLabel="All Types"
          />
          <div className="flex gap-1 rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700">
            {HOURS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setHours(opt.value)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
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

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Nodes" value={uniqueHosts} detail={`${totalGpus} GPUs total`} />
        <StatCard
          label="Avg Memory Used"
          value={`${avgMemPct}%`}
          color={avgMemPct > 90 ? "red" : avgMemPct > 70 ? "yellow" : "default"}
        />
        <StatCard
          label="Memory Used"
          value={`${totalMemUsedGb.toFixed(0)} GB`}
          detail={`of ${totalMemGb.toFixed(0)} GB total`}
        />
        <StatCard
          label="Memory Free"
          value={`${(totalMemGb - totalMemUsedGb).toFixed(0)} GB`}
          color={(totalMemGb - totalMemUsedGb) < 50 ? "yellow" : "default"}
        />
      </div>

      {/* Per-host memory chart */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="mb-4 text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Memory Utilization by Host
        </h3>
        <GpuMemChart
          data={chartData.data}
          hosts={chartData.hosts}
          formatXTick={formatXTick}
          tickInterval={tickInterval}
        />
      </div>

      {/* Host summary table */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Host Summary
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-5 py-2.5 font-medium">Host</th>
                <th className="px-5 py-2.5 font-medium">GPU Type</th>
                <th className="px-5 py-2.5 font-medium">GPUs</th>
                <th className="px-5 py-2.5 font-medium">Memory</th>
                <th className="px-5 py-2.5 font-medium">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {hostRows.map((h) => {
                const memPct = h.memTotalMb > 0 ? Math.round((h.memUsedMb / h.memTotalMb) * 100) : 0;
                const ago = Math.round((Date.now() - new Date(h.lastSeen).getTime()) / 60_000);
                const stale = ago > 5;
                return (
                  <tr
                    key={h.hostname}
                    className={`border-b border-zinc-100 last:border-0 dark:border-zinc-800/50 ${stale ? "opacity-50" : ""}`}
                  >
                    <td className="px-5 py-2.5 font-medium">{h.hostname}</td>
                    <td className="px-5 py-2.5">{h.gpuType}</td>
                    <td className="px-5 py-2.5">{h.gpuCount}</td>
                    <td className="px-5 py-2.5">
                      <span className={memPct > 90 ? "font-medium text-red-600 dark:text-red-400" : ""}>
                        {formatMemory(h.memUsedMb)}
                      </span>
                      <span className="text-zinc-400"> / {formatMemory(h.memTotalMb)}</span>
                      <span className="ml-1 text-xs text-zinc-400">({memPct}%)</span>
                    </td>
                    <td className={`whitespace-nowrap px-5 py-2.5 text-zinc-500 dark:text-zinc-400 ${stale ? "text-yellow-600 dark:text-yellow-400" : ""}`}>
                      {stale ? `${ago}m ago` : "just now"}
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
