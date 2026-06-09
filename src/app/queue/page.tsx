"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { StatCard } from "@/components/stat-card";
import { SearchableSelect } from "@/components/searchable-select";
import { QueueOverviewChart } from "@/components/queue-overview-chart";
import { effectiveWaiting } from "@/lib/queue-plugins";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface MetricsSnapshot {
  time_bucket: string;
  queue: string;
  agents_idle: number;
  agents_busy: number;
  agents_total: number;
  jobs_scheduled: number;
  jobs_running: number;
  jobs_waiting: number;
  jobs_total: number;
  p50_wait_secs: number | null;
  p90_wait_secs: number | null;
  p95_wait_secs: number | null;
}

interface MetricsLatest {
  queue: string;
  polled_at: string;
  agents_idle: number;
  agents_busy: number;
  agents_total: number;
  jobs_scheduled: number;
  jobs_running: number;
  jobs_waiting: number;
  jobs_total: number;
  p50_wait_secs: number | null;
  p90_wait_secs: number | null;
  p95_wait_secs: number | null;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

interface MetricsResponse {
  snapshots: MetricsSnapshot[];
  queues: string[];
  latest: MetricsLatest[];
  error?: string;
}

const METRICS_HOURS_OPTIONS = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
];

export default function QueuePage() {
  const [queue, setQueue] = useState("gpu_1_queue");
  const [metricsHours, setMetricsHours] = useState(24);
  const [sortCol, setSortCol] = useState<"queue" | "agents" | "running" | "idle" | "waiting" | "p50" | "p90" | "p95">("waiting");
  const [sortAsc, setSortAsc] = useState(false);

  const metricsUrl = `/api/metrics?hours=${metricsHours}${queue ? `&queue=${encodeURIComponent(queue)}` : ""}`;
  const { data: metricsData, error, isLoading } = useSWR<MetricsResponse>(metricsUrl, fetcher, {
    refreshInterval: 60 * 1000,
  });

  interface WaitingBuild {
    build_number: string;
    build_url: string;
    message: string;
    author: string;
    waiting_jobs: string;
    total_jobs: string;
    max_wait_min: string;
  }
  const { data: waitingBuildsData } = useSWR<{ builds: WaitingBuild[] }>(
    queue ? `/api/metrics/waiting-builds?queue=${encodeURIComponent(queue)}` : null,
    fetcher,
    { refreshInterval: 60 * 1000 },
  );

  const metricsQueuesForFilter = metricsData?.queues ?? [];

  // Aggregate snapshots into chart data: sum running/scheduled/waiting/agents per time bucket
  const overviewChartData = useMemo(() => {
    const snapshots = metricsData?.snapshots ?? [];
    if (snapshots.length === 0) return [];

    const bucketMap = new Map<number, { running: number; scheduled: number; waiting: number; agents: number }>();
    for (const row of snapshots) {
      if (queue && row.queue !== queue) continue;
      const t = new Date(row.time_bucket).getTime();
      if (!bucketMap.has(t)) bucketMap.set(t, { running: 0, scheduled: 0, waiting: 0, agents: 0 });
      const entry = bucketMap.get(t)!;
      entry.running += row.jobs_running;
      entry.scheduled += row.jobs_scheduled;
      entry.waiting += row.jobs_waiting;
      entry.agents += row.agents_total;
    }

    return [...bucketMap.entries()]
      .map(([time, v]) => ({ time, ...v }))
      .sort((a, b) => a.time - b.time);
  }, [metricsData, queue]);

  const chartTickInterval = Math.max(1, Math.floor(overviewChartData.length / 10));

  function formatMetricsXTick(t: number): string {
    const d = new Date(t);
    if (metricsHours <= 24) {
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    } else if (metricsHours <= 168) {
      return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", hour12: true });
    }
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading queue data...
      </div>
    );
  }

  if (error || metricsData?.error) {
    return (
      <div className="flex h-64 items-center justify-center text-red-400">
        Failed to load queue data. Check DATABASE_URL and BUILDKITE_AGENT_TOKEN.
      </div>
    );
  }

  const allLatest = metricsData?.latest ?? [];
  const filtered = queue ? allLatest.filter((q) => q.queue === queue) : allLatest;
  const totalAgents = filtered.reduce((s, q) => s + q.agents_total, 0);
  const busyAgents = filtered.reduce((s, q) => s + q.agents_busy, 0);
  const idleAgents = filtered.reduce((s, q) => s + q.agents_idle, 0);
  const waitingJobs = filtered.reduce((s, q) => s + effectiveWaiting(q.queue, q.jobs_scheduled, q.jobs_waiting), 0);
  const runningJobs = filtered.reduce((s, q) => s + q.jobs_running, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">Queue Metrics</h1>
        <div className="flex gap-3">
          <SearchableSelect
            label="Queue"
            value={queue}
            onChange={setQueue}
            options={metricsQueuesForFilter}
          />
          <div className="flex gap-1 rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700">
            {METRICS_HOURS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setMetricsHours(opt.value)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  metricsHours === opt.value
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
        <StatCard
          label="Total Agents"
          value={totalAgents}
          detail={`${busyAgents} busy / ${idleAgents} idle`}
        />
        <StatCard
          label="Waiting Jobs"
          value={waitingJobs}
          color={waitingJobs > 0 ? "yellow" : "default"}
        />
        <StatCard
          label="Running Jobs"
          value={runningJobs}
        />
        {(() => {
          const withWait = filtered.filter((q) => q.p90_wait_secs != null);
          if (withWait.length === 0) return <StatCard label="P90 Wait" value="—" />;
          const worst = withWait.reduce((a, b) => (a.p90_wait_secs! > b.p90_wait_secs! ? a : b));
          const secs = Math.round(worst.p90_wait_secs!);
          return (
            <StatCard
              label="P90 Wait"
              value={formatDuration(secs)}
              detail={queue ? undefined : worst.queue}
              color={secs > 1800 ? "red" : secs > 600 ? "yellow" : "default"}
            />
          );
        })()}
      </div>

      {/* Queue Overview Chart */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="mb-4 text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Jobs &amp; Agents{queue ? ` — ${queue}` : ""}
        </h3>
        <QueueOverviewChart
          data={overviewChartData}
          formatXTick={formatMetricsXTick}
          tickInterval={chartTickInterval}
        />
      </div>

      {/* Waiting Builds */}
      {waitingBuildsData && waitingBuildsData.builds.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
              Top Builds Waiting — {queue}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="px-5 py-2.5 font-medium">Build</th>
                  <th className="px-5 py-2.5 font-medium">Author</th>
                  <th className="px-5 py-2.5 font-medium">Waiting Jobs</th>
                  <th className="px-5 py-2.5 font-medium">Max Wait</th>
                </tr>
              </thead>
              <tbody>
                {waitingBuildsData.builds.map((b) => (
                  <tr
                    key={b.build_number}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50"
                  >
                    <td className="px-5 py-2.5">
                      <a
                        href={b.build_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        #{b.build_number}
                      </a>
                      <p className="mt-0.5 max-w-xs truncate text-xs text-zinc-400">
                        {b.message}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-5 py-2.5">{b.author}</td>
                    <td className="px-5 py-2.5 font-medium text-yellow-600 dark:text-yellow-400">
                      {b.waiting_jobs} <span className="font-normal text-zinc-400">/ {b.total_jobs}</span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {formatDuration(parseInt(b.max_wait_min, 10) * 60)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Queue Summary Table */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Queue Summary
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                {([
                  ["queue", "Queue"],
                  ["agents", "Agents"],
                  ["running", "Running"],
                  ["idle", "Idle"],
                  ["waiting", "Waiting"],
                  ["p50", "P50 Wait"],
                  ["p90", "P90 Wait"],
                  ["p95", "P95 Wait"],
                ] as const).map(([key, label]) => (
                  <th
                    key={key}
                    className="cursor-pointer select-none px-5 py-2.5 font-medium hover:text-zinc-900 dark:hover:text-zinc-100"
                    onClick={() => {
                      if (sortCol === key) setSortAsc(!sortAsc);
                      else { setSortCol(key); setSortAsc(key === "queue"); }
                    }}
                  >
                    {label}
                    {sortCol === key && (
                      <span className="ml-1">{sortAsc ? "\u25b2" : "\u25bc"}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allLatest
                .filter((q) => q.agents_total > 0 || q.jobs_total > 0)
                .sort((a, b) => {
                  if (sortCol === "waiting") {
                    const aw = effectiveWaiting(a.queue, a.jobs_scheduled, a.jobs_waiting);
                    const bw = effectiveWaiting(b.queue, b.jobs_scheduled, b.jobs_waiting);
                    return sortAsc ? aw - bw : bw - aw;
                  }
                  const colMap = { queue: "queue", agents: "agents_total", running: "jobs_running", idle: "agents_idle", waiting: "jobs_scheduled", p50: "p50_wait_secs", p90: "p90_wait_secs", p95: "p95_wait_secs" } as const;
                  const field = colMap[sortCol];
                  const av = a[field], bv = b[field];
                  const cmp = typeof av === "string" ? av.localeCompare(bv as string) : ((av ?? -1) as number) - ((bv ?? -1) as number);
                  return sortAsc ? cmp : -cmp;
                })
                .map((q) => (
                  <tr
                    key={q.queue}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50"
                  >
                    <td className="px-5 py-2.5 font-medium">{q.queue}</td>
                    <td className={`px-5 py-2.5 ${q.agents_total > 0 ? "text-blue-600 dark:text-blue-400" : ""}`}>{q.agents_total}</td>
                    <td className={`px-5 py-2.5 ${q.jobs_running > 0 ? "text-emerald-600 dark:text-emerald-400" : ""}`}>
                      {q.jobs_running}
                    </td>
                    <td className="px-5 py-2.5">{q.agents_idle}</td>
                    <td className={`px-5 py-2.5 ${effectiveWaiting(q.queue, q.jobs_scheduled, q.jobs_waiting) > 0 ? "font-medium text-yellow-600 dark:text-yellow-400" : ""}`}>
                      {effectiveWaiting(q.queue, q.jobs_scheduled, q.jobs_waiting)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {q.p50_wait_secs != null ? formatDuration(Math.round(q.p50_wait_secs)) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-5 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {q.p90_wait_secs != null ? formatDuration(Math.round(q.p90_wait_secs)) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-5 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {q.p95_wait_secs != null ? formatDuration(Math.round(q.p95_wait_secs)) : "—"}
                    </td>
                  </tr>
                ))}
              {allLatest.filter((q) => q.agents_total > 0 || q.jobs_total > 0).length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-zinc-400">
                    No queue data found
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
