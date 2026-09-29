"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { SearchableSelect } from "@/components/searchable-select";
import {
  QueueActivityHeatmap,
  QueueTrafficHistoryChart,
  QueueWaitHistoryChart,
  type ActivityDisplayRow,
} from "@/components/queue-traffic-charts";
import { QueueCapacityReference } from "@/components/queue-capacity-reference";
import {
  buildQueueActivity,
  buildTrafficHistory,
  canonicalQueue,
  CUDA_FAMILIES,
  filterQueues,
  getQueueCapacity,
  getQueueWaitP95,
  QUEUE_CAPACITY,
  QUEUE_FAMILIES,
  queueFamily,
  summarizeQueues,
  uniqueQueueReadings,
  type QueueFamily,
  type QueueMetric,
} from "@/lib/queue-capacity";
import { effectiveWaiting } from "@/lib/queue-plugins";
import { formatDuration } from "@/lib/format-duration";

interface LatestMetric extends QueueMetric {
  polled_at: string;
}
interface MetricsResponse {
  query: { hours: number; queue: string | null };
  latest: LatestMetric[];
  snapshots: (QueueMetric & { time_bucket: string })[];
  previewSource?: string;
  receivedAt: number;
}

async function fetchMetrics(url: string): Promise<MetricsResponse> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || body.error)
    throw new Error(body.error ?? "Could not load queue metrics");
  return { ...body, receivedAt: Date.now() };
}

const RANGES = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];
const CONFIGURED_QUEUES = [...new Set(QUEUE_CAPACITY.map((row) => row.queue))];
const ROCM_RANKS = [
  { value: "average", label: "Average load" },
  { value: "current", label: "Current load" },
  { value: "waiting", label: "Waiting jobs" },
  { value: "nearLimit", label: "Time near limit" },
];
const WAIT_RANKS = [
  { value: "average", label: "Average p95 wait" },
  { value: "current", label: "Current p95 wait" },
  { value: "peak", label: "Peak p95 wait" },
  { value: "waiting", label: "Waiting jobs" },
];
const number = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const percentage = (value: number | null) =>
  value === null ? "—" : `${number(value)}%`;
const waitDuration = (seconds: number | null) =>
  seconds === null ? "—" : seconds === 0 ? "0s" : formatDuration(seconds * 1000);
const panel =
  "rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950";

export default function QueueTraffic() {
  const router = useRouter();
  const params = useSearchParams();
  const group = ["rocm", "amd"].includes(params.get("group") ?? "")
    ? "rocm"
    : params.get("group") === "cuda"
      ? "cuda"
      : "all";
  const isAll = group === "all";
  const isRocm = group === "rocm";
  const groupLabel = isAll ? "All queues" : isRocm ? "ROCm queues" : "CUDA queues";
  const requestedHours = Number(params.get("range"));
  const hours = RANGES.some((range) => range.hours === requestedHours)
    ? requestedHours
    : 24;
  const chartMetric =
    isRocm && ["wait", "utilization"].includes(params.get("chart") ?? "")
      ? "wait"
      : "jobs";
  const ranks = isRocm ? ROCM_RANKS : WAIT_RANKS;
  const rank = ranks.some((option) => option.value === params.get("rank"))
    ? params.get("rank")!
    : "average";
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const current = useSWR<MetricsResponse>(
    "/api/metrics?hours=1&v=3",
    fetchMetrics,
    { refreshInterval: 300_000 },
  );
  const allLatest = uniqueQueueReadings(current.data?.latest ?? []).map(
    (row) => ({
      ...row,
      queue: canonicalQueue(row.queue),
    }),
  );
  const groupQueues = filterQueues(
    [...new Set([...allLatest.map((row) => row.queue), ...CONFIGURED_QUEUES])].map(
      (queue) => ({ queue }),
    ),
    group,
  );
  const familyOptions = [
    ...new Set([
      ...(isAll ? QUEUE_FAMILIES : isRocm ? [] : CUDA_FAMILIES),
      ...groupQueues.map((row) => queueFamily(row.queue)),
    ]),
  ].sort();
  const requestedFamily = params.get("family") as QueueFamily;
  const family = familyOptions.includes(requestedFamily)
    ? requestedFamily
    : "all";
  const queueOptions = filterQueues(groupQueues, group, family)
    .map((row) => row.queue)
    .sort();
  const requestedQueue = canonicalQueue(params.get("queue") ?? "");
  const queue = filterQueues([{ queue: requestedQueue }], group, family).length
    ? requestedQueue
    : "";
  const historical = useSWR<MetricsResponse>(
    `/api/metrics?hours=${hours}${queue ? `&queue=${encodeURIComponent(queue)}` : ""}&v=3`,
    fetchMetrics,
    { refreshInterval: 300_000, keepPreviousData: true },
  );

  function navigate(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    next.set("view", "traffic");
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.replace(`/queue?${next}`, { scroll: false });
  }
  function refresh() {
    void Promise.all([current.mutate(), historical.mutate()]);
  }
  function selectQueue(value: string) {
    navigate({ queue: value });
  }

  const selectedRows = filterQueues(allLatest, group, family).filter(
    (row) => !queue || row.queue === queue,
  );
  const observationTime = Math.max(now, current.data?.receivedAt ?? 0);
  const freshRows = selectedRows.filter((row) => {
    const age = observationTime - Date.parse(row.polled_at);
    return Number.isFinite(age) && age <= 600_000 && age >= -60_000;
  });
  const summary = summarizeQueues(freshRows);
  const hasReadings = freshRows.length > 0;
  const configured = filterQueues(
    CONFIGURED_QUEUES.map((queue) => ({ queue })),
    group,
    family,
  ).filter((row) => !queue || row.queue === queue);
  const missing = configured.filter(
    (row) => !freshRows.some((latest) => latest.queue === row.queue),
  );
  const staleCount = selectedRows.length - freshRows.length;
  const oldestSample = hasReadings
    ? Math.min(...freshRows.map((row) => Date.parse(row.polled_at)))
    : null;
  const historyMatches =
    historical.data?.query.hours === hours &&
    historical.data?.query.queue === (queue || null);
  const snapshots = historyMatches
    ? filterQueues(
        historical.data!.snapshots.map((row) => ({
          ...row,
          queue: canonicalQueue(row.queue),
        })),
        group,
        family,
      ).filter((row) => !queue || row.queue === queue)
    : [];
  const expectedQueues = [
    ...new Set([
      ...selectedRows.map((row) => row.queue),
      ...configured.map((row) => row.queue),
      ...snapshots.map((row) => row.queue),
    ]),
  ];
  const selectableQueues = [
    ...new Set([
      ...queueOptions,
      ...snapshots.map((row) => row.queue),
      ...(queue ? [queue] : []),
    ]),
  ].sort();
  const history = buildTrafficHistory(snapshots, hours, expectedQueues);
  const freshByQueue = new Map(freshRows.map((row) => [row.queue, row]));
  // The latest endpoint can backfill percentiles; use the matching raw sample.
  const waitSamplesByQueue = new Map(
    uniqueQueueReadings(current.data?.snapshots ?? []).map((row) => [
      canonicalQueue(row.queue),
      row,
    ]),
  );
  const activity: ActivityDisplayRow[] = buildQueueActivity(
    snapshots,
    hours,
    expectedQueues,
    now,
  ).map((row) => {
    const latest = freshByQueue.get(row.queue);
    const capacity = getQueueCapacity(row.queue);
    const currentWaiting = latest
      ? effectiveWaiting(row.queue, latest.jobs_scheduled, latest.jobs_waiting)
      : null;
    const waitSample = waitSamplesByQueue.get(row.queue);
    return {
      ...row,
      maxInFlight: capacity?.maxInFlight ?? null,
      currentUtilization:
        latest && capacity
          ? (latest.jobs_running / capacity.maxInFlight) * 100
          : null,
      currentRunning: latest?.jobs_running ?? null,
      currentWaiting,
      currentWaitP95:
        latest &&
        (currentWaiting ?? 0) > 0 &&
        waitSample &&
        Date.parse(waitSample.time_bucket) === Date.parse(latest.polled_at)
          ? getQueueWaitP95(waitSample)
          : null,
    };
  });
  const ranked = [...activity].sort((a, b) => {
    const field =
      rank === "current"
        ? isRocm
          ? "currentUtilization"
          : "currentWaitP95"
        : rank === "waiting"
          ? "currentWaiting"
          : rank === "peak"
            ? "peakWaitP95"
            : rank === "nearLimit"
              ? "nearLimitPercent"
              : isRocm
                ? "averageUtilization"
                : "averageWaitP95";
    return (
      (b[field] ?? -1) - (a[field] ?? -1) ||
      (b.currentWaiting ?? -1) - (a.currentWaiting ?? -1) ||
      a.queue.localeCompare(b.queue)
    );
  });
  const averageField = isRocm ? "averageUtilization" : "averageWaitP95";
  const busiest = [...activity]
    .filter((row) => row[averageField] !== null)
    .sort((a, b) => b[averageField]! - a[averageField]!)[0];
  const backlog = [...activity]
    .filter((row) => (row.currentWaiting ?? 0) > 0)
    .sort((a, b) => b.currentWaiting! - a.currentWaiting!)[0];
  const longestWait = [...activity]
    .filter((row) => row.currentWaitP95 !== null)
    .sort((a, b) => b.currentWaitP95! - a.currentWaitP95!)[0];
  const unknownWaitCount = activity.filter(
    (row) => (row.currentWaiting ?? 0) > 0 && row.currentWaitP95 === null,
  ).length;
  const highlight = isRocm ? backlog : longestWait ?? backlog;
  const displayed = showAll ? ranked : ranked.slice(0, 20);
  const waitChartCandidates = isAll
    ? ranked.filter((row) => row.waitObservedBuckets > 0)
    : activity;
  const waitChartRows = isAll ? waitChartCandidates.slice(0, 10) : activity;
  const selection = queue || (family !== "all" ? family : groupLabel);
  const rangeLabel = RANGES.find((range) => range.hours === hours)!.label;
  const refreshing = current.isValidating || historical.isValidating;
  const historyPending = !historyMatches && !historical.error;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Queue traffic</h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            Find busy queues, sustained pressure, and work waiting for capacity.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span
            className={`h-2 w-2 rounded-full ${hasReadings ? "bg-emerald-500" : "bg-zinc-400"}`}
          />
          <span>
            {oldestSample
              ? `Sampled ${new Date(oldestSample).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Awaiting queue samples"}
          </span>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="rounded-lg border border-zinc-200 px-3 py-2 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      {(current.data?.previewSource || historical.data?.previewSource) && (
        <p className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
          Local preview · live public Buildkite snapshots via ci.vllm.ai ·
          refreshes every 5 minutes
        </p>
      )}
      <div className={`${panel} flex flex-wrap items-end gap-4 p-4`}>
        <div>
          <span className="mb-1 block text-xs font-medium text-zinc-500">
            Queue group
          </span>
          <div className="inline-flex min-h-10 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
            {(
              [
                ["all", "All queues"],
                ["cuda", "CUDA"],
                ["rocm", "ROCm"],
              ] as const
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                aria-pressed={group === key}
                onClick={() =>
                  navigate({
                    group: key === "all" ? null : key,
                    family: null,
                    queue: null,
                    chart: null,
                    rank: null,
                  })
                }
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${group === key ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white" : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <SearchableSelect
          label="Hardware family"
          value={family === "all" ? "" : family}
          allLabel="All hardware"
          options={familyOptions}
          onChange={(value) => navigate({ family: value, queue: null })}
        />
        <SearchableSelect
          label="Queue"
          value={queue}
          allLabel={isAll ? "All queues" : `All ${groupLabel}`}
          options={selectableQueues}
          onChange={selectQueue}
        />
        <div className="sm:ml-auto">
          <span className="mb-1 block text-xs font-medium text-zinc-500">
            History
          </span>
          <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
            {RANGES.map((range) => (
              <button
                type="button"
                key={range.hours}
                aria-pressed={hours === range.hours}
                onClick={() => navigate({ range: String(range.hours) })}
                className={`min-h-8 rounded-md px-3 text-xs font-medium ${hours === range.hours ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white" : "text-zinc-500"}`}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {current.error && (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
        >
          Current queue readings could not be refreshed.{" "}
          {current.data
            ? "Showing the last fetched readings."
            : "Retry to load current traffic."}{" "}
          <button
            type="button"
            onClick={refresh}
            className="ml-2 font-medium underline"
          >
            Retry
          </button>
        </div>
      )}
      {current.isLoading && !current.data ? (
        <div
          className={`${panel} p-12 text-center text-sm text-zinc-500`}
          role="status"
        >
          Loading current queue traffic…
        </div>
      ) : (
        <>
          {(staleCount > 0 || missing.length > 0) && (
            <p
              role="status"
              className="text-xs text-amber-700 dark:text-amber-400"
            >
              {staleCount > 0 &&
                `${staleCount} readings are over 10 minutes old. `}
              {missing.length > 0 &&
                `${missing.length} configured queues have no fresh reading. `}
              Current totals use fresh readings only.
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <div className={`${panel} p-5`}>
              <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                {isRocm ? "Capacity in use" : "Longest queue wait · p95"}
              </h2>
              <p className="mt-3 text-4xl font-semibold tracking-tight tabular-nums text-violet-600 dark:text-violet-400">
                {isRocm
                  ? percentage(summary.jobLimitUtilization)
                  : waitDuration(longestWait?.currentWaitP95 ?? null)}
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                {isRocm
                  ? summary.knownQueueCount > 0
                    ? `${number(summary.knownRunning)} running / ${number(summary.maxInFlight)} max in flight`
                    : "No fresh readings with configured limits"
                  : longestWait
                    ? longestWait.queue
                    : hasReadings
                      ? summary.waiting === 0
                        ? "No jobs waiting"
                        : "Wait time unavailable for queued jobs"
                      : "No fresh queue readings"}
              </p>
              {isRocm ? (
                <>
                  <div
                    className="my-3 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded-full bg-violet-500"
                      style={{
                        width: `${Math.min(100, Math.max(0, summary.jobLimitUtilization ?? 0))}%`,
                      }}
                    />
                  </div>
                  <p className="text-xs text-zinc-500">
                    Running jobs ÷ configured limit across {summary.knownQueueCount}{" "}
                    observed queues.
                  </p>
                </>
              ) : (
                <p className="mt-6 text-xs text-zinc-500">
                  Highest reported p95 among the selected queues.
                </p>
              )}
            </div>
            <div className={`${panel} p-5`}>
              <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                Waiting jobs
              </h2>
              <p
                className={`mt-3 text-4xl font-semibold tracking-tight tabular-nums ${summary.waiting > 0 ? "text-amber-600 dark:text-amber-400" : "text-zinc-900 dark:text-zinc-100"}`}
              >
                {hasReadings ? number(summary.waiting) : "—"}
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                {hasReadings
                  ? `${summary.waitingQueueCount} queues with work waiting`
                  : "No fresh queue readings"}
              </p>
              <p className="mt-6 text-xs text-zinc-500">
                {hasReadings
                  ? `${number(summary.running)} jobs running across this selection.`
                  : "Waiting is unknown until a reading arrives."}
              </p>
            </div>
            <div className={`${panel} p-5`}>
              <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                {isRocm ? "Queues near limit" : "Queues with waiting jobs"}
              </h2>
              <p
                className={`mt-3 text-4xl font-semibold tracking-tight tabular-nums ${(isRocm ? summary.nearLimitQueueCount : summary.waitingQueueCount) > 0 ? "text-amber-600 dark:text-amber-400" : "text-zinc-900 dark:text-zinc-100"}`}
              >
                {isRocm
                  ? summary.knownQueueCount > 0
                    ? summary.nearLimitQueueCount
                    : "—"
                  : hasReadings
                    ? summary.waitingQueueCount
                    : "—"}
                {(isRocm ? summary.knownQueueCount > 0 : hasReadings) && (
                  <span className="ml-2 text-lg font-normal text-zinc-400">
                    / {isRocm ? summary.knownQueueCount : summary.queueCount}
                  </span>
                )}
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                {isRocm
                  ? "Currently using at least 90% of max in flight"
                  : "Queues with at least one job waiting now"}
              </p>
              <button
                type="button"
                onClick={() => navigate({ rank: isRocm ? "current" : "waiting" })}
                className="mt-5 text-xs font-medium text-violet-600 hover:underline dark:text-violet-400"
              >
                {isRocm ? "Compare current queue load ↓" : "Compare waiting work ↓"}
              </button>
            </div>
          </div>
          {isRocm && summary.unknownQueueCount > 0 && (
            <p className="text-xs text-zinc-500">
              {summary.unknownQueueCount} observed queues have no configured
              limit. Their jobs are counted, but their capacity use and
              near-limit history are unknown.
            </p>
          )}
          {!isRocm && (
            <p className="text-xs text-zinc-500">
              P95 is the wait age at the 95th percentile of jobs still queued,
              measured since they became runnable.
              {unknownWaitCount > 0 &&
                ` ${unknownWaitCount} ${unknownWaitCount === 1 ? "queue has" : "queues have"} waiting jobs but no reported wait time in the latest sample.`}
            </p>
          )}
        </>
      )}

      {(highlight || (busiest && busiest[averageField]! > 0)) && (
        <div className="rounded-lg border-l-2 border-violet-400 bg-violet-50/70 px-4 py-3 text-sm leading-relaxed text-zinc-600 dark:bg-violet-950/20 dark:text-zinc-300">
          {highlight ? (
            <>
              <button
                type="button"
                onClick={() => selectQueue(highlight.queue)}
                className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
              >
                {highlight.queue}
              </button>{" "}
              {isRocm ? (
                <>
                  has {number(highlight.currentWaiting!)} of {number(summary.waiting)}{" "}
                  waiting jobs
                  {highlight.currentUtilization === null
                    ? ". Its max-in-flight limit is not configured."
                    : ` and is using ${percentage(highlight.currentUtilization)} of its ${number(highlight.maxInFlight!)}-job limit.`}
                </>
              ) : highlight.currentWaitP95 !== null ? (
                <>
                  has the longest reported p95 wait:{" "}
                  <strong>{waitDuration(highlight.currentWaitP95)}</strong>, with{" "}
                  {number(highlight.currentWaiting!)} jobs waiting.
                </>
              ) : (
                <>
                  has {number(highlight.currentWaiting!)} jobs waiting; its wait
                  time is unavailable in the latest sample.
                </>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => selectQueue(busiest!.queue)}
                className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
              >
                {busiest!.queue}
              </button>{" "}
              {isRocm ? (
                <>
                  had the highest average recorded load over {rangeLabel}:{" "}
                  <strong>{percentage(busiest!.averageUtilization)}</strong> of its
                  limit.
                  {busiest!.nearLimitPercent! > 0 &&
                    ` It was near its limit in ${percentage(busiest!.nearLimitPercent)} of observed buckets.`}
                </>
              ) : (
                <>
                  had the highest average reported p95 wait over {rangeLabel}:{" "}
                  <strong>{waitDuration(busiest!.averageWaitP95)}</strong>.
                </>
              )}
              {(isRocm ? busiest!.coveragePercent : busiest!.waitCoveragePercent) < 90 &&
                ` History coverage: ${percentage(isRocm ? busiest!.coveragePercent : busiest!.waitCoveragePercent)}.`}
            </>
          )}
        </div>
      )}

      <section className={`${panel} min-w-0 p-4 sm:p-5`}>
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">
              {isRocm && chartMetric === "jobs"
                ? "Traffic & capacity over time"
                : "Queue wait time over time · p95"}
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              {selection} ·{" "}
              {hours <= 6
                ? "5-minute samples"
                : hours <= 24
                  ? "15-minute averages"
                  : hours <= 168
                    ? "Hourly averages"
                    : "6-hour averages"}
            </p>
            {isAll && waitChartCandidates.length > 10 && (
              <p className="mt-1 text-xs text-zinc-500">
                Showing the top 10 queues with wait history by{" "}
                {ranks.find((option) => option.value === rank)!.label.toLowerCase()}.
                Use the filters to focus on a queue or hardware family.
              </p>
            )}
          </div>
          {isRocm && (
            <div className="flex rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
              {(["jobs", "wait"] as const).map((metric) => (
                <button
                  type="button"
                  key={metric}
                  aria-pressed={chartMetric === metric}
                  onClick={() =>
                    navigate({ chart: metric === "jobs" ? null : metric })
                  }
                  className={`rounded-md px-3 py-1.5 text-xs font-medium ${chartMetric === metric ? "bg-white shadow-sm dark:bg-zinc-700" : "text-zinc-500"}`}
                >
                  {metric === "jobs" ? "Jobs" : "Wait time"}
                </button>
              ))}
            </div>
          )}
        </div>
        {isRocm && chartMetric === "jobs" ? (
          <QueueTrafficHistoryChart
            data={history}
            hours={hours}
            metric="jobs"
            loading={historyPending}
            error={Boolean(historical.error)}
            onRetry={() => void historical.mutate()}
          />
        ) : (
          <QueueWaitHistoryChart
            rows={[...waitChartRows].sort((a, b) => a.queue.localeCompare(b.queue))}
            hours={hours}
            loading={historyPending}
            error={Boolean(historical.error)}
            onRetry={() => void historical.mutate()}
          />
        )}
      </section>

      <section className={panel}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div>
            <h2 className="text-sm font-semibold">
              {isRocm ? "Queue activity" : "Queue wait times"}{" "}
              <span className="ml-1 text-zinc-400">{activity.length}</span>
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              {selection} · {isRocm
                ? "compare sustained load with short spikes over"
                : "compare sustained waits with short spikes over"}{" "}
              {rangeLabel}
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-500">
            Rank by
            <select
              value={rank}
              onChange={(event) => navigate({ rank: event.target.value })}
              className="rounded-md border border-zinc-200 bg-white px-2 py-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
            >
              {ranks.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {historyPending && (
          <p role="status" className="px-5 pt-4 text-xs text-zinc-500">
            Loading history. Current readings remain available.
          </p>
        )}
        {historical.error && (
          <p
            role="alert"
            className="px-5 pt-4 text-xs text-amber-600 dark:text-amber-400"
          >
            History could not be refreshed.{" "}
            {historyMatches
              ? "Showing the last fetched history."
              : "Historical load is unavailable for this range."}{" "}
            <button
              type="button"
              onClick={() => void historical.mutate()}
              className="underline"
            >
              Retry
            </button>
          </p>
        )}
        <div className="px-4 py-4 sm:px-5">
          {current.data ||
          historical.data ||
          current.error ||
          historical.error ? (
            <QueueActivityHeatmap
              rows={displayed}
              hours={hours}
              metric={isRocm ? "utilization" : "wait"}
              onSelectQueue={selectQueue}
            />
          ) : (
            <p role="status" className="py-8 text-center text-sm text-zinc-500">
              Loading queue activity…
            </p>
          )}
        </div>
        {ranked.length > 20 && (
          <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3 text-xs text-zinc-500 dark:border-zinc-800">
            <span>
              Showing {displayed.length} of {ranked.length} queues
            </span>
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              className="font-medium text-violet-600 hover:underline dark:text-violet-400"
            >
              {showAll ? "Show top 20" : `Show all ${ranked.length} queues`}
            </button>
          </div>
        )}
        {queue && (
          <div className="border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <Link
              href={`/queue?${new URLSearchParams({ view: "details", queue, range: String(hours) })}`}
              className="text-xs font-medium text-violet-600 hover:underline dark:text-violet-400"
            >
              Open {queue} job details →
            </Link>
          </div>
        )}
      </section>
      {isRocm && (
        <QueueCapacityReference group={group} family={family} queue={queue} />
      )}
    </div>
  );
}
