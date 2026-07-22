"use client";

import { useState, useMemo, useEffect } from "react";
import useSWR from "swr";
import dynamic from "next/dynamic";
import { SearchableSelect } from "@/components/searchable-select";
import { usePerfSettings } from "@/app/perf/perf-settings";
import { dedupePerfRows } from "@/lib/perf-data";

const Plot = dynamic(() => import("@/components/plotly-chart"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[320px] items-center justify-center">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300" />
    </div>
  ),
});

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// ── Types ────────────────────────────────────────────────────────────────────

interface PerfRow {
  date: string;
  model: string;
  device: string;
  tp: string;
  conc: string;
  isl: string;
  osl: string;
  precision: string;
  image: string;
  tput_per_gpu: string;
  input_tput_per_gpu: string;
  output_tput_per_gpu: string;
  mean_ttft: string;
  mean_tpot: string;
  mean_itl: string;
  mean_e2el: string;
  p99_ttft: string;
  p99_tpot: string;
  p99_itl: string;
  p99_e2el: string;
  median_ttft: string;
  median_tpot: string;
  median_itl: string;
  median_e2el: string;
}

interface FiltersResponse {
  models: string[];
  modelCounts: Record<string, number>;
}

interface TrendPoint {
  date: string;
  image: string;
  device: string;
  tp: number;
  conc: number;
  series: string;
  [metric: string]: number | string;
}

// ── Metric metadata ──────────────────────────────────────────────────────────

interface MetricInfo {
  name: string;
  unit: string;
  higherIsBetter: boolean;
}

const METRIC_INFO: Record<string, MetricInfo> = {
  tput_per_gpu: { name: "Throughput / GPU", unit: "token/s/gpu", higherIsBetter: true },
  output_tput_per_gpu: { name: "Output Throughput / GPU", unit: "token/s/gpu", higherIsBetter: true },
  ttft: { name: "TTFT", unit: "s", higherIsBetter: false },
  tpot: { name: "TPOT", unit: "s", higherIsBetter: false },
  itl: { name: "ITL", unit: "s", higherIsBetter: false },
  e2el: { name: "E2E Latency", unit: "s", higherIsBetter: false },
};

// Latency families switch with the selected statistic; throughput is always raw.
const THROUGHPUT_METRICS = ["tput_per_gpu", "output_tput_per_gpu"] as const;
const LATENCY_METRICS = ["ttft", "tpot", "itl", "e2el"] as const;
const STATS = ["p99", "mean", "median"] as const;
type Stat = (typeof STATS)[number];

function metricColumn(metric: string, stat: Stat): string {
  return THROUGHPUT_METRICS.includes(metric as (typeof THROUGHPUT_METRICS)[number])
    ? metric
    : `${stat}_${metric}`;
}

function metricLabel(metric: string): string {
  const info = METRIC_INFO[metric];
  if (!info) return metric;
  return info.unit ? `${info.name} (${info.unit})` : info.name;
}

const COLORS = [
  "#818cf8", "#fb923c", "#34d399", "#f87171",
  "#a78bfa", "#22d3ee", "#f472b6", "#fbbf24",
  "#60a5fa", "#4ade80", "#e879f9", "#facc15",
];

// ── Hooks ────────────────────────────────────────────────────────────────────

function useDarkMode() {
  const [dark, setDark] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark")
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() =>
      setDark(el.classList.contains("dark"))
    );
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// ── Trend chart ──────────────────────────────────────────────────────────────

function TrendChart({
  points,
  metric,
  stat,
  colorMap,
}: {
  points: TrendPoint[];
  metric: string;
  stat: Stat;
  colorMap: Record<string, string>;
}) {
  const dark = useDarkMode();
  const col = metricColumn(metric, stat);
  const info = METRIC_INFO[metric];

  const { traces, hasData } = useMemo(() => {
    const valid = points.filter((p) => !isNaN(p[col] as number));
    if (valid.length === 0) return { traces: [], hasData: false };

    const groups = new Map<string, TrendPoint[]>();
    for (const p of valid) {
      if (!groups.has(p.series)) groups.set(p.series, []);
      groups.get(p.series)!.push(p);
    }

    const result: object[] = [];
    for (const series of [...groups.keys()].sort()) {
      const rows = [...groups.get(series)!].sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : a.image < b.image ? -1 : 1
      );
      const color = colorMap[series];
      result.push({
        x: rows.map((r) => r.date),
        y: rows.map((r) => r[col]),
        mode: "lines+markers",
        name: series,
        line: { color, width: 2, shape: "linear" },
        marker: {
          color,
          size: 7,
          line: { color: dark ? "#18181b" : "#ffffff", width: 1.5 },
        },
        customdata: rows.map((r) => [r.image, r.tp, r.conc, r.device]),
        hovertemplate:
          `<b>${series}</b><br>` +
          `%{x}<br>${metricLabel(metric)}: <b>%{y:.4f}</b><br>` +
          `Concurrency: <b>%{customdata[2]}</b>  TP: <b>%{customdata[1]}</b><br>` +
          `<span style="color:${dark ? "#71717a" : "#a1a1aa"}">%{customdata[0]}</span>` +
          `<extra></extra>`,
      });
    }
    return { traces: result, hasData: true };
  }, [points, col, metric, colorMap, dark]);

  if (!hasData) return null;

  const axisColor = dark ? "#52525b" : "#d4d4d8";
  const gridColor = dark ? "rgba(63,63,70,0.4)" : "rgba(228,228,231,0.6)";
  const textColor = dark ? "#a1a1aa" : "#71717a";

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-zinc-800/80 dark:bg-zinc-950 dark:shadow-[0_1px_3px_rgba(0,0,0,0.3)]">
      <div className="flex items-baseline justify-between px-5 pt-4 pb-0">
        <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {metricLabel(metric)}
        </h3>
        <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
          {info?.higherIsBetter ? "higher is better" : "lower is better"}
        </span>
      </div>
      <div className="-mx-px">
        <Plot
          data={traces}
          layout={{
            paper_bgcolor: "transparent",
            plot_bgcolor: "transparent",
            font: {
              family: "system-ui, -apple-system, sans-serif",
              color: textColor,
              size: 11,
            },
            xaxis: {
              type: "date" as const,
              tickfont: { size: 10 },
              gridcolor: gridColor,
              linecolor: axisColor,
              showline: true,
              zeroline: false,
              showgrid: true,
              gridwidth: 1,
              ticks: "outside" as const,
              tickcolor: axisColor,
              ticklen: 4,
            },
            yaxis: {
              title: { text: metricLabel(metric), font: { size: 11 }, standoff: 8 },
              tickfont: { size: 10 },
              gridcolor: gridColor,
              linecolor: axisColor,
              showline: true,
              zeroline: false,
              rangemode: "tozero" as const,
              showgrid: true,
              gridwidth: 1,
              ticks: "outside" as const,
              tickcolor: axisColor,
              ticklen: 4,
            },
            legend: {
              font: { size: 10 },
              bgcolor: "transparent",
              borderwidth: 0,
              orientation: "h" as const,
              y: -0.2,
              x: 0.5,
              xanchor: "center" as const,
              yanchor: "top" as const,
              tracegroupgap: 4,
              itemwidth: 30,
            },
            height: 340,
            margin: { l: 56, r: 16, t: 12, b: 70 },
            hovermode: "closest" as const,
            hoverlabel: {
              bgcolor: dark ? "#27272a" : "#ffffff",
              bordercolor: dark ? "#3f3f46" : "#e4e4e7",
              font: {
                size: 11,
                family: "system-ui, -apple-system, sans-serif",
                color: dark ? "#e4e4e7" : "#27272a",
              },
              align: "left" as const,
            },
            dragmode: "zoom" as const,
          }}
          config={{
            responsive: true,
            displaylogo: false,
            modeBarButtonsToRemove: [
              "lasso2d", "select2d", "autoScale2d", "toImage",
            ],
          }}
          useResizeHandler
          style={{ width: "100%" }}
        />
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PerfTrendsPage() {
  const { startDate } = usePerfSettings();
  const [model, setModel] = useState("");
  const [device, setDevice] = useState("");
  const [tp, setTp] = useState("");
  const [conc, setConc] = useState("");
  const [stat, setStat] = useState<Stat>("p99");

  const { data: filters } = useSWR<FiltersResponse>(
    `/api/perf/filters?start=${encodeURIComponent(startDate)}`,
    fetcher
  );

  // Fetch every row for the model once, then filter device/TP/concurrency
  // client-side so those switches are instant (no refetch).
  const { data, isLoading } = useSWR<{ rows: PerfRow[] }>(
    model
      ? `/api/perf?model=${encodeURIComponent(model)}&start=${encodeURIComponent(startDate)}`
      : null,
    fetcher,
    { refreshInterval: 10 * 60 * 1000, keepPreviousData: true }
  );

  const allPoints: TrendPoint[] = useMemo(() => {
    // Collapse duplicate/re-ingested rows so each build contributes one point
    // per config; otherwise the same nightly can appear several times and the
    // line zig-zags.
    const rawRows = dedupePerfRows(data?.rows ?? []);
    return rawRows
      .map(
        (r) =>
          ({
            date: r.date,
            image: r.image,
            device: r.device,
            tp: parseInt(r.tp, 10),
            conc: parseInt(r.conc, 10),
            // Include ISL/OSL and precision in the series identity: rows that
            // differ in these are distinct benchmarks and must not share a
            // line, or a second config/producer makes the trend look erratic.
            series: `${r.device} · TP${r.tp} · c${r.conc} · ${r.isl}/${r.osl}${
              r.precision ? ` · ${r.precision}` : ""
            }`,
            tput_per_gpu: parseFloat(r.tput_per_gpu),
            output_tput_per_gpu: parseFloat(r.output_tput_per_gpu),
            mean_ttft: parseFloat(r.mean_ttft),
            mean_tpot: parseFloat(r.mean_tpot),
            mean_itl: parseFloat(r.mean_itl),
            mean_e2el: parseFloat(r.mean_e2el),
            p99_ttft: parseFloat(r.p99_ttft),
            p99_tpot: parseFloat(r.p99_tpot),
            p99_itl: parseFloat(r.p99_itl),
            p99_e2el: parseFloat(r.p99_e2el),
            median_ttft: parseFloat(r.median_ttft),
            median_tpot: parseFloat(r.median_tpot),
            median_itl: parseFloat(r.median_itl),
            median_e2el: parseFloat(r.median_e2el),
          }) as TrendPoint
      )
      .filter((p) => !isNaN(p.tput_per_gpu as number));
  }, [data]);

  // Dropdown options reflect only what this model actually has data for.
  const deviceOpts = useMemo(
    () => [...new Set(allPoints.map((p) => p.device))].filter(Boolean).sort(),
    [allPoints]
  );
  const tpOpts = useMemo(
    () =>
      [...new Set(allPoints.map((p) => p.tp))]
        .sort((a, b) => a - b)
        .map(String),
    [allPoints]
  );
  const concOpts = useMemo(
    () =>
      [...new Set(allPoints.map((p) => p.conc))]
        .sort((a, b) => a - b)
        .map(String),
    [allPoints]
  );

  const points = useMemo(
    () =>
      allPoints.filter(
        (p) =>
          (!device || p.device === device) &&
          (!tp || p.tp === Number(tp)) &&
          (!conc || p.conc === Number(conc))
      ),
    [allPoints, device, tp, conc]
  );

  const seriesKeys = useMemo(
    () => [...new Set(points.map((p) => p.series))].sort(),
    [points]
  );

  const colorMap = useMemo(() => {
    const map: Record<string, string> = {};
    seriesKeys.forEach((key, i) => {
      map[key] = COLORS[i % COLORS.length];
    });
    return map;
  }, [seriesKeys]);

  const allMetrics = [...THROUGHPUT_METRICS, ...LATENCY_METRICS];

  return (
    <div className="space-y-5">
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border border-zinc-200/80 bg-white px-5 py-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-zinc-800/80 dark:bg-zinc-950 dark:shadow-[0_1px_3px_rgba(0,0,0,0.3)]">
        <SearchableSelect
          label="Model"
          value={model}
          onChange={(v) => {
            setModel(v);
            setDevice("");
            setTp("");
            setConc("");
          }}
          options={filters?.models ?? []}
          counts={filters?.modelCounts}
          allLabel="Select Model"
        />
        <SearchableSelect
          label="Device"
          value={device}
          onChange={setDevice}
          options={deviceOpts}
          allLabel="All Devices"
        />
        <SearchableSelect
          label="TP"
          value={tp}
          onChange={setTp}
          options={tpOpts}
          allLabel="All TP"
        />
        <SearchableSelect
          label="Concurrency"
          value={conc}
          onChange={setConc}
          options={concOpts}
          allLabel="All Concurrency"
        />
        {/* Statistic toggle */}
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Latency stat
          </label>
          <div className="inline-flex rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900">
            {STATS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStat(s)}
                className={`rounded px-2.5 py-1 text-xs font-medium uppercase tracking-wide transition-colors ${
                  stat === s
                    ? "bg-indigo-500 text-white"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        {model && seriesKeys.length > 0 && (
          <div className="pb-1.5 text-xs text-zinc-400 dark:text-zinc-500">
            {seriesKeys.length} series
          </div>
        )}
      </div>

      {/* Empty states */}
      {!model && (
        <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700">
          <span className="text-sm text-zinc-400 dark:text-zinc-500">
            Select a model to view performance trends
          </span>
        </div>
      )}
      {model && isLoading && (
        <div className="flex h-64 items-center justify-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300" />
          <span className="text-sm text-zinc-400">Loading benchmarks...</span>
        </div>
      )}
      {model && !isLoading && points.length === 0 && (
        <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700">
          <span className="text-sm text-zinc-400 dark:text-zinc-500">
            No data found for this configuration.
          </span>
        </div>
      )}

      {/* Charts grid */}
      {model && !isLoading && points.length > 0 && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          {allMetrics.map((m) => (
            <TrendChart
              key={m}
              points={points}
              metric={m}
              stat={stat}
              colorMap={colorMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}
