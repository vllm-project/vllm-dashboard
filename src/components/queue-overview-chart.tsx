"use client";

import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface QueueOverviewChartProps {
  data: Array<{ time: number; running: number; scheduled: number; waiting: number; agents: number }>;
  formatXTick: (t: number) => string;
  tickInterval: number;
  /** When true, also plot raw jobs_waiting as a grey bar (e.g. mithril-h100-pool). */
  showWaiting?: boolean;
  emptyMessage?: string;
  state?: "ready" | "loading" | "error";
  queue?: string;
  rangeLabel?: string;
  onRetry?: () => void;
}

function OverviewTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  const timeLabel = label
    ? new Date(label).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : "";
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      <p className="mb-1 font-medium">{timeLabel}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: p.color }}
            />
            {p.name}
          </span>
          <span className="tabular-nums">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

export function QueueOverviewChart({
  data,
  formatXTick,
  tickInterval,
  showWaiting = false,
  emptyMessage,
  state = "ready",
  queue,
  rangeLabel,
  onRetry,
}: QueueOverviewChartProps) {
  const resolvedEmptyMessage =
    emptyMessage ??
    (queue || rangeLabel
      ? `No ${queue ? `${queue} ` : ""}metrics were recorded in the last ${rangeLabel ?? "selected period"}.`
      : "No snapshots were recorded in this timeframe.");

  if (data.length === 0) {
    if (state === "loading") {
      return (
        <div
          className="flex h-[300px] flex-col items-center justify-center gap-2 text-center"
          role="status"
          aria-live="polite"
        >
          <span
            className="h-5 w-5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600 motion-reduce:animate-none dark:border-blue-900 dark:border-t-blue-400"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Loading {queue ? `${queue} ` : ""}history…
          </p>
          <p className="text-xs text-zinc-400">
            Current queue totals are shown above while the chart loads.
          </p>
        </div>
      );
    }

    if (state === "error") {
      return (
        <div
          className="flex h-[300px] flex-col items-center justify-center gap-2 text-center"
          role="alert"
        >
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            History couldn&apos;t be loaded.
          </p>
          <p className="text-xs text-zinc-400">The current queue totals above are still available.</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              Retry
            </button>
          )}
        </div>
      );
    }

    return (
      <div className="flex h-[300px] flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          No history in this range
        </p>
        <p className="text-xs text-zinc-400">
          {resolvedEmptyMessage}
        </p>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 10 }}
          stroke="#71717a"
          tickFormatter={formatXTick}
          interval={tickInterval}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="#71717a"
          width={40}
        />
        <Tooltip
          content={<OverviewTooltip />}
          cursor={{ fill: "rgba(113,113,122,0.08)" }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar

          dataKey="running"
          name="Running"
          stackId="jobs"
          fill="#10b981"
          radius={[0, 0, 0, 0]}
        />
        <Bar

          dataKey="scheduled"
          name="Waiting"
          stackId="jobs"
          fill="#eab308"
          radius={showWaiting ? [0, 0, 0, 0] : [2, 2, 0, 0]}
        />
        {showWaiting && (
          <Bar
            dataKey="waiting"
            name="Waiting (raw)"
            stackId="jobs"
            fill="#a1a1aa"
            radius={[2, 2, 0, 0]}
          />
        )}
        <Line

          type="monotone"
          dataKey="agents"
          name="Connected Agents"
          stroke="#3b82f6"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
