"use client";

import { memo, useEffect, useId, useMemo, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Dot,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type DotItemDotProps,
} from "recharts";
import type {
  QueueActivityRow,
  TrafficHistoryPoint,
} from "@/lib/queue-capacity";
import { formatQueueWait } from "@/lib/format-duration";

interface QueueTrafficHistoryChartProps {
  data: TrafficHistoryPoint[];
  hours: number;
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
  metric?: ActivityMetric;
  onSelectQueue: (queue: string) => void;
}

type ActivityMetric = "wait" | "waiting" | "utilization";

interface QueueWaitHistoryChartProps {
  rows: ActivityDisplayRow[];
  hours: number;
  metric?: "wait" | "waiting";
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
  metric: "jobs" | "wait" | "waiting";
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
const shortTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const longTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
});
const historyTooltipTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${numberFormatter.format(value)}%`;
}

function formatCount(value: number | null): string {
  return value === null ? "—" : numberFormatter.format(value);
}

function formatTime(time: number, hours: number): string {
  return (hours > 24 ? longTimeFormatter : shortTimeFormatter).format(time);
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
  series,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{
    name?: string | number;
    value?: unknown;
    color?: string;
    dataKey?: string | number;
    payload?: HistoryPoint;
  }>;
  label?: unknown;
  metric: HistoryChartProps["metric"];
  series: HistorySeries[];
}) {
  if (!active || !payload?.length) return null;
  const entries = payload.filter(
    (entry): entry is typeof entry & { value: number } =>
      typeof entry.value === "number" && Number.isFinite(entry.value),
  );
  if (!entries.length) return null;
  const point = payload[0].payload;
  const observed = point?.observedQueueCount;
  const expected = point?.expectedQueueCount;

  return (
    <div className="max-w-[280px] rounded-xl border border-zinc-200 bg-white px-3.5 py-3 text-xs shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
      <p className="mb-2.5 font-medium text-zinc-700 dark:text-zinc-200">
        {typeof label === "number"
          ? historyTooltipTimeFormatter.format(label)
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
                className="w-4 shrink-0 border-t-2"
                style={{
                  borderColor: entry.color,
                  borderStyle: series.find(({ key }) => key === entry.dataKey)
                    ?.dashed
                    ? "dashed"
                    : "solid",
                }}
                aria-hidden="true"
              />
              {entry.name}
            </dt>
            <dd className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
              {metric === "wait"
                ? formatQueueWait(entry.value)
                : numberFormatter.format(entry.value)}
            </dd>
          </div>
        ))}
      </dl>
      {metric === "jobs" &&
        observed != null &&
        expected != null &&
        observed < expected && (
          <p className="mt-2.5 text-zinc-500 dark:text-zinc-400">
            {observed} of {expected} queues reported. Totals include reporting
            queues.
          </p>
        )}
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
  const historyLabel =
    metric === "wait" ? "Wait" : metric === "waiting" ? "Waiting job" : "Traffic";
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
          ? `${historyLabel} history couldn’t be loaded`
          : loading
            ? `Loading ${historyLabel.toLowerCase()} history…`
            : metric === "wait"
              ? "No reported wait percentiles for this selection"
              : metric === "waiting"
                ? "No recorded waiting job counts for this selection"
                : "No recorded history for this selection"}
      </p>
      <p className="max-w-sm text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        {error
          ? "Current queue metrics remain available. Retry to refresh the historical view."
          : loading
            ? "Fetching the selected queues and time range."
            : metric === "wait"
              ? "P95 wait is reported for jobs still waiting. Idle queues and unavailable percentile readings leave gaps."
              : metric === "waiting"
                ? "Try another queue or a longer time range. Missing samples and queues with no available agents leave gaps."
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

export const QueueTrafficHistoryChart = memo(function QueueTrafficHistoryChart({
  data,
  ...props
}: QueueTrafficHistoryChartProps) {
  const { hasLimits, points, series } = useMemo(() => {
    const hasLimits = data.some((point) => point.maxInFlight != null);
    return {
      hasLimits,
      points: data.map((point) => ({ ...point })),
      series: JOB_SERIES.filter(({ key }) => key !== "maxInFlight" || hasLimits),
    };
  }, [data]);
  return (
    <HistoryChart
      {...props}
      data={points}
      metric="jobs"
      series={series}
      hasLimits={hasLimits}
    />
  );
});

export const QueueWaitHistoryChart = memo(function QueueWaitHistoryChart({
  rows,
  metric = "wait",
  ...props
}: QueueWaitHistoryChartProps) {
  const { points, series } = useMemo(() => {
    const series = rows.map((row, index) => ({
      key: `queue${index}`,
      label: row.queue,
      color: WAIT_COLORS[index % WAIT_COLORS.length],
      dashed: Math.floor(index / WAIT_COLORS.length) % 2 === 1,
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
        point[series[index].key] =
          metric === "wait" ? sample.waitP95 : sample.waiting;
      });
    });
    return { points: [...points.values()].sort((a, b) => a.time - b.time), series };
  }, [rows, metric]);
  return (
    <HistoryChart
      {...props}
      data={points}
      metric={metric}
      series={series}
    />
  );
});

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
  const wait = metric === "wait";
  const hasValues = data.some((point) =>
    series.some(({ key }) => point[key] != null),
  );
  const sampleDots = useMemo(() => new Map(series.map(({ key }) => {
    const isolated = new Set(data.flatMap((point, index) =>
      point[key] != null &&
      data[index - 1]?.[key] == null &&
      data[index + 1]?.[key] == null ? [index] : [],
    ));
    const dot = isolated.size === 0 ? false : (props: DotItemDotProps) =>
      isolated.has(props.index) ? (
        <Dot
          cx={props.cx}
          cy={props.cy}
          r={2}
          fill={props.fill}
          fillOpacity={props.fillOpacity}
          stroke={props.stroke}
          strokeOpacity={props.strokeOpacity}
          strokeWidth={props.strokeWidth}
          className="queue-history-isolated-dot"
        />
      ) : null;
    return [key, dot] as const;
  })), [data, series]);

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
                  width={wait ? 64 : 38}
                  allowDecimals={wait}
                  domain={
                    wait
                      ? [0, (maximum: number) => Math.max(1, maximum)]
                      : [0, "auto"]
                  }
                  tickFormatter={(value: number) =>
                    wait
                      ? formatQueueWait(value)
                      : compactFormatter.format(value)
                  }
                />
                <Tooltip
                  content={<HistoryTooltip metric={metric} series={series} />}
                  cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3" }}
                />
                {metric !== "jobs" ? (
                  series.map(({ key, label, color, dashed }) => (
                    <Line
                      key={key}
                      type="linear"
                      dataKey={key}
                      name={label}
                      stroke={color}
                      strokeWidth={2}
                      strokeDasharray={dashed ? "6 4" : undefined}
                      dot={sampleDots.get(key) ?? false}
                      activeDot={{ r: 4, strokeWidth: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ))
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
                      dot={sampleDots.get("running") ?? false}
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
                      dot={sampleDots.get("waiting") ?? false}
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
                        dot={sampleDots.get("maxInFlight") ?? false}
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
          : metric === "waiting"
            ? "Each line shows the number of jobs waiting for one queue."
            : hasLimits
              ? "Running and waiting jobs are stacked. The dashed line is max in flight for queues with known limits."
              : "Running and waiting jobs are stacked."}
        {hasValues &&
          (wait
            ? " Gaps indicate no reported percentile, including idle queues. Times are local."
            : metric === "waiting"
              ? " Gaps indicate missing samples or no available agents. Times are local."
              : " Totals use reporting queues; missing queues are excluded. Gaps indicate no recorded samples. Times are local.")}
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

function waitingHeatCellClass(waiting: number | null): string {
  if (waiting === null) return "fill-zinc-100 dark:fill-zinc-800";
  if (waiting >= 50) return "fill-rose-500 dark:fill-rose-500";
  if (waiting >= 20) return "fill-amber-400 dark:fill-amber-400";
  if (waiting >= 5) return "fill-blue-500 dark:fill-blue-500";
  if (waiting > 0) return "fill-sky-200 dark:fill-sky-800";
  return "fill-emerald-100 dark:fill-emerald-950";
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

const WAITING_HEAT_LEGEND = [
  { value: 0, label: "0 jobs" },
  { value: 1, label: "1–4 jobs" },
  { value: 5, label: "5–19 jobs" },
  { value: 20, label: "20–49 jobs" },
  { value: 50, label: "50+ jobs" },
  { value: null, label: "No data / no agents" },
].map(({ value, label }) => ({ className: waitingHeatCellClass(value), label }));

function waitStatus(wait: number | null, waiting: number | null): string {
  if (wait !== null) return `P95 wait: ${formatQueueWait(wait)}`;
  if (waiting === 0) return "No jobs waiting; no wait percentile reported";
  if (waiting !== null) return "Wait percentile unavailable for waiting jobs";
  return "No recorded sample";
}

function currentWaitLabel(row: ActivityDisplayRow): string {
  if (row.currentWaiting === 0) return "No wait";
  return formatQueueWait(row.currentWaitP95);
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
  metric: ActivityMetric,
): string {
  return metric === "wait"
    ? waitHeatCellClass(sample.waitP95, sample.waiting)
    : metric === "waiting"
      ? waitingHeatCellClass(sample.waiting)
      : heatCellClass(sample.utilization);
}

function activitySummary(
  row: ActivityDisplayRow,
  metric: ActivityMetric,
): string {
  const key = metric === "wait" ? "waitP95" : metric;
  const values = row.samples.flatMap((sample) =>
    sample[key] === null ? [] : [sample[key]],
  );
  const coverage = `${row.observedBuckets} of ${row.expectedBuckets} time buckets recorded`;
  if (metric === "waiting") {
    const waitingCoverage = `${values.length} of ${row.expectedBuckets} time buckets recorded waiting jobs`;
    return values.length
      ? `${row.queue}: waiting jobs ranged from ${formatCount(Math.min(...values))} to ${formatCount(row.peakWaiting)}. Average ${formatCount(row.averageWaiting)}. ${waitingCoverage}.`
      : `${row.queue}: no recorded waiting job counts. ${waitingCoverage}.`;
  }
  if (metric === "wait") {
    return values.length
      ? `${row.queue}: p95 wait ranged from ${formatQueueWait(Math.min(...values))} to ${formatQueueWait(row.peakWaitP95)}. Mean of reported bucket p95s: ${formatQueueWait(row.averageWaitP95)}. ${waitCoverageTitle(row)}`
      : `${row.queue}: no reported wait percentiles. ${waitCoverageTitle(row)}`;
  }
  if (!values.length) {
    return `${row.queue}: ${coverage}. ${row.maxInFlight === null ? "Max-in-flight limit unknown; utilization unavailable." : "No recorded utilization."}`;
  }
  return `${row.queue}: utilization ranged from ${formatPercent(Math.min(...values))} to ${formatPercent(Math.max(...values))}. Average ${formatPercent(row.averageUtilization)}; at or above 90% utilization in ${formatPercent(row.nearLimitPercent)} of recorded buckets. ${coverage}.`;
}

function activityTooltip(
  sample: QueueActivityRow["samples"][number],
  metric: ActivityMetric,
  timeLabel = tooltipTimeFormatter.format(sample.time),
): string {
  if (metric === "wait") {
    return `${timeLabel}\n${waitStatus(sample.waitP95, sample.waiting)}\nWaiting: ${sample.waiting === null ? "No data" : formatCount(sample.waiting)}`;
  }
  if (metric === "waiting") {
    return `${timeLabel}\nWaiting: ${sample.waiting === null ? "No data / no agents" : formatCount(sample.waiting)}\nRunning: ${formatCount(sample.running)}`;
  }
  const load =
    sample.utilization === null
      ? sample.running === null
        ? "No recorded sample"
        : "Utilization unavailable: limit unknown"
      : `Utilization: ${formatPercent(sample.utilization)}`;
  return `${timeLabel}\n${load}\nRunning: ${formatCount(sample.running)} · Waiting: ${formatCount(sample.waiting)}`;
}

const ActivityTimeline = memo(function ActivityTimeline({
  samples,
  metric,
  label,
  rowIndex,
}: {
  samples: QueueActivityRow["samples"];
  metric: ActivityMetric;
  label: string;
  rowIndex: number;
}) {
  const tooltipId = useId();
  const [inspection, setInspection] = useState<{
    index: number;
    left: number;
    top: number;
    above: boolean;
    sample: QueueActivityRow["samples"][number];
    metric: ActivityMetric;
    label: string;
    rowIndex: number;
  } | null>(null);
  const cellWidth = samples.length ? 1000 / samples.length : 1000;
  const cellFillWidth = cellWidth - Math.min(2, cellWidth * 0.17);
  const paths = useMemo(() => {
    const radius = Math.min(2, cellWidth * 0.2);
    const colors = new Map<string, string[]>();
    samples.forEach((sample, index) => {
      const x = index * cellWidth;
      const right = x + cellFillWidth;
      const path = `M${x + radius},0H${right - radius}A${radius},${radius} 0 0 1 ${right},${radius}V${28 - radius}A${radius},${radius} 0 0 1 ${right - radius},28H${x + radius}A${radius},${radius} 0 0 1 ${x},${28 - radius}V${radius}A${radius},${radius} 0 0 1 ${x + radius},0Z`;
      const color = sampleHeatCellClass(sample, metric);
      const cells = colors.get(color) ?? [];
      cells.push(path);
      colors.set(color, cells);
    });
    return [...colors].map(([className, cells]) => ({ className, d: cells.join("") }));
  }, [samples, metric, cellWidth, cellFillWidth]);
  const inspectedSample = inspection &&
    inspection.metric === metric && inspection.label === label &&
    inspection.rowIndex === rowIndex &&
    samples[inspection.index] === inspection.sample
    ? inspection.sample
    : undefined;
  const inspectionVisible = inspectedSample !== undefined;
  useEffect(() => {
    if (!inspectionVisible) return;
    const hide = () => setInspection(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [inspectionVisible]);

  function inspect(index: number, target: SVGSVGElement) {
    if (!samples[index]) return;
    const bounds = target.getBoundingClientRect();
    const x = bounds.left + ((index + 0.5) / samples.length) * bounds.width;
    const left = Math.max(8, Math.min(x - 140, window.innerWidth - 288));
    const above = bounds.top > window.innerHeight / 2;
    const top = above ? bounds.top - 8 : bounds.bottom + 8;
    setInspection((previous) =>
      previous?.index === index && previous.left === left && previous.top === top &&
      previous.above === above && previous.sample === samples[index] &&
      previous.metric === metric && previous.label === label &&
      previous.rowIndex === rowIndex
        ? previous
        : { index, left, top, above, sample: samples[index], metric, label, rowIndex },
    );
  }

  function inspectPointer(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 1000;
    const index = Math.floor(x / cellWidth);
    if (x - index * cellWidth > cellFillWidth) setInspection(null);
    else inspect(index, event.currentTarget);
  }

  return (
    <>
      <svg
        className="block h-7 w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        viewBox="0 0 1000 28"
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        aria-describedby={inspectedSample ? tooltipId : undefined}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape"
        tabIndex={samples.length ? 0 : undefined}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) {
            inspect(samples.length - 1, event.currentTarget);
          }
        }}
        onBlur={() => setInspection(null)}
        onPointerDown={inspectPointer}
        onPointerMove={inspectPointer}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") setInspection(null);
        }}
        onPointerCancel={() => setInspection(null)}
        onKeyDown={(event) => {
          let index = inspection?.index ?? samples.length - 1;
          if (event.key === "ArrowLeft") index -= 1;
          else if (event.key === "ArrowRight") index += 1;
          else if (event.key === "Home") index = 0;
          else if (event.key === "End") index = samples.length - 1;
          else if (event.key === "Escape") {
            event.preventDefault();
            setInspection(null);
            return;
          } else return;
          event.preventDefault();
          inspect(Math.max(0, Math.min(samples.length - 1, index)), event.currentTarget);
        }}
      >
        {samples.length ? paths.map(({ className, d }) => (
          <path key={className} className={className} d={d} />
        )) : (
          <rect width={1000} height={28} rx={2} className={heatCellClass(null)} />
        )}
      </svg>
      {inspection && inspectedSample && createPortal(
        <div
          id={tooltipId}
          role="tooltip"
          aria-live="polite"
          className="pointer-events-none fixed z-[100] w-[280px] max-w-[calc(100vw-16px)] whitespace-pre-line rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs leading-5 text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          style={{
            left: inspection.left,
            top: inspection.top,
            transform: inspection.above ? "translateY(-100%)" : undefined,
          }}
        >
          {activityTooltip(inspectedSample, metric)}
        </div>,
        document.body,
      )}
    </>
  );
});

export const QueueActivityHeatmap = memo(function QueueActivityHeatmap({
  rows,
  hours,
  metric = "utilization",
  onSelectQueue,
}: QueueActivityHeatmapProps) {
  const captionId = useId();
  const utilization = metric === "utilization";
  const waiting = metric === "waiting";
  const legend = utilization
    ? HEAT_LEGEND
    : waiting
      ? WAITING_HEAT_LEGEND
      : WAIT_HEAT_LEGEND;
  const timeline = rows.find((row) => row.samples.length > 0)?.samples;
  const firstTime = timeline?.[0]?.time;
  const lastTime = timeline?.[timeline.length - 1]?.time;

  return (
    <figure className="min-w-0" aria-labelledby={captionId}>
      <div className="max-w-full overflow-x-auto overscroll-x-contain">
        <table className="w-full min-w-[760px] table-fixed border-collapse text-sm">
          <caption className="sr-only">
            {utilization
              ? "Queue utilization"
              : waiting
                ? "Waiting jobs by queue"
                : "P95 wait by queue"}{" "}
            over the selected {hours} hours.
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
                <span>
                  {utilization
                    ? "Load over time"
                    : waiting
                      ? "Waiting jobs over time"
                      : "P95 wait over time"}
                </span>
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
                    : waiting
                      ? "Jobs currently waiting for this queue"
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
                    : waiting
                      ? "Mean waiting jobs across recorded time buckets; missing buckets and buckets with no agents are excluded"
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
                    : waiting
                      ? "Maximum recorded waiting jobs in a time bucket"
                      : "Maximum reported bucket p95 wait value"
                }
              >
                {utilization ? "Near limit" : "Peak"}
              </th>
              <th
                scope="col"
                className="pb-3 pl-2 text-right font-medium align-top"
                title={
                  waiting
                    ? "Jobs currently running for this queue"
                    : "Jobs currently waiting for this queue"
                }
              >
                {waiting ? "Running" : "Waiting"}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {rows.map((row, rowIndex) => {
              const coveragePercent = utilization
                ? row.coveragePercent
                : waiting
                  ? row.waitingCoveragePercent
                  : row.waitCoveragePercent;
              const coverageTitle = utilization
                ? `${row.observedBuckets} of ${row.expectedBuckets} time buckets have recorded data`
                : waiting
                  ? `${row.samples.filter((sample) => sample.waiting !== null).length} of ${row.expectedBuckets} time buckets have recorded waiting jobs. Missing samples and buckets with no agents are excluded.`
                  : waitCoverageTitle(row);
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
                        : waiting
                          ? "Jobs waiting"
                          : "P95 waiting age"}
                    </span>
                    {coveragePercent < (utilization ? 90 : 100) && (
                      <span
                        className="mt-0.5 block text-[10px] leading-4 text-zinc-400 dark:text-zinc-500"
                        title={coverageTitle}
                      >
                        {Math.round(coveragePercent)}%{" "}
                        {metric === "wait" ? "wait " : ""}history coverage
                      </span>
                    )}
                  </th>
                  <td className="py-2.5 pr-4">
                    <ActivityTimeline
                      samples={row.samples}
                      metric={metric}
                      label={activitySummary(row, metric)}
                      rowIndex={rowIndex}
                    />
                  </td>
                  <td
                    className={`py-2.5 pl-2 text-right text-xs font-medium tabular-nums ${
                      utilization
                        ? utilizationClass(row.currentUtilization)
                        : waiting
                          ? (row.currentWaiting ?? 0) > 0
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-zinc-500 dark:text-zinc-400"
                          : waitValueClass(row.currentWaitP95)
                    }`}
                    title={
                      utilization
                        ? `${formatCount(row.currentRunning)} running / ${formatCount(row.maxInFlight)} max in flight`
                        : waiting
                          ? row.currentWaiting === null
                            ? "Current queue metrics unavailable"
                            : `${formatCount(row.currentWaiting)} jobs currently waiting`
                          : currentWaitStatus(row)
                    }
                  >
                    {utilization
                      ? formatPercent(row.currentUtilization)
                      : waiting
                        ? formatCount(row.currentWaiting)
                        : currentWaitLabel(row)}
                  </td>
                  <td className="py-2.5 pl-2 text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                    {utilization
                      ? formatPercent(row.averageUtilization)
                      : waiting
                        ? formatCount(row.averageWaiting)
                        : formatQueueWait(row.averageWaitP95)}
                  </td>
                  <td className="py-2.5 pl-2 text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                    {utilization
                      ? formatPercent(row.nearLimitPercent)
                      : waiting
                        ? formatCount(row.peakWaiting)
                        : formatQueueWait(row.peakWaitP95)}
                  </td>
                  <td
                    className={`py-2.5 pl-2 text-right text-xs tabular-nums ${!waiting && (row.currentWaiting ?? 0) > 0 ? "font-medium text-amber-700 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400"}`}
                  >
                    {formatCount(waiting ? row.currentRunning : row.currentWaiting)}
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
          utilization
            ? "Utilization heatmap legend"
            : waiting
              ? "Waiting jobs heatmap legend"
              : "Wait duration heatmap legend"
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
          : waiting
            ? "Colors show waiting job counts on the same scale for every queue. Average and peak use recorded buckets with available agents; missing samples and buckets with no agents are excluded."
            : "Colors show the p95 age of jobs still waiting on the same duration scale for every queue. Average is the mean of reported bucket p95s, not a pooled percentile. Peak is the highest reported bucket p95. Unavailable percentiles are excluded; idle buckets do not imply a zero-second wait."}
        {utilization && " Missing samples are excluded."} Times are local.
        {" "}Focus a timeline and use arrow keys to inspect individual buckets.
      </figcaption>
    </figure>
  );
});
