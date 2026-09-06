"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface JobQueueChartProps {
  data: Array<Record<string, number | string>>;
  queues: string[];
  colors: Record<string, string>;
  formatXTick: (t: number) => string;
  tickInterval: number;
  metric: "scheduled" | "running" | "waiting";
}

function JobTooltip({
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
  const sorted = [...payload].filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  return (
    <div className="rounded-md border border-line bg-white px-3 py-2 text-xs shadow-lg dark:bg-zinc-900">
      <p className="mb-1 font-medium">{timeLabel}</p>
      {sorted.map((p) => (
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

export function JobQueueChart({
  data,
  queues,
  colors,
  formatXTick,
  tickInterval,
  metric,
}: JobQueueChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center text-sm text-zinc-400">
        No job data yet. Data will appear after metrics polling starts.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 10 }}
          stroke="#71717a"
          tickFormatter={formatXTick}
          interval={tickInterval}
        />
        <YAxis tick={{ fontSize: 11 }} stroke="#71717a" width={35} />
        <Tooltip
          content={<JobTooltip />}
          cursor={{ stroke: "#71717a", strokeDasharray: "3 3" }}
        />
        {queues.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {queues.map((q) => (
          <Line isAnimationActive={false}
            key={q}
            type="monotone"
            dataKey={`${q}_jobs_${metric}`}
            name={q}
            stroke={colors[q]}
            strokeWidth={2}
            dot={{ r: 2, fill: colors[q] }}
            activeDot={{ r: 4 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
