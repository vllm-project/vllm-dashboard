"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { StatCard } from "@/components/stat-card";
import { SearchableSelect } from "@/components/searchable-select";
import { QueueOverviewChart } from "@/components/queue-overview-chart";
import { QueueWaitingJobs, useQueueWaitingJobs } from "@/components/queue-waiting-jobs";
import { effectiveWaiting } from "@/lib/queue-plugins";
import {
  DEFAULT_QUEUE_RANGE_HOURS,
  parseQueueRangeParam,
  pickDefaultQueue,
} from "@/lib/queue-default";

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T & { error?: string };

  if (!response.ok || body.error) {
    throw new Error(body.error ?? `Request failed with status ${response.status}`);
  }

  return body;
}

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
  p99_wait_secs: number | null;
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
  p99_wait_secs: number | null;
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
  query: {
    hours: number;
    queue: string | null;
  };
  snapshots: MetricsSnapshot[];
  queues: string[];
  latest: MetricsLatest[];
}

const METRICS_HOURS_OPTIONS = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "14d", value: 14 * 24 },
  { label: "30d", value: 30 * 24 },
  { label: "90d", value: 90 * 24 },
];

const METRICS_HOURS_VALUES = METRICS_HOURS_OPTIONS.map((opt) => opt.value);

function formatMetricsRange(hours: number): string {
  return hours <= 24 ? `${hours}h` : `${hours / 24}d`;
}

// Queues whose raw jobs_waiting count is meaningful and should be charted as
// a separate grey bar (in addition to the yellow scheduled "Waiting" bar).
const RAW_WAITING_QUEUES = new Set(["mithril-h100-pool"]);

export default function QueueContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // The URL is the source of truth for the selected queue and range. No
  // `queue` param means "pick the busiest queue once the summary loads".
  const queueParam = searchParams.get("queue");
  const queue = queueParam ?? "";
  const metricsHours =
    parseQueueRangeParam(searchParams.get("range"), METRICS_HOURS_VALUES) ??
    DEFAULT_QUEUE_RANGE_HOURS;
  const [sortCol, setSortCol] = useState<"queue" | "agents" | "running" | "idle" | "waiting" | "p50" | "p90" | "p95" | "p99">("waiting");
  const [sortAsc, setSortAsc] = useState(false);
  const metricsRef = useRef<HTMLDivElement>(null);

  function navigate(nextQueue: string, nextHours: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextQueue) params.set("queue", nextQueue);
    else params.delete("queue");
    params.set("range", String(nextHours));
    router.replace(`/queue?${params.toString()}`, { scroll: false });
  }

  function selectQueue(nextQueue: string) {
    navigate(nextQueue, metricsHours);
    metricsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // With no queue selected, read the summary (cheap, unfiltered) first and
  // then replace the URL with the busiest queue.
  const needsDefaultQueue = queueParam === null;
  const { data: summaryData, error: summaryError } = useSWR<MetricsResponse>(
    needsDefaultQueue ? "/api/metrics?hours=1&v=3" : null,
    fetchJson,
  );

  useEffect(() => {
    if (!needsDefaultQueue) return;
    if (!summaryData && !summaryError) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("queue", pickDefaultQueue(summaryData?.latest ?? []));
    router.replace(`/queue?${params.toString()}`, { scroll: false });
  }, [needsDefaultQueue, summaryData, summaryError, searchParams, router]);

  const metricsUrl = needsDefaultQueue
    ? null
    : `/api/metrics?hours=${metricsHours}${queue ? `&queue=${encodeURIComponent(queue)}` : ""}&v=3`;
  const {
    data: metricsData,
    error,
    isLoading,
    isValidating,
    mutate: refreshMetrics,
  } = useSWR<MetricsResponse>(metricsUrl, fetchJson, {
    refreshInterval: 5 * 60 * 1000,
    keepPreviousData: true,
  });
  const queueJobsQuery = useQueueWaitingJobs(queue);

  const historyMatchesQueue = metricsData?.query.queue === (queue || null);
  const historyMatchesSelection =
    historyMatchesQueue && metricsData?.query.hours === metricsHours;
  const displayedMetricsHours = historyMatchesQueue
    ? (metricsData?.query.hours ?? metricsHours)
    : metricsHours;
  const chartRequestPending =
    !historyMatchesSelection && (isLoading || isValidating || Boolean(metricsData));

  const metricsQueuesForFilter = metricsData?.queues ?? [];

  // Aggregate snapshots into chart data: sum running/scheduled/agents per time bucket.
  // jobs_scheduled is surfaced as the "Waiting" series. Raw jobs_waiting is
  // also tracked but only charted (as a grey bar) for RAW_WAITING_QUEUES.
  const overviewChartData = useMemo(() => {
    if (!historyMatchesQueue) return [];
    const snapshots = metricsData?.snapshots ?? [];

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

    const chartData = [...bucketMap.entries()]
      .map(([time, v]) => ({ time, ...v }))
      .sort((a, b) => a.time - b.time);

    return chartData;
  }, [historyMatchesQueue, metricsData, queue]);

  const chartTickInterval = Math.max(1, Math.floor(overviewChartData.length / 10));

  function formatMetricsXTick(t: number): string {
    const d = new Date(t);
    if (displayedMetricsHours <= 24) {
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    } else if (displayedMetricsHours <= 168) {
      return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", hour12: true });
    }
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  if (needsDefaultQueue || (isLoading && !metricsData)) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading queue data...
      </div>
    );
  }

  if (error && !metricsData) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
        <p>Queue data couldn&apos;t be loaded.</p>
        <button
          type="button"
          onClick={() => void refreshMetrics()}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          Retry
        </button>
      </div>
    );
  }

  // The latest payload always contains every queue, even when history is
  // filtered to one queue, so it remains safe and useful during chart loads.
  const allLatest = metricsData?.latest ?? [];
  const filtered = queue ? allLatest.filter((q) => q.queue === queue) : allLatest;
  const savedTotalAgents = filtered.reduce((sum, metric) => sum + metric.agents_total, 0);
  const savedBusyAgents = filtered.reduce((sum, metric) => sum + metric.agents_busy, 0);
  const savedIdleAgents = filtered.reduce((sum, metric) => sum + metric.agents_idle, 0);
  const savedRunningJobs = filtered.reduce((sum, metric) => sum + metric.jobs_running, 0);
  const savedWaitingJobs = filtered.reduce(
    (sum, metric) => sum + effectiveWaiting(metric.queue, metric.jobs_scheduled, metric.jobs_waiting),
    0,
  );
  const totalAgents = savedTotalAgents;
  const runningJobs = savedRunningJobs;
  const busyAgents = savedBusyAgents;
  const idleAgents = savedIdleAgents;
  const currentWaitingJobs = savedWaitingJobs;
  const waitingJobsDetail = !queue
    ? "Select a queue"
    : queueJobsQuery.error
      ? "Buildkite snapshot · details unavailable"
      : "Buildkite snapshot";

  function waitMetric(
    savedField: "p50_wait_secs" | "p95_wait_secs" | "p99_wait_secs",
  ): { seconds: number | null; detail?: string } {
    const withWait = filtered.filter((metric) => metric[savedField] != null);
    if (withWait.length === 0) return { seconds: null };
    const worst = withWait.reduce((a, b) => (a[savedField]! > b[savedField]! ? a : b));
    return {
      seconds: worst[savedField],
      detail: queue ? "Buildkite snapshot" : worst.queue,
    };
  }

  const p50Wait = waitMetric("p50_wait_secs");
  const p95Wait = waitMetric("p95_wait_secs");
  const p99Wait = waitMetric("p99_wait_secs");

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Queue Metrics</h1>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Buildkite API · refreshes every 5 minutes
          </p>
        </div>
        <div className="flex gap-3">
          <SearchableSelect
            label="Queue"
            value={queue}
            onChange={(nextQueue) => navigate(nextQueue, metricsHours)}
            options={metricsQueuesForFilter}
          />
          <div className="flex gap-1 rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700">
            {METRICS_HOURS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => navigate(queue, opt.value)}
                aria-pressed={metricsHours === opt.value}
                className={`min-h-11 min-w-11 rounded px-2 text-xs font-medium transition-colors active:scale-[0.97] sm:min-h-10 ${
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
      <div ref={metricsRef} className="grid scroll-mt-20 grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Total Agents"
          value={totalAgents}
          detail={`${busyAgents} busy / ${idleAgents} idle`}
        />
        <StatCard
          label="Waiting Jobs"
          value={currentWaitingJobs}
          detail={waitingJobsDetail}
          color={currentWaitingJobs > 0 ? "yellow" : "default"}
        />
        <StatCard
          label="Running Jobs"
          value={runningJobs}
        />
        {([
          ["P50 Wait", p50Wait],
          ["P95 Wait", p95Wait],
          ["P99 Wait", p99Wait],
        ] as const).map(([label, metric]) => {
          const seconds = metric.seconds == null ? null : Math.round(metric.seconds);
          return (
            <StatCard
              key={label}
              label={label}
              value={seconds == null ? "—" : formatDuration(seconds)}
              detail={metric.detail}
              color={seconds == null ? "default" : seconds > 1800 ? "red" : seconds > 600 ? "yellow" : "default"}
            />
          );
        })}
      </div>

      {/* Queue Overview Chart */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-4 flex min-h-6 flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Jobs &amp; Agents{queue ? ` — ${queue}` : ""}
          </h3>
          {overviewChartData.length > 0 && (isValidating || error) && (
            <div
              className={`flex items-center gap-2 text-xs ${
                error
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-blue-600 dark:text-blue-400"
              }`}
              role="status"
              aria-live="polite"
            >
              {!error && (
                <span
                  className="h-3 w-3 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600 motion-reduce:animate-none dark:border-blue-900 dark:border-t-blue-400"
                  aria-hidden="true"
                />
              )}
              <span>
                {error
                  ? historyMatchesSelection
                    ? "Refresh paused — showing saved data"
                    : `Couldn’t load ${formatMetricsRange(metricsHours)} — showing ${formatMetricsRange(displayedMetricsHours)}`
                  : historyMatchesSelection
                    ? "Updating history"
                    : `Loading ${formatMetricsRange(metricsHours)} — showing ${formatMetricsRange(displayedMetricsHours)}`}
              </span>
              {error && (
                <button
                  type="button"
                  onClick={() => void refreshMetrics()}
                  className="rounded px-1.5 py-1 font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
                >
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
        <div aria-busy={chartRequestPending} aria-live="polite">
          <QueueOverviewChart
            data={overviewChartData}
            formatXTick={formatMetricsXTick}
            tickInterval={chartTickInterval}
            showWaiting={queue ? RAW_WAITING_QUEUES.has(queue) : false}
            state={
              overviewChartData.length > 0
                ? "ready"
                : error
                  ? "error"
                  : chartRequestPending
                    ? "loading"
                    : "ready"
            }
            queue={queue}
            rangeLabel={formatMetricsRange(metricsHours)}
            emptyMessage={`No snapshots recorded for ${queue || "these queues"} in this timeframe.`}
            onRetry={() => void refreshMetrics()}
          />
        </div>
      </div>

      {queue && (
        <QueueWaitingJobs
          queue={queue}
          query={queueJobsQuery}
          waitingCount={savedWaitingJobs}
        />
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
                  ["p99", "P99 Wait"],
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
                  const colMap = { queue: "queue", agents: "agents_total", running: "jobs_running", idle: "agents_idle", waiting: "jobs_scheduled", p50: "p50_wait_secs", p90: "p90_wait_secs", p95: "p95_wait_secs", p99: "p99_wait_secs" } as const;
                  const field = colMap[sortCol];
                  const av = a[field], bv = b[field];
                  const cmp = typeof av === "string" ? av.localeCompare(bv as string) : ((av ?? -1) as number) - ((bv ?? -1) as number);
                  return sortAsc ? cmp : -cmp;
                })
                .map((q) => {
                  const selected = q.queue === queue;
                  return (
                    <tr
                      key={q.queue}
                      tabIndex={0}
                      aria-current={selected ? "true" : undefined}
                      title={`Show ${q.queue} metrics`}
                      onClick={() => selectQueue(q.queue)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectQueue(q.queue);
                        }
                      }}
                      className={`cursor-pointer border-b border-zinc-100 last:border-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:border-zinc-800/50 ${
                        selected
                          ? "bg-zinc-100 dark:bg-zinc-800/60"
                          : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                      }`}
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
                      <td className="whitespace-nowrap px-5 py-2.5 text-zinc-600 dark:text-zinc-400">
                        {q.p99_wait_secs != null ? formatDuration(Math.round(q.p99_wait_secs)) : "—"}
                      </td>
                    </tr>
                  );
                })}
              {allLatest.filter((q) => q.agents_total > 0 || q.jobs_total > 0).length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-8 text-center text-zinc-400">
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
