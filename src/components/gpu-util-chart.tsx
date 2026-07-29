"use client";

import {
  Area,
  AreaChart,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

export type GpuChartMode = "lines" | "stacked";

interface GpuMemChartProps {
  data: Array<Record<string, number>>;
  hosts: string[];
  formatXTick: (t: number) => string;
  tickInterval: number;
  mode: GpuChartMode;
  totalCapacityGb: number;
  totalGpuCount: number;
}

const HOST_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

function MemTooltip({
  active,
  payload,
  label,
  mode,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: number;
  mode: GpuChartMode;
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
  const entries = payload
    .filter((entry) => entry.value != null)
    .sort((a, b) => b.value - a.value);
  const total = entries.reduce((sum, entry) => sum + Number(entry.value), 0);

  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-1 flex items-center justify-between gap-5">
        <p className="font-medium">{timeLabel}</p>
        {mode === "stacked" && (
          <span className="font-medium tabular-nums">{formatGigabytes(total)}</span>
        )}
      </div>
      {entries.map((p) => (
          <div key={p.name} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: p.color }}
              />
              {p.name}
            </span>
            <span className="tabular-nums">
              {mode === "stacked" ? formatGigabytes(p.value) : `${p.value}%`}
            </span>
          </div>
        ))}
    </div>
  );
}

function formatGigabytes(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(1)} TB`;
  if (value >= 10) return `${Math.round(value)} GB`;
  return `${value.toFixed(1)} GB`;
}

export function GpuMemChart({
  data,
  hosts,
  formatXTick,
  tickInterval,
  mode,
  totalCapacityGb,
  totalGpuCount,
}: GpuMemChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center text-sm text-zinc-400">
        No GPU data yet. Deploy the reporting script to start collecting metrics.
      </div>
    );
  }

  const xAxis = (
    <XAxis
      dataKey="time"
      tick={{ fontSize: 10 }}
      stroke="#71717a"
      tickFormatter={formatXTick}
      interval={tickInterval}
    />
  );
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />;

  if (mode === "stacked") {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={data}>
          {grid}
          {xAxis}
          <YAxis
            tick={{ fontSize: 11 }}
            stroke="#71717a"
            width={58}
            domain={[0, totalCapacityGb]}
            tickFormatter={formatGigabytes}
            allowDataOverflow
          />
          <Tooltip
            content={<MemTooltip mode="stacked" />}
            cursor={{ fill: "rgba(113,113,122,0.08)" }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <ReferenceLine
            y={totalCapacityGb}
            stroke="#71717a"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            ifOverflow="extendDomain"
            label={{
              value: `${totalGpuCount} GPUs · ${formatGigabytes(totalCapacityGb)} capacity`,
              position: "insideTopRight",
              fill: "#71717a",
              fontSize: 11,
            }}
          />
          {hosts.map((host, i) => (
            <Area
              key={host}
              type="monotone"
              dataKey={host}
              name={host}
              stackId="gpu-memory"
              stroke={HOST_COLORS[i % HOST_COLORS.length]}
              fill={HOST_COLORS[i % HOST_COLORS.length]}
              fillOpacity={0.72}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 4 }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        {grid}
        {xAxis}
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="#71717a"
          width={40}
          domain={[0, 100]}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip
          content={<MemTooltip mode="lines" />}
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
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
