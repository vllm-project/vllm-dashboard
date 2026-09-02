"use client";

import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
} from "recharts";

export interface BuildDuration {
  id: string;
  state: string;
  created_at: string;
  started_at: string;
  finished_at: string;
  duration_mins: string;
}

type ChartMode = "overview" | "runs";

const OUTLIER_THRESHOLD_MINS = 6 * 60;

function isOutlier(build: BuildDuration): boolean {
  return (parseInt(build.duration_mins, 10) || 0) >= OUTLIER_THRESHOLD_MINS;
}

interface RunPoint {
  index: number;
  date: string;
  dateShort: string;
  duration: number;
  failed: boolean;
}

interface DailyPoint {
  date: string;
  dateLabel: string;
  p50: number;
  p90: number;
  peak: number;
  total: number;
  passed: number;
  failed: number;
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatDurationRound(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (m === 0) return `${h}h`;
  if (mins <= 120) return `${h}h${m}m`;
  return `${h}h`;
}

function isFailed(state: string): boolean {
  return ["failed", "failing"].includes(state);
}

function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * value;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function OverviewTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: DailyPoint }>;
}) {
  if (!active || !payload?.[0]) return null;
  const point = payload[0].payload;
  return (
    <div className="min-w-44 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-xs shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
      <p className="font-medium text-zinc-900 dark:text-zinc-100">{point.date}</p>
      <dl className="mt-2 space-y-1.5 text-zinc-500 dark:text-zinc-400">
        <div className="flex items-center justify-between gap-6">
          <dt>Typical (P50)</dt>
          <dd className="font-medium tabular-nums text-blue-600 dark:text-blue-400">
            {formatDuration(point.p50)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-6">
          <dt>High (P90)</dt>
          <dd className="font-medium tabular-nums text-amber-600 dark:text-amber-400">
            {formatDuration(point.p90)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-6">
          <dt>Peak</dt>
          <dd className="font-medium tabular-nums text-violet-600 dark:text-violet-400">
            {formatDuration(point.peak)}
          </dd>
        </div>
      </dl>
      <div className="mt-2 flex items-center gap-3 border-t border-zinc-200 pt-2 dark:border-zinc-700">
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          {point.passed} passed
        </span>
        <span className="font-medium text-red-600 dark:text-red-400">
          {point.failed} failed
        </span>
      </div>
    </div>
  );
}

function BuildOutcomeStrip({ data }: { data: DailyPoint[] }) {
  const totals = data.reduce(
    (summary, point) => ({
      passed: summary.passed + point.passed,
      failed: summary.failed + point.failed,
    }),
    { passed: 0, failed: 0 },
  );

  return (
    <div className="mt-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
          Build status by day
        </p>
        <div className="flex items-center gap-3 text-xs tabular-nums">
          <span className="inline-flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full bg-emerald-500"
            />
            {totals.passed} passed
          </span>
          <span className="inline-flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full bg-red-500"
            />
            {totals.failed} failed
          </span>
        </div>
      </div>
      <div className="ml-[46px] mr-3 mt-2">
        <div className="flex h-3 gap-px overflow-hidden rounded-sm bg-zinc-100 dark:bg-zinc-800">
          {data.map((point) => {
            const passedPercent = point.total
              ? (point.passed / point.total) * 100
              : 0;
            return (
              <div
                key={point.date}
                role="img"
                aria-label={`${point.date}: ${point.passed} passed, ${point.failed} failed`}
                title={`${point.date}: ${point.passed} passed, ${point.failed} failed`}
                className="flex min-w-0 flex-1"
              >
                <span
                  aria-hidden="true"
                  className="h-full bg-emerald-500"
                  style={{ width: `${passedPercent}%` }}
                />
                <span
                  aria-hidden="true"
                  className="h-full flex-1 bg-red-500"
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RunTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: RunPoint }>;
}) {
  if (!active || !payload?.[0]) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-xs shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
      <p className={`font-medium ${point.failed ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
        {point.failed ? "Failed" : "Passed"} · {formatDuration(point.duration)}
      </p>
      <p className="mt-1 text-zinc-500 dark:text-zinc-400">{point.date}</p>
    </div>
  );
}

interface BuildChartProps {
  data: BuildDuration[];
  startDate?: string;
  endDate?: string;
  hideOutliers?: boolean;
}

export function BuildChart({ data, startDate, endDate, hideOutliers }: BuildChartProps) {
  const [mode, setMode] = useState<ChartMode>("runs");
  const rangeLabel =
    startDate && endDate ? `${startDate} — ${endDate}` : "All Time";

  const filteredData = useMemo(
    () => (hideOutliers ? data.filter((build) => !isOutlier(build)) : data),
    [data, hideOutliers],
  );

  const runData = useMemo<RunPoint[]>(
    () =>
      filteredData.map((build, index) => {
        const date = new Date(build.created_at);
        return {
          index,
          date: date.toLocaleString(),
          dateShort: date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
          duration: parseInt(build.duration_mins, 10) || 0,
          failed: isFailed(build.state),
        };
      }),
    [filteredData],
  );

  const dailyData = useMemo<DailyPoint[]>(() => {
    const byDay = new Map<string, BuildDuration[]>();
    for (const build of filteredData) {
      const key = build.created_at.slice(0, 10);
      byDay.set(key, [...(byDay.get(key) ?? []), build]);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, builds]) => {
        const durations = builds
          .map((build) => parseInt(build.duration_mins, 10) || 0)
          .sort((a, b) => a - b);
        const parsedDate = new Date(`${date}T12:00:00`);
        return {
          date: parsedDate.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          }),
          dateLabel: parsedDate.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
          p50: percentile(durations, 0.5),
          p90: percentile(durations, 0.9),
          peak: durations[durations.length - 1] ?? 0,
          total: builds.length,
          passed: builds.filter((build) => !isFailed(build.state)).length,
          failed: builds.filter((build) => isFailed(build.state)).length,
        };
      });
  }, [filteredData]);

  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Build Duration · {rangeLabel}
        </h3>
        <div className="flex h-[240px] items-center justify-center text-sm text-zinc-400">
          No build data
        </div>
      </div>
    );
  }

  const maxDuration =
    mode === "overview"
      ? Math.max(...dailyData.map((point) => point.peak), 1)
      : Math.max(...runData.map((point) => point.duration), 1);
  const tickInterval =
    mode === "overview"
      ? Math.max(0, Math.ceil(dailyData.length / 7) - 1)
      : Math.max(1, Math.floor(runData.length / 8));
  const candidates = [5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720];
  let tickStep = candidates[candidates.length - 1];
  for (const candidate of candidates) {
    if (maxDuration / candidate <= 6) {
      tickStep = candidate;
      break;
    }
  }
  const ticks: number[] = [];
  for (let value = 0; value <= maxDuration * 1.1; value += tickStep) {
    ticks.push(value);
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Build Duration
          </h3>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {rangeLabel} · {filteredData.length} builds
            {hideOutliers && filteredData.length !== data.length && (
              <span> ({data.length - filteredData.length} outliers hidden)</span>
            )}
          </p>
        </div>
        <div
          className="inline-flex w-fit rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-900"
          aria-label="Build duration chart mode"
        >
          {([
            ["overview", "Overview"],
            ["runs", "Runs"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              aria-pressed={mode === value}
              className={`min-h-11 rounded-md px-3 text-sm font-medium transition-[background-color,color,transform] active:scale-[0.97] sm:min-h-10 ${
                mode === value
                  ? "bg-white text-zinc-900 shadow-sm ring-1 ring-black/5 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-white/10"
                  : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="h-[320px] sm:h-[360px]">
        <ResponsiveContainer width="100%" height="100%">
          {mode === "overview" ? (
            <LineChart
              data={dailyData}
              margin={{ top: 10, right: 12, bottom: 4, left: 2 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--chart-grid)"
                vertical={false}
              />
              <XAxis
                dataKey="dateLabel"
                interval={tickInterval}
                minTickGap={20}
                stroke="var(--chart-axis)"
                tick={{ fontSize: 11 }}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={formatDurationRound}
                stroke="var(--chart-axis)"
                width={44}
                ticks={ticks}
                domain={[0, ticks[ticks.length - 1] || maxDuration]}
              />
              <Tooltip
                content={<OverviewTooltip />}
                cursor={{
                  stroke: "var(--chart-axis)",
                  strokeDasharray: "3 3",
                }}
              />
              <Legend
                verticalAlign="bottom"
                height={36}
                iconType="circle"
                wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
              />
              <Line
                type="monotone"
                dataKey="p50"
                name="Typical (P50)"
                stroke="#3b82f6"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="p90"
                name="High (P90)"
                stroke="#f59e0b"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="peak"
                name="Peak"
                stroke="#8b5cf6"
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          ) : (
            <BarChart
              data={runData}
              margin={{ top: 10, right: 12, bottom: 4, left: 2 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--chart-grid)"
                vertical={false}
              />
              <XAxis
                dataKey="index"
                tick={{ fontSize: 11 }}
                tickFormatter={(index: number) =>
                  runData[index]?.dateShort ?? ""
                }
                interval={tickInterval}
                minTickGap={20}
                stroke="var(--chart-axis)"
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={formatDurationRound}
                stroke="var(--chart-axis)"
                width={44}
                ticks={ticks}
                domain={[0, ticks[ticks.length - 1] || maxDuration]}
              />
              <Tooltip
                content={<RunTooltip />}
                cursor={{ fill: "rgba(113,113,122,0.1)" }}
              />
              <Bar dataKey="duration" radius={[2, 2, 0, 0]}>
                {runData.map((point) => (
                  <Cell
                    key={point.index}
                    fill={point.failed ? "#ef4444" : "#10b981"}
                  />
                ))}
              </Bar>
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      {mode === "overview" && <BuildOutcomeStrip data={dailyData} />}
    </section>
  );
}
