"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { StatCard } from "@/components/stat-card";
import { SearchableSelect } from "@/components/searchable-select";
import { DateRangePicker } from "@/components/date-range-picker";
import { JobName, jobNameText } from "@/components/job-name";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function formatCost(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface QueueCostRow {
  queue: string;
  total_jobs: string;
  total_hours: number;
  instance_type: string | null;
  cost_per_hour: number | null;
  total_cost: number | null;
}

interface BuildCostRow {
  build_id: string;
  build_url: string;
  message: string;
  commit_sha: string;
  branch: string;
  author: string;
  created_at: string;
  total_hours: number;
  total_cost: number;
  total_jobs: number;
}

interface JobCostRow {
  job_name: string;
  total_runs: number;
  total_hours: number;
  total_cost: number;
  avg_cost: number;
}

interface DailyCostByQueueRow {
  date: string;
  queue: string;
  total_hours: number;
  total_cost: number;
}

interface FiltersResponse {
  pipelines: string[];
  branches: string[];
}

interface CostResponse {
  byQueue: QueueCostRow[];
  dailyCostByQueue: DailyCostByQueueRow[];
  byBuild: BuildCostRow[];
  byJob: JobCostRow[];
  error?: string;
}

// ── Chart constants ──────────────────────────────────────────────────────────

const STACK_COLORS = [
  "#818cf8", "#fb923c", "#34d399", "#f87171",
  "#a78bfa", "#22d3ee", "#f472b6", "#fbbf24",
  "#6366f1", "#f97316", "#10b981", "#ef4444",
];
const OTHER_COLOR = "#71717a";
const MAX_QUEUES = 5;
const BUILDS_PER_PAGE = 20;

// ── Tooltip ──────────────────────────────────────────────────────────────────

function StackedTooltip({
  active,
  payload,
  label,
  mode,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string; fill: string }>;
  label?: string;
  mode: "cost" | "hours";
}) {
  if (!active || !payload?.length) return null;
  const sorted = [...payload]
    .filter((p) => p.value > 0)
    .sort((a, b) => (b.value || 0) - (a.value || 0));
  const total = sorted.reduce((s, p) => s + (p.value || 0), 0);
  const isCost = mode === "cost";
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      <p className="mb-1 font-medium">{label}</p>
      {sorted.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: p.fill || p.color }}
            />
            {p.name}
          </span>
          <span className="tabular-nums">
            {isCost ? `$${p.value.toFixed(2)}` : `${p.value.toFixed(1)}h`}
          </span>
        </div>
      ))}
      {sorted.length > 1 && (
        <div className="mt-1 border-t border-zinc-200 pt-1 text-right font-medium dark:border-zinc-700">
          {isCost ? `$${total.toFixed(2)}` : `${total.toFixed(1)}h`}
        </div>
      )}
    </div>
  );
}

// ── Tab button helper ────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`min-h-11 px-4 text-sm font-medium transition-[color,transform] active:scale-[0.98] sm:min-h-10 ${
        active
          ? "border-b-2 border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CostPage() {
  const [pipeline, setPipeline] = useState("CI");
  const [branch, setBranch] = useState("");
  const [startDate, setStartDate] = useState(daysAgo(14));
  const [endDate, setEndDate] = useState(today());
  const [tab, setTab] = useState<"overview" | "builds" | "jobs">("overview");
  const [chartMode, setChartMode] = useState<"cost" | "hours">("cost");
  const [seriesMode, setSeriesMode] = useState<"top" | "all">("top");
  const [buildPage, setBuildPage] = useState(0);

  const params = new URLSearchParams();
  if (pipeline) params.set("pipeline", pipeline);
  if (branch) params.set("branch", branch);
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const apiUrl = `/api/cost?${params.toString()}`;

  const { data: filters } = useSWR<FiltersResponse>("/api/builds/filters", fetcher);
  const { data, error, isLoading } = useSWR<CostResponse>(apiUrl, fetcher, {
    refreshInterval: 5 * 60 * 1000,
    keepPreviousData: true,
  });

  // Build stacked chart data
  const { stackedData, queues, queueColors, dayCount } = useMemo(() => {
    const raw = data?.dailyCostByQueue ?? [];
    if (raw.length === 0)
      return { stackedData: [], queues: [], queueColors: {} as Record<string, string>, dayCount: 0 };

    const queueTotals = new Map<string, number>();
    for (const row of raw) {
      queueTotals.set(row.queue, (queueTotals.get(row.queue) ?? 0) + row.total_cost);
    }
    const sorted = [...queueTotals.entries()].sort((a, b) => b[1] - a[1]);
    const visibleLimit = seriesMode === "top" ? MAX_QUEUES : sorted.length;
    const topQueues = sorted.slice(0, visibleLimit).map(([q]) => q);
    const hasOther = sorted.length > visibleLimit;
    const allQueues = hasOther ? [...topQueues, "Other"] : topQueues;

    const colors: Record<string, string> = {};
    allQueues.forEach((q, i) => {
      colors[q] = q === "Other" ? OTHER_COLOR : STACK_COLORS[i % STACK_COLORS.length];
    });

    const dateMap = new Map<string, Record<string, number | string>>();
    for (const row of raw) {
      if (!dateMap.has(row.date)) {
        dateMap.set(row.date, {
          _raw: row.date,
          date: new Date(row.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        });
      }
      const entry = dateMap.get(row.date)!;
      const q = topQueues.includes(row.queue) ? row.queue : "Other";
      entry[`cost__${q}`] = ((entry[`cost__${q}`] as number) ?? 0) + row.total_cost;
      entry[`hours__${q}`] = ((entry[`hours__${q}`] as number) ?? 0) + row.total_hours;
    }

    const chartData = [...dateMap.values()].sort((a, b) =>
      (a._raw as string).localeCompare(b._raw as string)
    );

    return { stackedData: chartData, queues: allQueues, queueColors: colors, dayCount: chartData.length };
  }, [data, seriesMode]);

  if (isLoading && !data) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading cost data...
      </div>
    );
  }

  if (error || data?.error) {
    return (
      <div className="flex h-64 items-center justify-center text-red-400">
        Failed to load cost data. Check Databricks connection.
      </div>
    );
  }

  const { byQueue = [], byBuild = [], byJob = [] } = data ?? {};

  const totalCost = byQueue.reduce((s, q) => s + (q.total_cost ?? 0), 0);
  const totalHours = byQueue.reduce((s, q) => s + q.total_hours, 0);
  const totalJobs = byQueue.reduce((s, q) => s + parseInt(q.total_jobs, 10), 0);
  const unknownCostQueues = byQueue.filter((q) => q.total_cost === null).length;
  const avgDailyCost = dayCount > 0 ? totalCost / dayCount : 0;

  // Build pagination
  const buildTotalPages = Math.ceil(byBuild.length / BUILDS_PER_PAGE);
  const pagedBuilds = byBuild.slice(
    buildPage * BUILDS_PER_PAGE,
    (buildPage + 1) * BUILDS_PER_PAGE
  );

  return (
    <div className="space-y-6">
      {/* Header + filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">Cost</h1>
        <div className="flex gap-3">
          <SearchableSelect
            label="Pipeline"
            value={pipeline}
            onChange={setPipeline}
            options={filters?.pipelines ?? []}
            allLabel="All Pipelines"
          />
          <SearchableSelect
            label="Branch"
            value={branch}
            onChange={setBranch}
            options={filters?.branches ?? []}
            allLabel="All Branches"
          />
          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onChange={(s, e) => {
              setStartDate(s);
              setEndDate(e);
            }}
          />
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <StatCard className="col-span-2 sm:col-span-1" label="Total Cost" value={`$${totalCost.toFixed(0)}`} detail="Known queues only" />
        <StatCard label="Avg Daily Cost" value={`$${avgDailyCost.toFixed(0)}`} />
        <StatCard label="Compute Hours" value={`${totalHours.toFixed(0)}`} />
        <StatCard label="Total Jobs" value={totalJobs} />
        <StatCard label="Unpriced Queues" value={unknownCostQueues} detail="No cost data" />
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
          Overview
        </TabButton>
        <TabButton active={tab === "builds"} onClick={() => { setTab("builds"); setBuildPage(0); }}>
          By Build
        </TabButton>
        <TabButton active={tab === "jobs"} onClick={() => setTab("jobs")}>
          By Job
        </TabButton>
      </div>

      {/* ── Overview tab ── */}
      {tab === "overview" && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div
              className="inline-flex w-fit rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-900"
              aria-label="Cost chart metric"
            >
              <button
                onClick={() => setChartMode("cost")}
                aria-pressed={chartMode === "cost"}
                className={`min-h-11 rounded-md px-3 text-xs font-medium transition-[background-color,color,transform] active:scale-[0.97] sm:min-h-10 ${
                  chartMode === "cost"
                    ? "bg-white text-zinc-900 shadow-sm ring-1 ring-black/5 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-white/10"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                Daily Cost
              </button>
              <button
                onClick={() => setChartMode("hours")}
                aria-pressed={chartMode === "hours"}
                className={`min-h-11 rounded-md px-3 text-xs font-medium transition-[background-color,color,transform] active:scale-[0.97] sm:min-h-10 ${
                  chartMode === "hours"
                    ? "bg-white text-zinc-900 shadow-sm ring-1 ring-black/5 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-white/10"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                Compute Hours
              </button>
            </div>
            <div
              className="inline-flex w-fit rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-900"
              aria-label="Cost chart queue detail"
            >
              <button
                type="button"
                onClick={() => setSeriesMode("top")}
                aria-pressed={seriesMode === "top"}
                className={`min-h-11 rounded-md px-3 text-xs font-medium transition-[background-color,color,transform] active:scale-[0.97] sm:min-h-10 ${
                  seriesMode === "top"
                    ? "bg-white text-zinc-900 shadow-sm ring-1 ring-black/5 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-white/10"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                Top 5 + Other
              </button>
              <button
                type="button"
                onClick={() => setSeriesMode("all")}
                aria-pressed={seriesMode === "all"}
                className={`min-h-11 rounded-md px-3 text-xs font-medium transition-[background-color,color,transform] active:scale-[0.97] sm:min-h-10 ${
                  seriesMode === "all"
                    ? "bg-white text-zinc-900 shadow-sm ring-1 ring-black/5 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-white/10"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                All Queues
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="mb-4">
              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {chartMode === "cost" ? "Daily cost" : "Daily compute hours"} by queue
              </h3>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {seriesMode === "top"
                  ? "Highest-volume queues are shown individually; the remainder is grouped."
                  : `${queues.length} queues shown for detailed inspection.`}
              </p>
            </div>
            <ResponsiveContainer width="100%" height={340}>
              <BarChart data={stackedData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#71717a" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) =>
                    chartMode === "cost" ? formatCost(v) : `${v}h`
                  }
                  stroke="#71717a"
                  width={50}
                />
                <Tooltip
                  content={<StackedTooltip mode={chartMode} />}
                  cursor={{ fill: "rgba(113,113,122,0.1)" }}
                />
                <Legend
                  formatter={(value: string) => value.replace(/^(cost|hours)__/, "")}
                  wrapperStyle={{ fontSize: 11 }}
                />
                {queues.map((q) => (
                  <Bar
                    key={q}
                    dataKey={chartMode === "cost" ? `cost__${q}` : `hours__${q}`}
                    name={q}
                    stackId="a"
                    fill={queueColors[q]}
                    radius={0}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Cost by Queue table */}
          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                Cost by Queue
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    <th className="px-5 py-2.5 font-medium">Queue</th>
                    <th className="px-5 py-2.5 font-medium">Instance</th>
                    <th className="px-5 py-2.5 font-medium">$/hr</th>
                    <th className="px-5 py-2.5 font-medium">Hours</th>
                    <th className="px-5 py-2.5 font-medium">Est. Cost</th>
                    <th className="px-5 py-2.5 font-medium">Jobs</th>
                  </tr>
                </thead>
                <tbody>
                  {byQueue.map((q) => (
                    <tr key={q.queue} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                      <td className="px-5 py-2.5 font-medium">{q.queue}</td>
                      <td className="px-5 py-2.5 font-mono text-xs text-zinc-500">{q.instance_type ?? "\u2014"}</td>
                      <td className="px-5 py-2.5 text-zinc-600 dark:text-zinc-400">
                        {q.cost_per_hour != null ? `$${q.cost_per_hour.toFixed(2)}` : "\u2014"}
                      </td>
                      <td className="px-5 py-2.5 tabular-nums">{q.total_hours.toFixed(1)}</td>
                      <td className="px-5 py-2.5 font-medium tabular-nums">
                        {q.total_cost != null ? (
                          <span className="text-purple-600 dark:text-purple-400">${q.total_cost.toFixed(2)}</span>
                        ) : (
                          <span className="text-zinc-400">{"\u2014"}</span>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-zinc-500">{q.total_jobs}</td>
                    </tr>
                  ))}
                  {byQueue.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-8 text-center text-zinc-400">No cost data found</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── By Build tab ── */}
      {tab === "builds" && (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
              Cost by Build
              <span className="ml-2 text-xs font-normal text-zinc-400">
                {byBuild.length} builds
              </span>
            </h3>
            {buildTotalPages > 1 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setBuildPage((p) => Math.max(0, p - 1))}
                  disabled={buildPage === 0}
                  className="min-h-11 rounded px-3 text-xs font-medium text-zinc-500 transition-[background-color,transform] hover:bg-zinc-100 active:scale-[0.97] disabled:opacity-40 sm:min-h-10 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Prev
                </button>
                <span className="text-xs tabular-nums text-zinc-400">
                  {buildPage + 1} / {buildTotalPages}
                </span>
                <button
                  onClick={() => setBuildPage((p) => Math.min(buildTotalPages - 1, p + 1))}
                  disabled={buildPage >= buildTotalPages - 1}
                  className="min-h-11 rounded px-3 text-xs font-medium text-zinc-500 transition-[background-color,transform] hover:bg-zinc-100 active:scale-[0.97] disabled:opacity-40 sm:min-h-10 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Next
                </button>
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="px-5 py-2.5 font-medium">#</th>
                  <th className="px-5 py-2.5 font-medium">Build</th>
                  <th className="px-5 py-2.5 font-medium">Commit</th>
                  <th className="px-5 py-2.5 font-medium">Author</th>
                  <th className="px-5 py-2.5 font-medium">Branch</th>
                  <th className="px-5 py-2.5 font-medium">Est. Cost</th>
                  <th className="px-5 py-2.5 font-medium">Hours</th>
                  <th className="px-5 py-2.5 font-medium">Jobs</th>
                </tr>
              </thead>
              <tbody>
                {pagedBuilds.map((b, i) => {
                  const maxCost = byBuild[0]?.total_cost || 1;
                  const pct = (b.total_cost / maxCost) * 100;
                  const rank = buildPage * BUILDS_PER_PAGE + i + 1;
                  return (
                    <tr key={b.build_id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                      <td className="px-5 py-2.5 text-zinc-400">{rank}</td>
                      <td className="max-w-[16rem] truncate px-5 py-2.5">
                        {b.build_url ? (
                          <a
                            href={b.build_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-zinc-600 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
                          >
                            {b.message || "\u2014"}
                          </a>
                        ) : (
                          <span className="text-zinc-600 dark:text-zinc-400">{b.message || "\u2014"}</span>
                        )}
                      </td>
                      <td className="px-5 py-2.5 font-mono text-xs">
                        <a
                          href={`https://github.com/vllm-project/vllm/commit/${b.commit_sha}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {b.commit_sha?.slice(0, 7)}
                        </a>
                      </td>
                      <td className="px-5 py-2.5 text-zinc-600 dark:text-zinc-400">{b.author ?? "\u2014"}</td>
                      <td className="px-5 py-2.5 text-zinc-600 dark:text-zinc-400">{b.branch}</td>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-20 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                            <div
                              className="h-full rounded-full bg-purple-500"
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-medium tabular-nums text-purple-600 dark:text-purple-400">
                            ${b.total_cost.toFixed(0)}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-2.5 tabular-nums">{b.total_hours.toFixed(1)}</td>
                      <td className="px-5 py-2.5 text-zinc-500">{b.total_jobs}</td>
                    </tr>
                  );
                })}
                {byBuild.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-5 py-8 text-center text-zinc-400">No build data found</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {/* Bottom pagination */}
          {buildTotalPages > 1 && (
            <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <span className="text-xs text-zinc-400">
                Showing {buildPage * BUILDS_PER_PAGE + 1}–{Math.min((buildPage + 1) * BUILDS_PER_PAGE, byBuild.length)} of {byBuild.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setBuildPage((p) => Math.max(0, p - 1))}
                  disabled={buildPage === 0}
                  className="min-h-11 rounded px-3 text-xs font-medium text-zinc-500 transition-[background-color,transform] hover:bg-zinc-100 active:scale-[0.97] disabled:opacity-40 sm:min-h-10 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Prev
                </button>
                <span className="text-xs tabular-nums text-zinc-400">
                  {buildPage + 1} / {buildTotalPages}
                </span>
                <button
                  onClick={() => setBuildPage((p) => Math.min(buildTotalPages - 1, p + 1))}
                  disabled={buildPage >= buildTotalPages - 1}
                  className="min-h-11 rounded px-3 text-xs font-medium text-zinc-500 transition-[background-color,transform] hover:bg-zinc-100 active:scale-[0.97] disabled:opacity-40 sm:min-h-10 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── By Job tab ── */}
      {tab === "jobs" && (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
              Cost by Job
              <span className="ml-2 text-xs font-normal text-zinc-400">
                {byJob.length} jobs
              </span>
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="px-5 py-2.5 font-medium">#</th>
                  <th className="px-5 py-2.5 font-medium">Job</th>
                  <th className="px-5 py-2.5 font-medium text-right">Runs</th>
                  <th className="px-5 py-2.5 font-medium text-right">Total Hours</th>
                  <th className="px-5 py-2.5 font-medium text-right">Total Cost</th>
                  <th className="px-5 py-2.5 font-medium text-right">Avg Cost / Run</th>
                </tr>
              </thead>
              <tbody>
                {byJob.map((j, i) => {
                  const maxCost = byJob[0]?.total_cost || 1;
                  const pct = (j.total_cost / maxCost) * 100;
                  return (
                    <tr key={j.job_name} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                      <td className="px-5 py-2.5 text-zinc-400">{i + 1}</td>
                      <td className="max-w-[24rem] truncate px-5 py-2.5 font-medium" title={jobNameText(j.job_name)}>
                        <JobName name={j.job_name} />
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-zinc-500">
                        {j.total_runs.toLocaleString()}
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums">
                        {j.total_hours.toFixed(1)}
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-2 w-16 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                            <div
                              className="h-full rounded-full bg-purple-500"
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-medium tabular-nums text-purple-600 dark:text-purple-400">
                            ${j.total_cost.toFixed(2)}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                        ${j.avg_cost.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
                {byJob.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-zinc-400">No job data found</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
