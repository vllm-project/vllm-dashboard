"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { StatCard } from "@/components/stat-card";
import { SearchableSelect } from "@/components/searchable-select";
import { GpuUtilChart } from "@/components/gpu-util-chart";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface GpuSnapshot {
  time_bucket: string;
  hostname: string;
  gpu_index: number;
  gpu_name: string | null;
  gpu_util: number;
  mem_used_mb: number;
  mem_total_mb: number;
  temperature_c: number | null;
  power_draw_w: number | null;
  power_limit_w: number | null;
}

interface GpuLatest {
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

export default function GpuPage() {
  const [hostname, setHostname] = useState("");
  const [hours, setHours] = useState(24);

  const url = `/api/gpu?hours=${hours}${hostname ? `&hostname=${encodeURIComponent(hostname)}` : ""}`;
  const { data, error, isLoading } = useSWR<GpuResponse>(url, fetcher, {
    refreshInterval: 60_000,
  });

  const chartDataByGpu = useMemo(() => {
    const snapshots = data?.snapshots ?? [];
    if (snapshots.length === 0) return new Map<string, Array<{ time: number; gpu_util: number; mem_pct: number; temperature_c: number | null }>>();

    const grouped = new Map<string, Array<{ time: number; gpu_util: number; mem_pct: number; temperature_c: number | null }>>();

    for (const row of snapshots) {
      const key = `${row.hostname}:gpu${row.gpu_index}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push({
        time: new Date(row.time_bucket).getTime(),
        gpu_util: Number(row.gpu_util),
        mem_pct: row.mem_total_mb > 0 ? Math.round((Number(row.mem_used_mb) / Number(row.mem_total_mb)) * 100) : 0,
        temperature_c: row.temperature_c != null ? Number(row.temperature_c) : null,
      });
    }

    for (const arr of grouped.values()) {
      arr.sort((a, b) => a.time - b.time);
    }

    return grouped;
  }, [data]);

  const avgChartData = useMemo(() => {
    const snapshots = data?.snapshots ?? [];
    if (snapshots.length === 0) return [];

    const targetHost = hostname || null;
    const bucketMap = new Map<number, { utilSum: number; memPctSum: number; tempSum: number; tempCount: number; count: number }>();

    for (const row of snapshots) {
      if (targetHost && row.hostname !== targetHost) continue;
      const t = new Date(row.time_bucket).getTime();
      if (!bucketMap.has(t)) bucketMap.set(t, { utilSum: 0, memPctSum: 0, tempSum: 0, tempCount: 0, count: 0 });
      const entry = bucketMap.get(t)!;
      entry.utilSum += Number(row.gpu_util);
      entry.memPctSum += row.mem_total_mb > 0 ? (Number(row.mem_used_mb) / Number(row.mem_total_mb)) * 100 : 0;
      if (row.temperature_c != null) {
        entry.tempSum += Number(row.temperature_c);
        entry.tempCount++;
      }
      entry.count++;
    }

    return [...bucketMap.entries()]
      .map(([time, v]) => ({
        time,
        gpu_util: Math.round((v.utilSum / v.count) * 10) / 10,
        mem_pct: Math.round(v.memPctSum / v.count),
        temperature_c: v.tempCount > 0 ? Math.round(v.tempSum / v.tempCount) : null,
      }))
      .sort((a, b) => a.time - b.time);
  }, [data, hostname]);

  const tickInterval = Math.max(1, Math.floor(avgChartData.length / 10));

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

  const latest = data?.latest ?? [];
  const filtered = hostname ? latest.filter((g) => g.hostname === hostname) : latest;
  const totalGpus = filtered.length;
  const avgUtil = totalGpus > 0 ? Math.round(filtered.reduce((s, g) => s + g.gpu_util, 0) / totalGpus) : 0;
  const avgMemPct = totalGpus > 0
    ? Math.round(filtered.reduce((s, g) => s + (g.mem_total_mb > 0 ? (g.mem_used_mb / g.mem_total_mb) * 100 : 0), 0) / totalGpus)
    : 0;
  const uniqueHosts = new Set(filtered.map((g) => g.hostname)).size;
  const maxTemp = filtered.reduce((m, g) => Math.max(m, g.temperature_c ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">GPU Utilization</h1>
        <div className="flex gap-3">
          <SearchableSelect
            label="Host"
            value={hostname}
            onChange={setHostname}
            options={data?.hostnames ?? []}
            allLabel="All Hosts"
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Nodes" value={uniqueHosts} detail={`${totalGpus} GPUs total`} />
        <StatCard
          label="Avg GPU Util"
          value={`${avgUtil}%`}
          color={avgUtil > 90 ? "green" : avgUtil < 30 ? "yellow" : "default"}
        />
        <StatCard
          label="Avg Mem Used"
          value={`${avgMemPct}%`}
          color={avgMemPct > 90 ? "red" : "default"}
        />
        <StatCard
          label="Max Temp"
          value={maxTemp > 0 ? `${maxTemp}°C` : "—"}
          color={maxTemp > 85 ? "red" : maxTemp > 75 ? "yellow" : "default"}
        />
        <StatCard
          label="Total Power"
          value={
            filtered.some((g) => g.power_draw_w != null)
              ? `${Math.round(filtered.reduce((s, g) => s + (g.power_draw_w ?? 0), 0))} W`
              : "—"
          }
        />
      </div>

      {/* Average utilization chart */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="mb-4 text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Average GPU Utilization{hostname ? ` — ${hostname}` : ""}
        </h3>
        <GpuUtilChart
          data={avgChartData}
          formatXTick={formatXTick}
          tickInterval={tickInterval}
        />
      </div>

      {/* Per-GPU charts when a host is selected */}
      {hostname && chartDataByGpu.size > 1 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[...chartDataByGpu.entries()].map(([key, gpuData]) => {
            const gpuTickInterval = Math.max(1, Math.floor(gpuData.length / 8));
            return (
              <div
                key={key}
                className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <h3 className="mb-4 text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  {key}
                </h3>
                <GpuUtilChart
                  data={gpuData}
                  formatXTick={formatXTick}
                  tickInterval={gpuTickInterval}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* GPU detail table */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            GPU Status
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-5 py-2.5 font-medium">Host</th>
                <th className="px-5 py-2.5 font-medium">GPU</th>
                <th className="px-5 py-2.5 font-medium">Model</th>
                <th className="px-5 py-2.5 font-medium">Util</th>
                <th className="px-5 py-2.5 font-medium">Memory</th>
                <th className="px-5 py-2.5 font-medium">Temp</th>
                <th className="px-5 py-2.5 font-medium">Power</th>
                <th className="px-5 py-2.5 font-medium">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered
                .sort((a, b) => a.hostname.localeCompare(b.hostname) || a.gpu_index - b.gpu_index)
                .map((g) => {
                  const memPct = g.mem_total_mb > 0 ? Math.round((g.mem_used_mb / g.mem_total_mb) * 100) : 0;
                  const ago = Math.round((Date.now() - new Date(g.reported_at).getTime()) / 60_000);
                  const stale = ago > 5;
                  return (
                    <tr
                      key={`${g.hostname}-${g.gpu_index}`}
                      className={`border-b border-zinc-100 last:border-0 dark:border-zinc-800/50 ${stale ? "opacity-50" : ""}`}
                    >
                      <td className="px-5 py-2.5 font-medium">{g.hostname}</td>
                      <td className="px-5 py-2.5">{g.gpu_index}</td>
                      <td className="px-5 py-2.5 text-zinc-500 dark:text-zinc-400">{g.gpu_name ?? "—"}</td>
                      <td className={`px-5 py-2.5 font-medium ${
                        g.gpu_util > 80 ? "text-emerald-600 dark:text-emerald-400"
                          : g.gpu_util < 20 ? "text-yellow-600 dark:text-yellow-400"
                          : ""
                      }`}>
                        {g.gpu_util}%
                      </td>
                      <td className="px-5 py-2.5">
                        <span className={memPct > 90 ? "font-medium text-red-600 dark:text-red-400" : ""}>
                          {formatMemory(g.mem_used_mb)}
                        </span>
                        <span className="text-zinc-400"> / {formatMemory(g.mem_total_mb)}</span>
                        <span className="ml-1 text-xs text-zinc-400">({memPct}%)</span>
                      </td>
                      <td className={`px-5 py-2.5 ${
                        (g.temperature_c ?? 0) > 85 ? "text-red-600 dark:text-red-400"
                          : (g.temperature_c ?? 0) > 75 ? "text-yellow-600 dark:text-yellow-400"
                          : ""
                      }`}>
                        {g.temperature_c != null ? `${g.temperature_c}°C` : "—"}
                      </td>
                      <td className="px-5 py-2.5">
                        {g.power_draw_w != null
                          ? `${g.power_draw_w}W${g.power_limit_w ? ` / ${g.power_limit_w}W` : ""}`
                          : "—"
                        }
                      </td>
                      <td className={`whitespace-nowrap px-5 py-2.5 text-zinc-500 dark:text-zinc-400 ${stale ? "text-yellow-600 dark:text-yellow-400" : ""}`}>
                        {stale ? `${ago}m ago` : "just now"}
                      </td>
                    </tr>
                  );
                })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-zinc-400">
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
