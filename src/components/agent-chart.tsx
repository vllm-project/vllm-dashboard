"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface AgentChartProps {
  data: Array<Record<string, number | string>>;
  queues: string[];
  colors: Record<string, string>;
  formatXTick: (t: number) => string;
  tickInterval: number;
}

function AgentTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string; dataKey: string }>;
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

  // Group by queue
  const queueMap = new Map<string, { busy: number; idle: number; total: number }>();
  for (const p of payload) {
    const parts = p.dataKey.split("_agents_");
    if (parts.length !== 2) continue;
    const queue = parts[0];
    const metric = parts[1];
    if (!queueMap.has(queue)) queueMap.set(queue, { busy: 0, idle: 0, total: 0 });
    const entry = queueMap.get(queue)!;
    if (metric === "busy") entry.busy = p.value;
    else if (metric === "idle") entry.idle = p.value;
    entry.total = entry.busy + entry.idle;
  }

  const sorted = [...queueMap.entries()]
    .filter(([, v]) => v.total > 0)
    .sort((a, b) => b[1].total - a[1].total);

  return (
    <div className="rounded-md border border-line bg-white px-3 py-2 text-xs shadow-lg dark:bg-zinc-900">
      <p className="mb-1 font-medium">{timeLabel}</p>
      {sorted.map(([queue, v]) => (
        <div key={queue} className="flex items-center justify-between gap-4">
          <span>{queue}</span>
          <span className="tabular-nums">
            {v.busy} busy / {v.idle} idle
          </span>
        </div>
      ))}
    </div>
  );
}

export function AgentChart({ data, queues, colors, formatXTick, tickInterval }: AgentChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center text-sm text-zinc-400">
        No agent data yet. Data will appear after metrics polling starts.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data}>
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
          content={<AgentTooltip />}
          cursor={{ stroke: "#71717a", strokeDasharray: "3 3" }}
        />
        {queues.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {queues.map((q) => (
          <Area isAnimationActive={false}
            key={`${q}_busy`}
            type="monotone"
            dataKey={`${q}_agents_busy`}
            name={`${q} (busy)`}
            stackId={q}
            stroke={colors[q]}
            fill={colors[q]}
            fillOpacity={0.6}
            strokeWidth={1.5}
            connectNulls
          />
        ))}
        {queues.map((q) => (
          <Area isAnimationActive={false}
            key={`${q}_idle`}
            type="monotone"
            dataKey={`${q}_agents_idle`}
            name={`${q} (idle)`}
            stackId={q}
            stroke={colors[q]}
            fill={colors[q]}
            fillOpacity={0.15}
            strokeWidth={0}
            connectNulls
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
