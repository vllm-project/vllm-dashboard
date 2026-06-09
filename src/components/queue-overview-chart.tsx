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

export function QueueOverviewChart({ data, formatXTick, tickInterval, showWaiting = false }: QueueOverviewChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center text-sm text-zinc-400">
        No data yet. Data will appear after metrics polling starts.
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
