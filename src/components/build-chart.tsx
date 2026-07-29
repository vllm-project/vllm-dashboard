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
          <dd className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
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
          <dd className="font-medium tabular-nums text-red-600 dark:text-red-400">
            {formatDuration(point.peak)}
          </dd>
        </div>
      </dl>
      <p className="mt-2 border-t border-zinc-200 pt-2 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        {point.total} builds · {point.failed} failed
      </p>
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
}

export function BuildChart({ data, startDate, endDate }: BuildChartProps) {
  const [mode, setMode] = useState<ChartMode>("overview");
  const rangeLabel =
    startDate && endDate ? `${startDate} — ${endDate}` : "All Time";

  const runData = useMemo<RunPoint[]>(
    () =>
      data.map((build, index) => {
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
    [data],
  );

  const dailyData = useMemo<DailyPoint[]>(() => {
    const byDay = new Map<string, BuildDuration[]>();
    for (const build of data) {
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
          failed: builds.filter((build) => isFailed(build.state)).length,
        };
      });
  }, [data]);

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
            {rangeLabel} · {data.length} builds
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
                stroke="#27272a"
                vertical={false}
              />
              <XAxis
                dataKey="dateLabel"
                interval={tickInterval}
                minTickGap={20}
                stroke="#71717a"
                tick={{ fontSize: 11 }}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={formatDurationRound}
                stroke="#71717a"
                width={44}
                ticks={ticks}
                domain={[0, ticks[ticks.length - 1] || maxDuration]}
              />
              <Tooltip
                content={<OverviewTooltip />}
                cursor={{ stroke: "#71717a", strokeDasharray: "3 3" }}
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
                stroke="#10b981"
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
                stroke="#ef4444"
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
                stroke="#27272a"
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
                stroke="#71717a"
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={formatDurationRound}
                stroke="#71717a"
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
    </section>
  );
}
