"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ParityHistorySample } from "@/lib/gpu-parity";

export const PARITY_COLORS = {
  mirrored: "#34d399",
  singleVendor: "#a1a1aa",
  coverage: "#3b82f6",
} as const;

interface TrendPoint {
  date: string;
  gpuJobs: number;
  mirroredJobs: number;
  singleVendorJobs: number;
  coverage: number | null;
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload: TrendPoint }>;
  label?: string;
}) {
  if (!active || !payload?.length || !label) return null;
  const point = payload[0].payload;
  const rows: Array<[string, string, string]> = [
    ["Multi-vendor", String(point.mirroredJobs), PARITY_COLORS.mirrored],
    ["Single-vendor", String(point.singleVendorJobs), PARITY_COLORS.singleVendor],
    [
      "Coverage",
      point.coverage == null ? "—" : `${Math.round(point.coverage * 100)}%`,
      PARITY_COLORS.coverage,
    ],
  ];
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      <p className="mb-1 font-medium">
        Week of {formatDate(label)} · {point.gpuJobs} gating GPU jobs
      </p>
      {rows.map(([name, value, color]) => (
        <div key={name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: color }}
            />
            {name}
          </span>
          <span className="tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

export function ParityTrendChart({
  samples,
}: {
  samples: ParityHistorySample[];
}) {
  const data: TrendPoint[] = samples.map((sample) => {
    const counts = sample.gating;
    return {
      date: sample.date,
      gpuJobs: counts.gpuJobs,
      mirroredJobs: counts.mirroredJobs,
      singleVendorJobs: counts.gpuJobs - counts.mirroredJobs,
      coverage: counts.coverage,
    };
  });

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatDate}
          tick={{ fontSize: 11, fill: "var(--chart-axis)" }}
          axisLine={false}
          tickLine={false}
          minTickGap={24}
        />
        <YAxis
          yAxisId="jobs"
          allowDecimals={false}
          tick={{ fontSize: 11, fill: "var(--chart-axis)" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="coverage"
          orientation="right"
          domain={[0, 100]}
          tickFormatter={(value: number) => `${value}%`}
          tick={{ fontSize: 11, fill: "var(--chart-axis)" }}
          axisLine={false}
          tickLine={false}
          width={44}
        />
        <Tooltip
          content={<TrendTooltip />}
          cursor={{ fill: "var(--chart-grid)", opacity: 0.4 }}
        />
        <Legend
          verticalAlign="top"
          align="right"
          iconType="square"
          iconSize={8}
          wrapperStyle={{ fontSize: 11, paddingBottom: 8 }}
        />
        <Bar
          yAxisId="jobs"
          dataKey="mirroredJobs"
          name="Multi-vendor"
          stackId="jobs"
          fill={PARITY_COLORS.mirrored}
          isAnimationActive={false}
        />
        <Bar
          yAxisId="jobs"
          dataKey="singleVendorJobs"
          name="Single-vendor"
          stackId="jobs"
          fill={PARITY_COLORS.singleVendor}
          fillOpacity={0.55}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
        <Line
          yAxisId="coverage"
          type="monotone"
          dataKey={(point: TrendPoint) =>
            point.coverage == null ? null : Math.round(point.coverage * 1000) / 10
          }
          name="Coverage %"
          stroke={PARITY_COLORS.coverage}
          strokeWidth={2}
          dot={{ r: 2.5, strokeWidth: 0, fill: PARITY_COLORS.coverage }}
          activeDot={{ r: 4 }}
          connectNulls
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
