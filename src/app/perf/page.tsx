"use client";

import { PageHeader } from "@/components/page-header";
import { SegmentedControl } from "@/components/segmented-control";
import { PerfSettingsMenu } from "@/app/perf/perf-settings";
import { ToggleSwitch } from "@/components/toggle-switch";

import { Suspense, useState, useMemo, useEffect } from "react";
import { useUrlState } from "@/lib/use-url-state";
import useSWR from "swr";
import dynamic from "next/dynamic";
import { SearchableSelect } from "@/components/searchable-select";
import { usePerfSettings } from "@/app/perf/perf-settings";

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

// Same categorical palette as the rest of the dashboard (see globals.css
// --chart-1..8), with a lighter ramp for dark surfaces.
const COLORS_LIGHT = [
  "#2563eb", "#d97706", "#7c3aed", "#059669",
  "#db2777", "#0891b2", "#ea580c", "#4f46e5",
  "#65a30d", "#c026d3", "#0d9488", "#b45309",
];
const COLORS_DARK = [
  "#60a5fa", "#fbbf24", "#a78bfa", "#34d399",
  "#f472b6", "#22d3ee", "#fb923c", "#818cf8",
  "#a3e635", "#e879f9", "#2dd4bf", "#f59e0b",
];

/** How many series to show by default before the reader opts into more. */
const DEFAULT_VISIBLE_SERIES = 8;

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[index];
}

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
  xRange,
  hiddenSeries,
  clipOutliers,
}: {
  points: TrendPoint[];
  metric: string;
  stat: Stat;
  colorMap: Record<string, string>;
  /** Shared date range so every chart on the page lines up. */
  xRange: [string, string] | null;
  hiddenSeries: ReadonlySet<string>;
  /** Cap the y axis near the 98th percentile so spikes do not flatten the trend. */
  clipOutliers: boolean;
}) {
  const dark = useDarkMode();
  const col = metricColumn(metric, stat);
  const info = METRIC_INFO[metric];

  const { traces, hasData, yRange, clippedCount } = useMemo(() => {
    const valid = points.filter(
      (p) => !isNaN(p[col] as number) && !hiddenSeries.has(p.series),
    );
    if (valid.length === 0) {
      return { traces: [], hasData: false, yRange: null, clippedCount: 0 };
    }

    const values = valid.map((p) => p[col] as number).sort((a, b) => a - b);
    const max = values[values.length - 1];
    const cap = percentile(values, 0.98) * 1.25;
    const shouldClip = clipOutliers && values.length >= 8 && max > cap && cap > 0;
    const yRange: [number, number] | null = shouldClip ? [0, cap] : null;
    const clippedCount = shouldClip ? values.filter((v) => v > cap).length : 0;

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
    return { traces: result, hasData: true, yRange, clippedCount };
  }, [points, col, metric, colorMap, dark, hiddenSeries, clipOutliers]);

  if (!hasData) return null;

  const axisColor = dark ? "#3f3f46" : "#d4d4d8";
  const gridColor = dark ? "rgba(63,63,70,0.45)" : "rgba(228,228,231,0.7)";
  const textColor = dark ? "#8b8b94" : "#71717a";

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pt-4 pb-0">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {metricLabel(metric)}
        </h3>
        <span className="flex items-center gap-3 text-[11px] text-muted">
          {clippedCount > 0 && (
            <span title="The y axis is capped near the 98th percentile; hover a series to see exact values or turn off outlier clipping.">
              {clippedCount} {clippedCount === 1 ? "point" : "points"} above axis
            </span>
          )}
          <span className="font-medium uppercase tracking-wide">
            {info?.higherIsBetter ? "higher is better" : "lower is better"}
          </span>
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
            showlegend: false,
            xaxis: {
              type: "date" as const,
              range: xRange ?? undefined,
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
              range: yRange ?? undefined,
              showgrid: true,
              gridwidth: 1,
              ticks: "outside" as const,
              tickcolor: axisColor,
              ticklen: 4,
            },
            height: 300,
            margin: { l: 56, r: 16, t: 12, b: 40 },
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

const PERF_URL_DEFAULTS = { model: "", device: "", tp: "", conc: "", stat: "p99" };

function PerfTrendsPageContent() {
  const { startDate } = usePerfSettings();
  const [url, setUrl] = useUrlState(PERF_URL_DEFAULTS);
  const model = url.model;
  const device = url.device;
  const tp = url.tp;
  const conc = url.conc;
  const stat: Stat = STATS.includes(url.stat as Stat) ? (url.stat as Stat) : "p99";
  const setModel = (next: string) => setUrl({ model: next, device: "", tp: "", conc: "" });
  const setDevice = (next: string) => setUrl({ device: next });
  const setTp = (next: string) => setUrl({ tp: next });
  const setConc = (next: string) => setUrl({ conc: next });
  const setStat = (next: Stat) => setUrl({ stat: next });
  const [clipOutliers, setClipOutliers] = useState(true);
  // Series the reader has switched off. Null means "use the default subset".
  const [hiddenOverride, setHiddenOverride] = useState<Set<string> | null>(null);
  const dark = useDarkMode();

  const { data: filters } = useSWR<FiltersResponse>(
    `/api/perf/filters?start=${encodeURIComponent(startDate)}`,
    fetcher
  );
  const activeModel = model || filters?.models[0] || "";

  // Fetch every row for the model once, then filter device/TP/concurrency
  // client-side so those switches are instant (no refetch).
  const { data, isLoading } = useSWR<{ rows: PerfRow[] }>(
    activeModel
      ? `/api/perf?model=${encodeURIComponent(activeModel)}&start=${encodeURIComponent(startDate)}`
      : null,
    fetcher,
    { refreshInterval: 10 * 60 * 1000, keepPreviousData: true }
  );

  const allPoints: TrendPoint[] = useMemo(() => {
    const rawRows = data?.rows ?? [];
    return rawRows
      .map(
        (r) =>
          ({
            date: r.date,
            image: r.image,
            device: r.device,
            tp: parseInt(r.tp, 10),
            conc: parseInt(r.conc, 10),
            series: `${r.device} · TP${r.tp} · c${r.conc}`,
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
    const palette = dark ? COLORS_DARK : COLORS_LIGHT;
    const map: Record<string, string> = {};
    seriesKeys.forEach((key, i) => {
      map[key] = palette[i % palette.length];
    });
    return map;
  }, [seriesKeys, dark]);

  // Series with the most recent data are the ones worth showing by default.
  const seriesByRecency = useMemo(() => {
    const latest = new Map<string, string>();
    for (const p of points) {
      const current = latest.get(p.series);
      if (!current || p.date > current) latest.set(p.series, p.date);
    }
    return [...seriesKeys].sort(
      (a, b) => (latest.get(b) ?? "").localeCompare(latest.get(a) ?? ""),
    );
  }, [points, seriesKeys]);

  const hiddenSeries = useMemo(() => {
    if (hiddenOverride) return hiddenOverride;
    return new Set(seriesByRecency.slice(DEFAULT_VISIBLE_SERIES));
  }, [hiddenOverride, seriesByRecency]);

  const xRange = useMemo<[string, string] | null>(() => {
    if (points.length === 0) return null;
    let min = points[0].date;
    let max = points[0].date;
    for (const p of points) {
      if (p.date < min) min = p.date;
      if (p.date > max) max = p.date;
    }
    return [min, max];
  }, [points]);

  const toggleSeries = (series: string) => {
    const next = new Set(hiddenSeries);
    if (next.has(series)) next.delete(series);
    else next.add(series);
    setHiddenOverride(next);
  };

  const allMetrics = [...THROUGHPUT_METRICS, ...LATENCY_METRICS];
  const visibleCount = seriesKeys.length - hiddenSeries.size;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Performance trends"
        description="Nightly benchmark results per model, device, and configuration over time."
        actions={<PerfSettingsMenu />}
      />
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border border-line bg-surface px-4 py-4 sm:px-5">
        <SearchableSelect
          label="Model"
          value={activeModel}
          onChange={setModel}
          options={filters?.models ?? []}
          counts={filters?.modelCounts}
          allLabel="Most active model"
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
          <label className="mb-1 block text-xs font-medium text-muted">
            Latency stat
          </label>
          <SegmentedControl
            label="Latency statistic"
            size="md"
            value={stat}
            onChange={setStat}
            options={STATS.map((s) => ({ value: s, label: s.toUpperCase() }))}
          />
        </div>
        <div className="pb-1">
          <ToggleSwitch
            label="Clip outliers"
            checked={clipOutliers}
            onToggle={() => setClipOutliers((value) => !value)}
          />
        </div>
      </div>

      {/* One legend for all six charts */}
      {activeModel && !isLoading && seriesKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-line bg-surface px-4 py-3 sm:px-5">
          <span className="mr-1 text-xs font-medium text-muted">
            {visibleCount} of {seriesKeys.length} series
          </span>
          {seriesByRecency.map((series) => {
            const hidden = hiddenSeries.has(series);
            return (
              <button
                key={series}
                type="button"
                aria-pressed={!hidden}
                onClick={() => toggleSeries(series)}
                className={`dashboard-control inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium tabular-nums ${
                  hidden
                    ? "border-line text-muted hover:text-foreground"
                    : "border-transparent bg-surface-muted text-foreground"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-full"
                  style={{
                    background: hidden ? "transparent" : colorMap[series],
                    boxShadow: hidden ? `inset 0 0 0 1.5px ${colorMap[series]}` : undefined,
                  }}
                />
                {series}
              </button>
            );
          })}
          <span className="ml-auto flex items-center gap-3 text-xs">
            <button
              type="button"
              onClick={() => setHiddenOverride(new Set())}
              className="dashboard-control font-medium text-accent hover:text-accent-strong"
            >
              Show all
            </button>
            <button
              type="button"
              onClick={() => setHiddenOverride(null)}
              className="dashboard-control font-medium text-muted hover:text-foreground"
            >
              Reset
            </button>
          </span>
        </div>
      )}

      {/* Empty states */}
      {!activeModel && (
        <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700">
          <span className="text-sm text-zinc-400 dark:text-zinc-500">
            Loading available models...
          </span>
        </div>
      )}
      {activeModel && isLoading && (
        <div className="flex h-64 items-center justify-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300" />
          <span className="text-sm text-zinc-400">Loading benchmarks...</span>
        </div>
      )}
      {activeModel && !isLoading && points.length === 0 && (
        <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700">
          <span className="text-sm text-zinc-400 dark:text-zinc-500">
            No data found for this configuration.
          </span>
        </div>
      )}

      {/* Charts grid */}
      {activeModel && !isLoading && points.length > 0 && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          {allMetrics.map((m) => (
            <TrendChart
              key={m}
              points={points}
              metric={m}
              stat={stat}
              colorMap={colorMap}
              xRange={xRange}
              hiddenSeries={hiddenSeries}
              clipOutliers={clipOutliers}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function PerfTrendsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center text-sm text-muted">
          Loading performance trends...
        </div>
      }
    >
      <PerfTrendsPageContent />
    </Suspense>
  );
}
