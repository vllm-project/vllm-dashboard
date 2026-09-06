"use client";

import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { SegmentedControl } from "@/components/segmented-control";
import { Tabs } from "@/components/tabs";

import { Suspense, useMemo } from "react";
import { isoDate, useUrlState } from "@/lib/use-url-state";
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
    <div className="rounded-md border border-line bg-white px-3 py-2 text-xs shadow-lg dark:bg-zinc-900">
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
        <div className="mt-1 border-t border-line pt-1 text-right font-medium">
          {isCost ? `$${total.toFixed(2)}` : `${total.toFixed(1)}h`}
        </div>
      )}
    </div>
  );
}

// ── Tab button helper ────────────────────────────────────────────────────────


// ── Page ─────────────────────────────────────────────────────────────────────

const COST_URL_DEFAULTS = {
  pipeline: "CI",
  branch: "",
  start: "",
  end: "",
  tab: "overview",
  chart: "cost",
  series: "top",
  bpage: "0",
};

function CostPageContent() {
  const [url, setUrl] = useUrlState(COST_URL_DEFAULTS);
  const pipeline = url.pipeline;
  const branch = url.branch;
  const startDate = url.start || isoDate(14);
  const endDate = url.end || isoDate(0);
  const setPipeline = (next: string) => setUrl({ pipeline: next, bpage: "0" });
  const setBranch = (next: string) => setUrl({ branch: next, bpage: "0" });
  const setStartDate = (next: string) => setUrl({ start: next, bpage: "0" });
  const setEndDate = (next: string) => setUrl({ end: next, bpage: "0" });
  const tab: "overview" | "builds" | "jobs" =
    url.tab === "builds" || url.tab === "jobs" ? url.tab : "overview";
  const setTab = (next: "overview" | "builds" | "jobs") => setUrl({ tab: next });
  const chartMode: "cost" | "hours" = url.chart === "hours" ? "hours" : "cost";
  const setChartMode = (next: "cost" | "hours") => setUrl({ chart: next });
  const seriesMode: "top" | "all" = url.series === "all" ? "all" : "top";
  const setSeriesMode = (next: "top" | "all") => setUrl({ series: next });
  const buildPage = Math.max(0, parseInt(url.bpage, 10) || 0);
  const setBuildPage = (next: number | ((current: number) => number)) =>
    setUrl({ bpage: String(typeof next === "function" ? next(buildPage) : next) });

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
      <PageHeader
        title="Cost"
        actions={
          <>
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
          </>
        }
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <StatCard className="col-span-2 sm:col-span-1" label="Total Cost" value={`$${totalCost.toFixed(0)}`} detail="Known queues only" />
        <StatCard label="Avg Daily Cost" value={`$${avgDailyCost.toFixed(0)}`} />
        <StatCard label="Compute Hours" value={`${totalHours.toFixed(0)}`} />
        <StatCard label="Total Jobs" value={totalJobs} />
        <StatCard label="Unpriced Queues" value={unknownCostQueues} detail="No cost data" />
      </div>

      {/* Tab bar */}
      <Tabs
        label="Cost views"
        value={tab}
        onChange={(next) => {
          setTab(next);
          if (next === "builds") setBuildPage(0);
        }}
        items={[
          { value: "overview", label: "Overview" },
          { value: "builds", label: "By Build" },
          { value: "jobs", label: "By Job" },
        ]}
      />

      {/* ── Overview tab ── */}
      {tab === "overview" && (
        <>
          <Panel
            title={`${chartMode === "cost" ? "Daily cost" : "Daily compute hours"} by queue`}
            description={
              seriesMode === "top"
                ? "Highest-volume queues are shown individually; the remainder is grouped."
                : `${queues.length} queues shown for detailed inspection.`
            }
            actions={
              <>
                <SegmentedControl
                  label="Cost chart metric"
                  value={chartMode}
                  onChange={setChartMode}
                  options={[
                    { value: "cost", label: "Daily cost" },
                    { value: "hours", label: "Compute hours" },
                  ]}
                />
                <SegmentedControl
                  label="Cost chart queue detail"
                  value={seriesMode}
                  onChange={setSeriesMode}
                  options={[
                    { value: "top", label: "Top 5 + other" },
                    { value: "all", label: "All queues" },
                  ]}
                />
              </>
            }
            padded
          >
            <ResponsiveContainer width="100%" height={340}>
              <BarChart data={stackedData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--chart-axis)" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) =>
                    chartMode === "cost" ? formatCost(v) : `${v}h`
                  }
                  stroke="var(--chart-axis)"
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
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          {/* Cost by Queue table */}
          <div className="rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-5 py-3">
              <h3 className="text-sm font-medium text-muted">
                Cost by Queue
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-muted">
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
                          <span className="font-medium text-foreground">${q.total_cost.toFixed(2)}</span>
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
        <div className="rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h3 className="text-sm font-medium text-muted">
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
                  className="min-h-11 rounded px-3 text-xs font-medium text-muted transition-[background-color,transform] hover:bg-zinc-100 active:scale-[0.97] disabled:opacity-40 sm:min-h-10 dark:hover:bg-zinc-800"
                >
                  Prev
                </button>
                <span className="text-xs tabular-nums text-zinc-400">
                  {buildPage + 1} / {buildTotalPages}
                </span>
                <button
                  onClick={() => setBuildPage((p) => Math.min(buildTotalPages - 1, p + 1))}
                  disabled={buildPage >= buildTotalPages - 1}
                  className="min-h-11 rounded px-3 text-xs font-medium text-muted transition-[background-color,transform] hover:bg-zinc-100 active:scale-[0.97] disabled:opacity-40 sm:min-h-10 dark:hover:bg-zinc-800"
                >
                  Next
                </button>
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
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
                              className="h-full rounded-full bg-accent"
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-medium tabular-nums text-foreground">
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
            <div className="flex items-center justify-between border-t border-line px-5 py-3">
              <span className="text-xs text-zinc-400">
                Showing {buildPage * BUILDS_PER_PAGE + 1}–{Math.min((buildPage + 1) * BUILDS_PER_PAGE, byBuild.length)} of {byBuild.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setBuildPage((p) => Math.max(0, p - 1))}
                  disabled={buildPage === 0}
                  className="min-h-11 rounded px-3 text-xs font-medium text-muted transition-[background-color,transform] hover:bg-zinc-100 active:scale-[0.97] disabled:opacity-40 sm:min-h-10 dark:hover:bg-zinc-800"
                >
                  Prev
                </button>
                <span className="text-xs tabular-nums text-zinc-400">
                  {buildPage + 1} / {buildTotalPages}
                </span>
                <button
                  onClick={() => setBuildPage((p) => Math.min(buildTotalPages - 1, p + 1))}
                  disabled={buildPage >= buildTotalPages - 1}
                  className="min-h-11 rounded px-3 text-xs font-medium text-muted transition-[background-color,transform] hover:bg-zinc-100 active:scale-[0.97] disabled:opacity-40 sm:min-h-10 dark:hover:bg-zinc-800"
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
        <div className="rounded-lg border border-line bg-surface">
          <div className="border-b border-line px-5 py-3">
            <h3 className="text-sm font-medium text-muted">
              Cost by Job
              <span className="ml-2 text-xs font-normal text-zinc-400">
                {byJob.length} jobs
              </span>
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
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
                              className="h-full rounded-full bg-accent"
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-medium tabular-nums text-foreground">
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

export default function CostPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center text-sm text-muted">
          Loading cost...
        </div>
      }
    >
      <CostPageContent />
    </Suspense>
  );
}
