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

interface GpuMemChartProps {
  data: Array<Record<string, number>>;
  hosts: string[];
  formatXTick: (t: number) => string;
  tickInterval: number;
}

const HOST_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

function MemTooltip({
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
      {payload
        .filter((p) => p.value != null)
        .sort((a, b) => b.value - a.value)
        .map((p) => (
          <div key={p.name} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: p.color }}
              />
              {p.name}
            </span>
            <span className="tabular-nums">{p.value}%</span>
          </div>
        ))}
    </div>
  );
}

export function GpuMemChart({ data, hosts, formatXTick, tickInterval }: GpuMemChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center text-sm text-zinc-400">
        No GPU data yet. Deploy the reporting script to start collecting metrics.
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
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="#71717a"
          width={40}
          domain={[0, 100]}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip
          content={<MemTooltip />}
          cursor={{ fill: "rgba(113,113,122,0.08)" }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {hosts.map((host, i) => (
          <Line
            key={host}
            type="monotone"
            dataKey={host}
            name={host}
            stroke={HOST_COLORS[i % HOST_COLORS.length]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
