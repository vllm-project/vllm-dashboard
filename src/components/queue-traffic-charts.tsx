"use client";

import { useId } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  QueueActivityRow,
  TrafficHistoryPoint,
} from "@/lib/queue-capacity";
import { formatDuration } from "@/lib/format-duration";

interface QueueTrafficHistoryChartProps {
  data: TrafficHistoryPoint[];
  hours: number;
  metric: "jobs" | "utilization";
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

export interface ActivityDisplayRow extends QueueActivityRow {
  maxInFlight: number | null;
  currentUtilization: number | null;
  currentRunning: number | null;
  currentWaiting: number | null;
  currentWaitP95: number | null;
}

interface QueueActivityHeatmapProps {
  rows: ActivityDisplayRow[];
  hours: number;
  metric?: "wait" | "utilization";
  onSelectQueue: (queue: string) => void;
}

interface QueueWaitHistoryChartProps {
  rows: ActivityDisplayRow[];
  hours: number;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

const COLORS = {
  running: "#3b82f6",
  waiting: "#f59e0b",
  limit: "#a1a1aa",
};

interface HistorySeries {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
}

interface HistoryPoint {
  time: number;
  [key: string]: number | null;
}

interface HistoryChartProps {
  data: HistoryPoint[];
  hours: number;
  metric: "jobs" | "utilization" | "wait";
  series: HistorySeries[];
  hasLimits?: boolean;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

const WAIT_COLORS = [
  "#3b82f6",
  "#f59e0b",
  "#10b981",
  "#a855f7",
  "#f43f5e",
  "#06b6d4",
  "#f97316",
  "#6366f1",
  "#84cc16",
];

const JOB_SERIES: HistorySeries[] = [
  { key: "running", label: "Running", color: COLORS.running },
  { key: "waiting", label: "Waiting", color: COLORS.waiting },
  {
    key: "maxInFlight",
    label: "Max in flight",
    color: COLORS.limit,
    dashed: true,
  },
];
const UTILIZATION_SERIES: HistorySeries[] = [
  { key: "limitUtilization", label: "Utilization", color: COLORS.running },
];

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const compactFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const tooltipTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${numberFormatter.format(value)}%`;
}

function formatCount(value: number | null): string {
  return value === null ? "—" : numberFormatter.format(value);
}

function formatWait(value: number | null): string {
  if (value === null) return "—";
  return value === 0 ? "0s" : formatDuration(value * 1000);
}

function formatTime(time: number, hours: number): string {
  return new Date(time).toLocaleString(
    undefined,
    hours > 24
      ? { month: "short", day: "numeric", hour: "numeric" }
      : { hour: "numeric", minute: "2-digit" },
  );
}

function ChartLegend({ series }: { series: HistorySeries[] }) {
  return (
    <ul
      className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-zinc-500 dark:text-zinc-400"
      aria-label="Chart legend"
    >
      {series.map(({ label, color, dashed }) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className="w-4 border-t-2"
            style={{
              borderColor: color,
              borderStyle: dashed ? "dashed" : "solid",
            }}
            aria-hidden="true"
          />
          {label}
        </li>
      ))}
    </ul>
  );
}

function HistoryTooltip({
  active,
  payload,
  label,
  metric,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{
    name?: string | number;
    value?: unknown;
    color?: string;
  }>;
  label?: unknown;
  metric: HistoryChartProps["metric"];
}) {
  if (!active || !payload?.length) return null;
  const entries = payload.filter(
    (entry): entry is typeof entry & { value: number } =>
      typeof entry.value === "number" && Number.isFinite(entry.value),
  );
  if (!entries.length) return null;

  return (
    <div className="max-w-[280px] rounded-xl border border-zinc-200 bg-white px-3.5 py-3 text-xs shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
      <p className="mb-2.5 font-medium text-zinc-700 dark:text-zinc-200">
        {typeof label === "number"
          ? new Date(label).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          : "Recorded sample"}
      </p>
      <dl className="space-y-2">
        {entries.map((entry) => (
          <div
            key={entry.name}
            className="flex items-center justify-between gap-5"
          >
            <dt className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
                aria-hidden="true"
              />
              {entry.name}
            </dt>
            <dd className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
              {metric === "wait"
                ? formatWait(entry.value)
                : `${numberFormatter.format(entry.value)}${metric === "utilization" ? "%" : ""}`}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function HistoryState({
  loading,
  error,
  metric,
  onRetry,
}: Pick<
  HistoryChartProps,
  "loading" | "error" | "metric" | "onRetry"
>) {
  return (
    <div
      className="flex h-[280px] flex-col items-center justify-center gap-2 px-6 text-center sm:h-[310px]"
      role={error ? "alert" : "status"}
    >
      {loading && !error && (
        <span
          className="mb-2 h-6 w-6 animate-spin rounded-full border-2 border-zinc-200 border-t-blue-500 motion-reduce:animate-none dark:border-zinc-700 dark:border-t-blue-400"
          aria-hidden="true"
        />
      )}
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
        {error
          ? `${metric === "wait" ? "Wait" : "Traffic"} history couldn’t be loaded`
          : loading
            ? `Loading ${metric === "wait" ? "wait" : "traffic"} history…`
            : metric === "wait"
              ? "No reported wait percentiles for this selection"
              : "No recorded history for this selection"}
      </p>
      <p className="max-w-sm text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        {error
          ? "Current queue metrics remain available. Retry to refresh the historical view."
          : loading
            ? "Fetching the selected queues and time range."
            : metric === "wait"
              ? "P95 wait is reported for jobs still waiting. Idle queues and unavailable percentile readings leave gaps."
              : metric === "utilization"
                ? "Utilization needs recorded jobs and a known max-in-flight limit. Try another queue or a longer time range."
                : "Try another queue or a longer time range. Missing samples are never shown as zero traffic."}
      </p>
      {error && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Retry history
        </button>
      )}
    </div>
  );
}

export function QueueTrafficHistoryChart({
  data,
  metric,
  ...props
}: QueueTrafficHistoryChartProps) {
  const hasLimits = data.some((point) => point.maxInFlight != null);
  const series =
    metric === "utilization"
      ? UTILIZATION_SERIES
      : JOB_SERIES.filter(({ key }) => key !== "maxInFlight" || hasLimits);
  return (
    <HistoryChart
      {...props}
      data={data.map((point) => ({ ...point }))}
      metric={metric}
      series={series}
      hasLimits={hasLimits}
    />
  );
}

export function QueueWaitHistoryChart({
  rows,
  ...props
}: QueueWaitHistoryChartProps) {
  const series = rows.map((row, index) => ({
    key: `queue${index}`,
    label: row.queue,
    color: WAIT_COLORS[index % WAIT_COLORS.length],
  }));
  const points = new Map<number, HistoryPoint>();
  rows.forEach((row, index) => {
    row.samples.forEach((sample) => {
      let point = points.get(sample.time);
      if (!point) {
        point = { time: sample.time };
        for (const { key } of series) point[key] = null;
        points.set(sample.time, point);
      }
      point[series[index].key] = sample.waitP95;
    });
  });
  return (
    <HistoryChart
      {...props}
      data={[...points.values()].sort((a, b) => a.time - b.time)}
      metric="wait"
      series={series}
    />
  );
}

function HistoryChart({
  data,
  hours,
  metric,
  series,
  hasLimits = false,
  loading = false,
  error = false,
  onRetry,
}: HistoryChartProps) {
  const captionId = useId();
  const utilization = metric === "utilization";
  const wait = metric === "wait";
  const hasValues = data.some((point) =>
    series.some(({ key }) => point[key] != null),
  );
  const showSampleDots = data.some((point, index) =>
    series.some(
      ({ key }) =>
        point[key] != null &&
        data[index - 1]?.[key] == null &&
        data[index + 1]?.[key] == null,
    ),
  );

  return (
    <figure className="min-w-0" aria-labelledby={captionId} aria-busy={loading}>
      <ChartLegend series={series} />
      {!hasValues ? (
        <HistoryState
          loading={loading}
          error={error}
          metric={metric}
          onRetry={onRetry}
        />
      ) : (
        <>
          {error && (
            <div
              className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-amber-700 dark:text-amber-400"
              role="status"
            >
              <span>Refresh failed. Showing the last available history.</span>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
                >
                  Retry
                </button>
              )}
            </div>
          )}
          <div className="mt-5 h-[280px] w-full sm:h-[310px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <ComposedChart
                data={data}
                margin={{ top: 12, right: 12, bottom: 0, left: 0 }}
                accessibilityLayer
              >
                <CartesianGrid
                  vertical={false}
                  stroke="currentColor"
                  strokeDasharray="3 5"
                  className="text-zinc-200 dark:text-zinc-800"
                />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(time: number) => formatTime(time, hours)}
                  tick={{ fontSize: 10, fill: "#71717a" }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={44}
                  tickCount={6}
                  dy={9}
                  height={38}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "#71717a" }}
                  axisLine={false}
                  tickLine={false}
                  width={wait ? 64 : utilization ? 48 : 38}
                  allowDecimals={utilization || wait}
                  domain={
                    utilization
                      ? [
                          0,
                          (maximum: number) =>
                            Math.max(100, Math.ceil(maximum / 25) * 25),
                        ]
                      : wait
                        ? [0, (maximum: number) => Math.max(1, maximum)]
                        : [0, "auto"]
                  }
                  tickFormatter={(value: number) =>
                    wait
                      ? formatWait(value)
                      : utilization
                        ? `${compactFormatter.format(value)}%`
                        : compactFormatter.format(value)
                  }
                />
                <Tooltip
                  content={<HistoryTooltip metric={metric} />}
                  cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3" }}
                />
                {wait ? (
                  series.map(({ key, label, color }) => (
                    <Line
                      key={key}
                      type="linear"
                      dataKey={key}
                      name={label}
                      stroke={color}
                      strokeWidth={2}
                      dot={showSampleDots ? { r: 2 } : false}
                      activeDot={{ r: 4, strokeWidth: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ))
                ) : utilization ? (
                  <>
                    <ReferenceLine
                      y={100}
                      stroke="#a1a1aa"
                      strokeDasharray="4 4"
                      ifOverflow="extendDomain"
                    />
                    <Line
                      type="linear"
                      dataKey="limitUtilization"
                      name="Utilization"
                      stroke={COLORS.running}
                      strokeWidth={2.25}
                      dot={showSampleDots ? { r: 2 } : false}
                      activeDot={{ r: 4, strokeWidth: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </>
                ) : (
                  <>
                    <Area
                      type="linear"
                      dataKey="running"
                      name="Running"
                      stackId="jobs"
                      stroke={COLORS.running}
                      fill={COLORS.running}
                      fillOpacity={0.18}
                      strokeWidth={1.5}
                      connectNulls={false}
                      dot={showSampleDots ? { r: 2 } : false}
                      isAnimationActive={false}
                    />
                    <Area
                      type="linear"
                      dataKey="waiting"
                      name="Waiting"
                      stackId="jobs"
                      stroke={COLORS.waiting}
                      fill={COLORS.waiting}
                      fillOpacity={0.22}
                      strokeWidth={1.5}
                      connectNulls={false}
                      dot={showSampleDots ? { r: 2 } : false}
                      isAnimationActive={false}
                    />
                    {hasLimits && (
                      <Line
                        type="stepAfter"
                        dataKey="maxInFlight"
                        name="Max in flight"
                        stroke={COLORS.limit}
                        strokeWidth={2}
                        strokeDasharray="6 4"
                        dot={showSampleDots ? { r: 2 } : false}
                        activeDot={{ r: 4 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    )}
                  </>
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
      <figcaption
        id={captionId}
        className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400"
      >
        {wait
          ? "Each line shows one queue’s p95 age of jobs still waiting, on a shared duration scale. Percentiles are never combined across queues."
          : utilization
            ? "Running jobs / max in flight, for queues with known limits. The dashed line marks 100%."
            : hasLimits
              ? "Running and waiting jobs are stacked. The dashed line is max in flight for queues with known limits."
              : "Running and waiting jobs are stacked."}
        {hasValues &&
          (wait
            ? " Gaps indicate no reported percentile, including idle queues. Times are local."
            : " Gaps indicate missing samples. Times are local.")}
      </figcaption>
    </figure>
  );
}

function heatCellClass(utilization: number | null): string {
  if (utilization === null) return "fill-zinc-100 dark:fill-zinc-800";
  if (utilization >= 100) return "fill-rose-500 dark:fill-rose-500";
  if (utilization >= 90) return "fill-amber-400 dark:fill-amber-400";
  if (utilization >= 50) return "fill-blue-500 dark:fill-blue-500";
  if (utilization > 0) return "fill-sky-200 dark:fill-sky-800";
  return "fill-sky-50 dark:fill-sky-950";
}

function waitHeatCellClass(wait: number | null, waiting: number | null): string {
  if (wait === null) {
    return waiting === 0
      ? "fill-emerald-100 dark:fill-emerald-950"
      : "fill-zinc-100 dark:fill-zinc-800";
  }
  if (wait >= 3600) return "fill-rose-500 dark:fill-rose-500";
  if (wait >= 900) return "fill-amber-400 dark:fill-amber-400";
  if (wait >= 300) return "fill-violet-500 dark:fill-violet-500";
  if (wait >= 60) return "fill-blue-400 dark:fill-blue-600";
  return "fill-sky-200 dark:fill-sky-800";
}

function utilizationClass(utilization: number | null): string {
  if (utilization === null) return "text-zinc-400 dark:text-zinc-500";
  if (utilization >= 100) return "text-rose-600 dark:text-rose-400";
  if (utilization >= 90) return "text-amber-700 dark:text-amber-400";
  return "text-zinc-800 dark:text-zinc-200";
}

const HEAT_LEGEND = [
  { value: 0, label: "0%" },
  { value: 1, label: ">0–<50%" },
  { value: 50, label: "50–<90%" },
  { value: 90, label: "90–<100%" },
  { value: 100, label: "100%+" },
  { value: null, label: "No data / unknown limit" },
].map(({ value, label }) => ({ className: heatCellClass(value), label }));

const WAIT_HEAT_LEGEND = [
  { value: 0, waiting: null, label: "0–<1m" },
  { value: 60, waiting: null, label: "1–<5m" },
  { value: 300, waiting: null, label: "5–<15m" },
  { value: 900, waiting: null, label: "15–<60m" },
  { value: 3600, waiting: null, label: "60m+" },
  { value: null, waiting: 0, label: "No jobs waiting" },
  { value: null, waiting: null, label: "No data" },
].map(({ value, waiting, label }) => ({
  className: waitHeatCellClass(value, waiting),
  label,
}));

function waitStatus(wait: number | null, waiting: number | null): string {
  if (wait !== null) return `P95 wait: ${formatWait(wait)}`;
  if (waiting === 0) return "No jobs waiting; no wait percentile reported";
  if (waiting !== null) return "Wait percentile unavailable for waiting jobs";
  return "No recorded sample";
}

function currentWaitLabel(row: ActivityDisplayRow): string {
  if (row.currentWaiting === 0) return "No wait";
  return formatWait(row.currentWaitP95);
}

function currentWaitStatus(row: ActivityDisplayRow): string {
  if (row.currentWaiting === 0) return "No jobs waiting; no current wait percentile";
  if (row.currentWaiting === null) return "Current queue metrics unavailable";
  return waitStatus(row.currentWaitP95, row.currentWaiting);
}

function waitValueClass(wait: number | null): string {
  if (wait === null) return "text-zinc-400 dark:text-zinc-500";
  if (wait >= 3600) return "text-rose-600 dark:text-rose-400";
  if (wait >= 900) return "text-amber-700 dark:text-amber-400";
  return "text-zinc-800 dark:text-zinc-200";
}

function waitCoverageTitle(row: ActivityDisplayRow): string {
  return `${row.waitObservedBuckets} of ${row.expectedBuckets} time buckets report a wait percentile. Wait history coverage also includes known idle buckets. Missing samples and unavailable percentiles for waiting jobs reduce coverage.`;
}

function sampleHeatCellClass(
  sample: QueueActivityRow["samples"][number],
  metric: "wait" | "utilization",
): string {
  return metric === "wait"
    ? waitHeatCellClass(sample.waitP95, sample.waiting)
    : heatCellClass(sample.utilization);
}

function activitySummary(
  row: ActivityDisplayRow,
  metric: "wait" | "utilization",
): string {
  const key = metric === "wait" ? "waitP95" : "utilization";
  const values = row.samples.flatMap((sample) =>
    sample[key] === null ? [] : [sample[key]],
  );
  const coverage = `${row.observedBuckets} of ${row.expectedBuckets} time buckets recorded`;
  if (metric === "wait") {
    return values.length
      ? `${row.queue}: p95 wait ranged from ${formatWait(Math.min(...values))} to ${formatWait(row.peakWaitP95)}. Mean of reported bucket p95s: ${formatWait(row.averageWaitP95)}. ${waitCoverageTitle(row)}`
      : `${row.queue}: no reported wait percentiles. ${waitCoverageTitle(row)}`;
  }
  if (!values.length) {
    return `${row.queue}: ${coverage}. ${row.maxInFlight === null ? "Max-in-flight limit unknown; utilization unavailable." : "No recorded utilization."}`;
  }
  return `${row.queue}: utilization ranged from ${formatPercent(Math.min(...values))} to ${formatPercent(Math.max(...values))}. Average ${formatPercent(row.averageUtilization)}; at or above 90% utilization in ${formatPercent(row.nearLimitPercent)} of recorded buckets. ${coverage}.`;
}

function activityTooltip(
  sample: QueueActivityRow["samples"][number],
  metric: "wait" | "utilization",
): string {
  if (metric === "wait") {
    return `${tooltipTimeFormatter.format(sample.time)}\n${waitStatus(sample.waitP95, sample.waiting)}\nWaiting: ${sample.waiting === null ? "No data" : formatCount(sample.waiting)}`;
  }
  const load =
    sample.utilization === null
      ? sample.running === null
        ? "No recorded sample"
        : "Utilization unavailable: limit unknown"
      : `Utilization: ${formatPercent(sample.utilization)}`;
  return `${tooltipTimeFormatter.format(sample.time)}\n${load}\nRunning: ${formatCount(sample.running)} · Waiting: ${formatCount(sample.waiting)}`;
}

export function QueueActivityHeatmap({
  rows,
  hours,
  metric = "utilization",
  onSelectQueue,
}: QueueActivityHeatmapProps) {
  const captionId = useId();
  const utilization = metric === "utilization";
  const legend = utilization ? HEAT_LEGEND : WAIT_HEAT_LEGEND;
  const timeline = rows.find((row) => row.samples.length > 0)?.samples;
  const firstTime = timeline?.[0]?.time;
  const lastTime = timeline?.[timeline.length - 1]?.time;

  return (
    <figure className="min-w-0" aria-labelledby={captionId}>
      <div className="max-w-full overflow-x-auto overscroll-x-contain">
        <table className="w-full min-w-[760px] table-fixed border-collapse text-sm">
          <caption className="sr-only">
            {utilization ? "Queue utilization" : "P95 wait by queue"} over
            the selected {hours} hours.
          </caption>
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[36%]" />
            <col className="w-[9%]" />
            <col className="w-[10%]" />
            <col className="w-[12%]" />
            <col className="w-[9%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th scope="col" className="pb-3 pr-4 font-medium align-top">
                Queue
              </th>
              <th scope="col" className="pb-3 pr-4 font-medium">
                <span>{utilization ? "Load over time" : "P95 wait over time"}</span>
                {firstTime !== undefined && lastTime !== undefined && (
                  <span className="mt-1 flex justify-between gap-3 text-[10px] font-normal tabular-nums text-zinc-400 dark:text-zinc-500">
                    <span>{formatTime(firstTime, hours)}</span>
                    <span>{formatTime(lastTime, hours)}</span>
                  </span>
                )}
              </th>
              <th
                scope="col"
                className="pb-3 pl-2 text-right font-medium align-top"
                title={
                  utilization
                    ? "Current running jobs / max in flight"
                    : "Current p95 age of jobs still waiting"
                }
              >
                Now
              </th>
              <th
                scope="col"
                className="pb-3 pl-2 text-right font-medium align-top"
                title={
                  utilization
                    ? "Mean utilization across recorded time buckets; missing buckets are excluded"
                    : "Mean of reported bucket p95 wait values; this is not a pooled percentile. Unavailable percentiles are excluded."
                }
              >
                Average
              </th>
              <th
                scope="col"
                className="pb-3 pl-2 text-right font-medium align-top"
                title={
                  utilization
                    ? "Share of recorded time buckets with utilization at or above 90%"
                    : "Maximum reported bucket p95 wait value"
                }
              >
                {utilization ? "Near limit" : "Peak"}
              </th>
              <th
                scope="col"
                className="pb-3 pl-2 text-right font-medium align-top"
                title="Jobs currently waiting for this queue"
              >
                Waiting
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {rows.map((row) => {
              const cellWidth = row.samples.length
                ? 1000 / row.samples.length
                : 1000;
              return (
                <tr key={row.queue} className="group">
                  <th scope="row" className="py-2.5 pr-4 text-left font-normal">
                    <button
                      type="button"
                      onClick={() => onSelectQueue(row.queue)}
                      aria-label={`View history for ${row.queue}`}
                      className="max-w-full break-all text-left text-xs font-medium text-zinc-800 underline-offset-4 hover:text-blue-600 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:text-zinc-200 dark:hover:text-blue-400"
                    >
                      {row.queue}
                    </button>
                    <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
                      {utilization
                        ? row.maxInFlight === null
                          ? "Limit unknown"
                          : `${formatCount(row.maxInFlight)} max in flight`
                        : "P95 waiting age"}
                    </span>
                    {(utilization
                      ? row.coveragePercent < 90
                      : row.waitCoveragePercent < 100) && (
                      <span
                        className="mt-0.5 block text-[10px] leading-4 text-zinc-400 dark:text-zinc-500"
                        title={
                          utilization
                            ? `${row.observedBuckets} of ${row.expectedBuckets} time buckets have recorded data`
                            : waitCoverageTitle(row)
                        }
                      >
                        {utilization
                          ? `${Math.round(row.coveragePercent)}% history coverage`
                          : `${Math.round(row.waitCoveragePercent)}% wait history coverage`}
                      </span>
                    )}
                  </th>
                  <td className="py-2.5 pr-4">
                    <svg
                      className="block h-7 w-full"
                      viewBox="0 0 1000 28"
                      preserveAspectRatio="none"
                      role="img"
                      aria-label={activitySummary(row, metric)}
                    >
                      {row.samples.length ? (
                        row.samples.map((sample, index) => (
                          <rect
                            key={sample.time}
                            x={index * cellWidth}
                            y={0}
                            width={cellWidth - Math.min(2, cellWidth * 0.17)}
                            height={28}
                            rx={Math.min(2, cellWidth * 0.2)}
                            className={sampleHeatCellClass(sample, metric)}
                          >
                            <title>{activityTooltip(sample, metric)}</title>
                          </rect>
                        ))
                      ) : (
                        <rect
                          width={1000}
                          height={28}
                          rx={2}
                          className={heatCellClass(null)}
                        />
                      )}
                    </svg>
                  </td>
                  <td
                    className={`py-2.5 pl-2 text-right text-xs font-medium tabular-nums ${
                      utilization
                        ? utilizationClass(row.currentUtilization)
                        : waitValueClass(row.currentWaitP95)
                    }`}
                    title={
                      utilization
                        ? `${formatCount(row.currentRunning)} running / ${formatCount(row.maxInFlight)} max in flight`
                        : currentWaitStatus(row)
                    }
                  >
                    {utilization
                      ? formatPercent(row.currentUtilization)
                      : currentWaitLabel(row)}
                  </td>
                  <td className="py-2.5 pl-2 text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                    {utilization
                      ? formatPercent(row.averageUtilization)
                      : formatWait(row.averageWaitP95)}
                  </td>
                  <td className="py-2.5 pl-2 text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                    {utilization
                      ? formatPercent(row.nearLimitPercent)
                      : formatWait(row.peakWaitP95)}
                  </td>
                  <td
                    className={`py-2.5 pl-2 text-right text-xs tabular-nums ${(row.currentWaiting ?? 0) > 0 ? "font-medium text-amber-700 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400"}`}
                  >
                    {formatCount(row.currentWaiting)}
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td
                  colSpan={6}
                  className="py-12 text-center text-sm text-zinc-500"
                >
                  No queues match this selection.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ul
        className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-zinc-500 dark:text-zinc-400"
        aria-label={
          utilization ? "Utilization heatmap legend" : "Wait duration heatmap legend"
        }
      >
        {legend.map(({ className, label }) => (
          <li key={label} className="flex items-center gap-1.5">
            <svg width={10} height={10} aria-hidden="true">
              <rect width={10} height={10} rx={2} className={className} />
            </svg>
            {label}
          </li>
        ))}
      </ul>
      <figcaption
        id={captionId}
        className="mt-3 text-xs leading-5 text-zinc-500 dark:text-zinc-400"
      >
        {utilization
          ? "Average is mean utilization across recorded buckets. Near limit is the share of recorded buckets at 90% utilization or higher."
          : "Colors show the p95 age of jobs still waiting on the same duration scale for every queue. Average is the mean of reported bucket p95s, not a pooled percentile. Peak is the highest reported bucket p95. Unavailable percentiles are excluded; idle buckets do not imply a zero-second wait."}
        {utilization && " Missing samples are excluded."} Times are local.
      </figcaption>
    </figure>
  );
}
