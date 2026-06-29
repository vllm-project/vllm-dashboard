"use client";

import { useState, useMemo, useEffect } from "react";
import useSWR from "swr";
import dynamic from "next/dynamic";
import { SearchableSelect } from "@/components/searchable-select";

const Plot = dynamic(() => import("@/components/plotly-chart"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] items-center justify-center">
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
  devices: string[];
  tps: string[];
  concs: string[];
  precisions: string[];
}

interface ChartRow {
  device: string;
  dateStr: string;
  date: string;
  conc: number;
  tp: number;
  image: string;
  _idx: number;
  [key: string]: number | string;
}

// ── Metric metadata ──────────────────────────────────────────────────────────

interface MetricInfo {
  name: string;
  unit: string;
  higherIsBetter: boolean;
}

const METRIC_INFO: Record<string, MetricInfo> = {
  tput_per_gpu: { name: "Throughput / GPU", unit: "token/s/gpu", higherIsBetter: true },
  input_tput_per_gpu: { name: "Input Throughput / GPU", unit: "token/s/gpu", higherIsBetter: true },
  output_tput_per_gpu: { name: "Output Throughput / GPU", unit: "token/s/gpu", higherIsBetter: true },
  mean_ttft: { name: "Mean TTFT", unit: "s", higherIsBetter: false },
  mean_tpot: { name: "Mean TPOT", unit: "s", higherIsBetter: false },
  mean_itl: { name: "Mean ITL", unit: "s", higherIsBetter: false },
  mean_e2el: { name: "Mean E2E Latency", unit: "s", higherIsBetter: false },
  p99_ttft: { name: "P99 TTFT", unit: "s", higherIsBetter: false },
  p99_tpot: { name: "P99 TPOT", unit: "s", higherIsBetter: false },
  p99_itl: { name: "P99 ITL", unit: "s", higherIsBetter: false },
  p99_e2el: { name: "P99 E2E Latency", unit: "s", higherIsBetter: false },
};

function metricLabel(metric: string): string {
  const info = METRIC_INFO[metric];
  if (!info) return metric;
  return info.unit ? `${info.name} (${info.unit})` : info.name;
}

// ── Chart configs ────────────────────────────────────────────────────────────

interface ChartConfig {
  x: string;
  y: string;
  title: string;
}

const CHART_CONFIGS: ChartConfig[] = [
  { x: "p99_ttft", y: "input_tput_per_gpu", title: "Input Throughput vs P99 TTFT" },
  { x: "p99_itl", y: "tput_per_gpu", title: "Throughput vs P99 ITL" },
  { x: "p99_e2el", y: "tput_per_gpu", title: "Throughput vs P99 E2E Latency" },
];

const COLORS = [
  "#818cf8", "#fb923c", "#34d399", "#f87171",
  "#a78bfa", "#22d3ee", "#f472b6", "#fbbf24",
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

// ── Pareto frontier ──────────────────────────────────────────────────────────

function computeOptimal(
  rows: ChartRow[],
  xMetric: string,
  yMetric: string
): Set<number> {
  const xHb = METRIC_INFO[xMetric]?.higherIsBetter ?? false;
  const yHb = METRIC_INFO[yMetric]?.higherIsBetter ?? false;
  const optimalIndices = new Set<number>();

  const groups = new Map<string, ChartRow[]>();
  for (const row of rows) {
    const key = `${row.device}|${row.dateStr}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  for (const groupRows of groups.values()) {
    const sorted = [...groupRows].sort((a, b) => {
      const av = a[yMetric] as number;
      const bv = b[yMetric] as number;
      return yHb ? bv - av : av - bv;
    });
    let bestX: number | null = null;
    for (const row of sorted) {
      const xv = row[xMetric] as number;
      if (isNaN(xv)) continue;
      if (bestX === null) {
        bestX = xv;
        optimalIndices.add(row._idx);
      } else if (xHb && xv >= bestX) {
        bestX = xv;
        optimalIndices.add(row._idx);
      } else if (!xHb && xv <= bestX) {
        bestX = xv;
        optimalIndices.add(row._idx);
      }
    }
  }
  return optimalIndices;
}

// ── Chart component ──────────────────────────────────────────────────────────

function PerfChart({
  chartRows,
  config,
  colorMap,
  hideNonOptimal,
}: {
  chartRows: ChartRow[];
  config: ChartConfig;
  colorMap: Record<string, string>;
  hideNonOptimal: boolean;
}) {
  const dark = useDarkMode();
  const { x: xMetric, y: yMetric, title } = config;

  const { traces, hasData } = useMemo(() => {
    const xLabel = metricLabel(xMetric);
    const yLabel = metricLabel(yMetric);

    const valid = chartRows.filter(
      (r) => !isNaN(r[xMetric] as number) && !isNaN(r[yMetric] as number)
    );
    if (valid.length === 0) return { traces: [], hasData: false };

    const optimalSet = computeOptimal(valid, xMetric, yMetric);
    const showAll = !hideNonOptimal && valid.length !== optimalSet.size;
    const displayRows = hideNonOptimal
      ? valid.filter((r) => optimalSet.has(r._idx))
      : valid;

    const groups = new Map<string, ChartRow[]>();
    for (const row of displayRows) {
      const key = `${row.device}|${row.dateStr}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    const result: object[] = [];
    const sortedKeys = [...groups.keys()].sort();

    for (const key of sortedKeys) {
      const groupRows = groups.get(key)!;
      const [deviceName, dateStr] = key.split("|");
      const color = colorMap[key];
      const label = `${deviceName} / ${dateStr}`;

      const cd = (rows: ChartRow[]) =>
        rows.map((r) => [r.conc, r.date, r.tp, r.device, r.image]);

      const hoverBase = (tag: string) =>
        `<b>${label}${tag}</b><br>` +
        `${xLabel}: <b>%{x:.2f}</b><br>${yLabel}: <b>%{y:.4f}</b><br>` +
        `Concurrency: <b>%{customdata[0]:.0f}</b>  TP: <b>%{text}</b><br>` +
        `<span style="color:${dark ? "#71717a" : "#a1a1aa"}">%{customdata[4]}</span>` +
        `<extra></extra>`;

      if (showAll) {
        const nonOpt = groupRows.filter((r) => !optimalSet.has(r._idx));
        if (nonOpt.length > 0) {
          result.push({
            x: nonOpt.map((r) => r[xMetric]),
            y: nonOpt.map((r) => r[yMetric]),
            mode: "markers",
            name: label,
            legendgroup: label,
            showlegend: false,
            marker: { color, size: 6, opacity: 0.2, line: { width: 0 } },
            customdata: cd(nonOpt),
            text: nonOpt.map((r) => String(r.tp)),
            hovertemplate: hoverBase(""),
          });
        }
        const opt = groupRows
          .filter((r) => optimalSet.has(r._idx))
          .sort((a, b) => (a[xMetric] as number) - (b[xMetric] as number));
        result.push({
          x: opt.map((r) => r[xMetric]),
          y: opt.map((r) => r[yMetric]),
          mode: "lines+markers",
          name: label,
          legendgroup: label,
          showlegend: true,
          line: { color, width: 2.5, shape: "spline" },
          marker: { color, size: 8, line: { color: dark ? "#18181b" : "#ffffff", width: 1.5 } },
          customdata: cd(opt),
          text: opt.map((r) => String(r.tp)),
          hovertemplate: hoverBase("  \u2726"),
        });
      } else {
        const sorted = [...groupRows].sort(
          (a, b) => (a[xMetric] as number) - (b[xMetric] as number)
        );
        result.push({
          x: sorted.map((r) => r[xMetric]),
          y: sorted.map((r) => r[yMetric]),
          mode: "lines+markers",
          name: label,
          line: { color, width: 2, shape: "spline" },
          marker: { color, size: 8, line: { color: dark ? "#18181b" : "#ffffff", width: 1.5 } },
          customdata: cd(sorted),
          text: sorted.map((r) => String(r.tp)),
          hovertemplate: hoverBase(""),
        });
      }
    }
    return { traces: result, hasData: true };
  }, [chartRows, xMetric, yMetric, colorMap, hideNonOptimal, dark]);

  if (!hasData) return null;

  const xLabel = metricLabel(xMetric);
  const yLabel = metricLabel(yMetric);
  const axisColor = dark ? "#52525b" : "#d4d4d8";
  const gridColor = dark ? "rgba(63,63,70,0.4)" : "rgba(228,228,231,0.6)";
  const textColor = dark ? "#a1a1aa" : "#71717a";

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-zinc-800/80 dark:bg-zinc-950 dark:shadow-[0_1px_3px_rgba(0,0,0,0.3)]">
      <div className="px-5 pt-4 pb-0">
        <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {title}
        </h3>
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
              title: { text: xLabel, font: { size: 11 }, standoff: 10 },
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
            yaxis: {
              title: { text: yLabel, font: { size: 11 }, standoff: 8 },
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
              y: -0.22,
              x: 0.5,
              xanchor: "center" as const,
              yanchor: "top" as const,
              tracegroupgap: 4,
              itemwidth: 30,
            },
            height: 420,
            margin: { l: 56, r: 16, t: 12, b: 80 },
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

export default function PerfPage() {
  const [model, setModel] = useState("");
  const [device, setDevice] = useState("");
  const [tp, setTp] = useState("");
  const [conc, setConc] = useState("");
  const [hideNonOptimal, setHideNonOptimal] = useState(false);

  const { data: filters } = useSWR<FiltersResponse>("/api/perf/filters", fetcher);

  const params = new URLSearchParams();
  if (model) params.set("model", model);
  if (device) params.set("device", device);
  if (tp) params.set("tp", tp);
  if (conc) params.set("conc", conc);

  const { data, isLoading } = useSWR<{ rows: PerfRow[] }>(
    model ? `/api/perf?${params.toString()}` : null,
    fetcher,
    { refreshInterval: 10 * 60 * 1000 }
  );

  const rawRows = useMemo(() => data?.rows ?? [], [data]);

  const chartRows: ChartRow[] = useMemo(() => {
    return rawRows
      .map((r, i) => ({
        device: r.device,
        dateStr: r.date,
        date: r.date,
        conc: parseFloat(r.conc),
        tp: parseInt(r.tp, 10),
        image: r.image,
        _idx: i,
        tput_per_gpu: parseFloat(r.tput_per_gpu),
        input_tput_per_gpu: parseFloat(r.input_tput_per_gpu),
        output_tput_per_gpu: parseFloat(r.output_tput_per_gpu),
        mean_ttft: parseFloat(r.mean_ttft),
        mean_tpot: parseFloat(r.mean_tpot),
        mean_itl: parseFloat(r.mean_itl),
        mean_e2el: parseFloat(r.mean_e2el),
        p99_ttft: parseFloat(r.p99_ttft),
        p99_tpot: parseFloat(r.p99_tpot),
        p99_itl: parseFloat(r.p99_itl),
        p99_e2el: parseFloat(r.p99_e2el),
      }))
      .filter((r) => !isNaN(r.tput_per_gpu));
  }, [rawRows]);

  const colorMap = useMemo(() => {
    const keys = [
      ...new Set(chartRows.map((r) => `${r.device}|${r.dateStr}`)),
    ].sort();
    const map: Record<string, string> = {};
    keys.forEach((key, i) => {
      map[key] = COLORS[i % COLORS.length];
    });
    return map;
  }, [chartRows]);


  return (
    <div className="space-y-5">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Throughput-latency tradeoff curves across hardware configurations.
        Points on the Pareto frontier represent optimal throughput/latency tradeoffs.
      </p>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border border-zinc-200/80 bg-white px-5 py-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-zinc-800/80 dark:bg-zinc-950 dark:shadow-[0_1px_3px_rgba(0,0,0,0.3)]">
        <SearchableSelect
          label="Model"
          value={model}
          onChange={(v) => {
            setModel(v);
            setDevice("");
            setTp("");
          }}
          options={filters?.models ?? []}
          counts={filters?.modelCounts}
          allLabel="Select Model"
        />
        <SearchableSelect
          label="Device"
          value={device}
          onChange={setDevice}
          options={filters?.devices ?? []}
          allLabel="All Devices"
        />
        <SearchableSelect
          label="TP"
          value={tp}
          onChange={setTp}
          options={filters?.tps ?? []}
          allLabel="All TP"
        />
        <SearchableSelect
          label="Concurrency"
          value={conc}
          onChange={setConc}
          options={filters?.concs ?? []}
          allLabel="All Concurrency"
        />
        {model && chartRows.length > 0 && (
          <div className="flex items-center gap-2.5 pb-0.5">
            <button
              type="button"
              role="switch"
              aria-checked={hideNonOptimal}
              onClick={() => setHideNonOptimal(!hideNonOptimal)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${
                hideNonOptimal
                  ? "bg-indigo-500"
                  : "bg-zinc-200 dark:bg-zinc-700"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                  hideNonOptimal ? "translate-x-[18px]" : "translate-x-[3px]"
                }`}
              />
            </button>
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Optimal only
            </span>
          </div>
        )}
      </div>

      {/* Empty states */}
      {!model && (
        <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700">
          <svg className="h-8 w-8 text-zinc-300 dark:text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
          </svg>
          <span className="text-sm text-zinc-400 dark:text-zinc-500">
            Select a model to view performance benchmarks
          </span>
        </div>
      )}
      {model && isLoading && (
        <div className="flex h-64 items-center justify-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300" />
          <span className="text-sm text-zinc-400">Loading benchmarks...</span>
        </div>
      )}
      {model && !isLoading && rawRows.length === 0 && (
        <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700">
          <span className="text-sm text-zinc-400 dark:text-zinc-500">
            No data found for this configuration.
          </span>
        </div>
      )}

      {/* Charts grid */}
      {model && !isLoading && chartRows.length > 0 && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          {CHART_CONFIGS.map((cfg) => (
            <PerfChart
              key={`${cfg.x}-${cfg.y}`}
              chartRows={chartRows}
              config={cfg}
              colorMap={colorMap}
              hideNonOptimal={hideNonOptimal}
            />
          ))}
        </div>
      )}

    </div>
  );
}

