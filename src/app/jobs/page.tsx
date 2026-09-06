"use client";

import { PageHeader } from "@/components/page-header";

import { useState, Fragment, Suspense } from "react";
import Link from "next/link";
import { isoDate, useUrlState } from "@/lib/use-url-state";
import useSWR from "swr";
import { StatCard } from "@/components/stat-card";
import { SearchableSelect } from "@/components/searchable-select";
import { DateRangePicker } from "@/components/date-range-picker";
import { isOptionalJob, isSoftFailJob } from "@/lib/optional-jobs";
import { JobName, jobNameText } from "@/components/job-name";
import { JobRunsChart, JobRun } from "@/components/job-runs-chart";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface FailureRow {
  name: string;
  total_runs: string;
  failures: string;
  passes: string;
  failure_rate: string;
  has_soft_fail: string;
}

interface DurationRow {
  name: string;
  total_runs: string;
  avg_duration: string;
  p50_duration: string;
  p90_duration: string;
  max_duration: string;
}

interface JobsResponse {
  failureRanking: FailureRow[];
  durationStats: DurationRow[];
  error?: string;
}

interface FiltersResponse {
  pipelines: string[];
  branches: string[];
  error?: string;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function FailureBar({ rate }: { rate: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full ${
            rate >= 50
              ? "bg-red-500"
              : rate >= 20
                ? "bg-orange-500"
                : "bg-yellow-500"
          }`}
          style={{ width: `${Math.min(rate, 100)}%` }}
        />
      </div>
      <span className="text-xs font-medium tabular-nums">{rate}%</span>
    </div>
  );
}

function DurationBar({ secs, maxSecs }: { secs: number; maxSecs: number }) {
  const pct = maxSecs > 0 ? (secs / maxSecs) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full rounded-full bg-blue-500"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-xs tabular-nums">{formatDuration(secs)}</span>
    </div>
  );
}

function JobBadges({ name, hasSoftFail }: { name: string; hasSoftFail: boolean }) {
  const optional = isOptionalJob(name);
  const softFail = isSoftFailJob(name) || hasSoftFail;
  if (!optional && !softFail) return null;
  return (
    <span className="ml-2 inline-flex gap-1">
      {softFail && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
          soft fail
        </span>
      )}
      {optional && (
        <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
          optional
        </span>
      )}
    </span>
  );
}

function JobAnalysisTab({
  pipeline,
  branch,
  startDate,
  endDate,
}: {
  pipeline: string;
  branch: string;
  startDate: string;
  endDate: string;
}) {
  const [url, setUrl] = useUrlState(JOBS_URL_DEFAULTS);
  const analysisTab: "failures" | "duration" =
    url.tab === "duration" ? "duration" : "failures";
  const setAnalysisTab = (next: "failures" | "duration") => setUrl({ tab: next });
  const hideSoftFail = url.softfail === "1";
  const setHideSoftFail = (next: boolean) => setUrl({ softfail: next ? "1" : "" });
  const hideOptional = url.optional === "1";
  const setHideOptional = (next: boolean) => setUrl({ optional: next ? "1" : "" });
  const [searchQuery, setSearchQuery] = useState("");
  const page = Math.max(0, parseInt(url.page, 10) || 0);
  const setPage = (next: number | ((current: number) => number)) =>
    setUrl({ page: String(typeof next === "function" ? next(page) : next) });
  const pageSize = 20;
  const [failureSort, setFailureSort] = useState<{ col: string; asc: boolean }>({ col: "failure_rate", asc: false });
  const [durationSort, setDurationSort] = useState<{ col: string; asc: boolean }>({ col: "p50_duration", asc: false });
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (pipeline) params.set("pipeline", pipeline);
  if (branch) params.set("branch", branch);
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const apiUrl = `/api/jobs?${params.toString()}`;

  const { data, error, isLoading } = useSWR<JobsResponse>(apiUrl, fetcher, {
    refreshInterval: 5 * 60 * 1000,
    keepPreviousData: true,
  });

  if (isLoading && !data) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading job statistics...
      </div>
    );
  }

  if (error || data?.error) {
    return (
      <div className="flex h-64 items-center justify-center text-red-400">
        Failed to load job data. Check Databricks connection.
      </div>
    );
  }

  const { failureRanking = [], durationStats = [] } = data ?? {};

  const filteredFailures = failureRanking
    .filter((row) => {
      if (hideSoftFail && (isSoftFailJob(row.name) || row.has_soft_fail === "1")) return false;
      if (hideOptional && isOptionalJob(row.name)) return false;
      if (searchQuery && !jobNameText(row.name).toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      const av = parseFloat((a as unknown as Record<string, string>)[failureSort.col]) || 0;
      const bv = parseFloat((b as unknown as Record<string, string>)[failureSort.col]) || 0;
      return failureSort.asc ? av - bv : bv - av;
    });

  const filteredDuration = durationStats
    .filter((row) => {
      if (hideOptional && isOptionalJob(row.name)) return false;
      if (searchQuery && !jobNameText(row.name).toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      const av = parseFloat((a as unknown as Record<string, string>)[durationSort.col]) || 0;
      const bv = parseFloat((b as unknown as Record<string, string>)[durationSort.col]) || 0;
      return durationSort.asc ? av - bv : bv - av;
    });

  const totalFailingJobs = filteredFailures.length;
  const worstJob = filteredFailures.reduce<FailureRow | null>(
    (best, row) => (!best || parseFloat(row.failure_rate) > parseFloat(best.failure_rate) ? row : best),
    null
  );
  const slowestJob = filteredDuration.reduce<DurationRow | null>(
    (best, row) => (!best || parseInt(row.p50_duration, 10) > parseInt(best.p50_duration, 10) ? row : best),
    null
  );
  const maxP50 = Math.max(
    ...filteredDuration.map((d) => parseInt(d.p50_duration, 10) || 0),
    1
  );

  function toggleFailureSort(col: string) {
    setFailureSort((prev) => ({
      col,
      asc: prev.col === col ? !prev.asc : false,
    }));
    setPage(0);
  }

  function toggleDurationSort(col: string) {
    setDurationSort((prev) => ({
      col,
      asc: prev.col === col ? !prev.asc : false,
    }));
    setPage(0);
  }

  function SortArrow({ active, asc }: { active: boolean; asc: boolean }) {
    if (!active) return <span className="ml-1 text-zinc-300 dark:text-zinc-600">↕</span>;
    return <span className="ml-1">{asc ? "↑" : "↓"}</span>;
  }

  const runsParams = new URLSearchParams();
  if (pipeline) runsParams.set("pipeline", pipeline);
  if (branch) runsParams.set("branch", branch);
  if (startDate) runsParams.set("startDate", startDate);
  if (endDate) runsParams.set("endDate", endDate);

  function ExpandedJobRow({ jobName, colSpan }: { jobName: string; colSpan: number }) {
    const url = `/api/jobs/runs?${runsParams.toString()}&jobName=${encodeURIComponent(jobName)}`;
    const { data, isLoading } = useSWR<{ runs: JobRun[] }>(url, fetcher);
    const detailHref =
      `/jobs/${encodeURIComponent(jobName)}?` +
      new URLSearchParams({
        pipeline,
        branch,
        start: startDate,
        end: endDate,
      }).toString();
    return (
      <tr>
        <td colSpan={colSpan} className="bg-surface-muted/60 px-5 py-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-xs text-muted">
              {analysisTab === "failures" ? "Pass/fail per run" : "Duration per run"} over the selected range.
            </p>
            <Link
              href={detailHref}
              className="dashboard-control text-xs font-medium text-accent hover:text-accent-strong"
            >
              Open job page →
            </Link>
          </div>
          <JobRunsChart
            runs={data?.runs ?? []}
            mode={analysisTab}
            loading={isLoading}
          />
        </td>
      </tr>
    );
  }

  function toggleExpanded(name: string) {
    setExpandedJob((prev) => (prev === name ? null : name));
  }

  const activeList = analysisTab === "failures" ? filteredFailures : filteredDuration;
  const totalItems = activeList.length;
  const totalPages = Math.ceil(totalItems / pageSize);
  const pagedFailures = filteredFailures.slice(page * pageSize, (page + 1) * pageSize);
  const pagedDuration = filteredDuration.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Jobs with Failures"
          value={totalFailingJobs}
          color={totalFailingJobs > 10 ? "red" : totalFailingJobs > 0 ? "yellow" : "green"}
        />
        <StatCard
          label="Highest Failure Rate"
          value={worstJob ? `${worstJob.failure_rate}%` : "—"}
          detail={worstJob ? jobNameText(worstJob.name) : undefined}
          color="red"
        />
        <StatCard
          label="Slowest Job (p50)"
          value={slowestJob ? formatDuration(parseInt(slowestJob.p50_duration, 10)) : "—"}
          detail={slowestJob ? jobNameText(slowestJob.name) : undefined}
        />
        <StatCard
          label="Total Jobs Tracked"
          value={filteredDuration.length}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-3 border-b border-line sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div
          role="tablist"
          aria-label="Job rankings"
          className="scrollbar-hidden -mb-px flex min-w-0 gap-5 overflow-x-auto"
        >
          {([
            ["failures", "Failure Ranking"],
            ["duration", "Duration Ranking"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={analysisTab === value}
              onClick={() => { setAnalysisTab(value); setPage(0); }}
              className={`dashboard-control -mb-px inline-flex min-h-10 shrink-0 items-center whitespace-nowrap border-b-2 px-0.5 text-sm font-medium ${
                analysisTab === value
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 pb-2 sm:justify-end sm:pb-1">
          <input
            type="text"
            placeholder="Search jobs..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
            className="h-11 min-w-0 flex-1 rounded-md border border-line bg-white px-3 text-sm text-foreground placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400 sm:h-10 sm:w-48 sm:flex-none dark:bg-zinc-900 dark:placeholder-zinc-500 dark:focus:ring-zinc-500"
          />
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted sm:min-h-10">
            <input
              type="checkbox"
              checked={hideSoftFail}
              onChange={(e) => { setHideSoftFail(e.target.checked); setPage(0); }}
              className="rounded border-zinc-300"
            />
            Hide soft fail
          </label>
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted sm:min-h-10">
            <input
              type="checkbox"
              checked={hideOptional}
              onChange={(e) => { setHideOptional(e.target.checked); setPage(0); }}
              className="rounded border-zinc-300"
            />
            Hide optional
          </label>
        </div>
      </div>

      {analysisTab === "failures" && (
        <div className="rounded-lg border border-line bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="px-5 py-2.5 font-medium">#</th>
                  <th className="px-5 py-2.5 font-medium">Job</th>
                  <th className="cursor-pointer select-none px-5 py-2.5 font-medium hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => toggleFailureSort("failure_rate")}>
                    Failure Rate<SortArrow active={failureSort.col === "failure_rate"} asc={failureSort.asc} />
                  </th>
                  <th className="cursor-pointer select-none px-5 py-2.5 font-medium hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => toggleFailureSort("failures")}>
                    Failures<SortArrow active={failureSort.col === "failures"} asc={failureSort.asc} />
                  </th>
                  <th className="cursor-pointer select-none px-5 py-2.5 font-medium hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => toggleFailureSort("passes")}>
                    Passes<SortArrow active={failureSort.col === "passes"} asc={failureSort.asc} />
                  </th>
                  <th className="cursor-pointer select-none px-5 py-2.5 font-medium hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => toggleFailureSort("total_runs")}>
                    Total Runs<SortArrow active={failureSort.col === "total_runs"} asc={failureSort.asc} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedFailures.map((row, i) => (
                  <Fragment key={row.name}>
                    <tr
                      className={`cursor-pointer border-b border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/30 ${expandedJob === row.name ? "bg-surface-muted/60" : ""}`}
                      onClick={() => toggleExpanded(row.name)}
                    >
                      <td className="px-5 py-2.5 text-zinc-400">{page * pageSize + i + 1}</td>
                      <td className="px-5 py-2.5 font-medium">
                        <JobName name={row.name} />
                        <JobBadges name={row.name} hasSoftFail={row.has_soft_fail === "1"} />
                      </td>
                      <td className="px-5 py-2.5">
                        <FailureBar rate={parseFloat(row.failure_rate)} />
                      </td>
                      <td className="px-5 py-2.5 text-red-600 dark:text-red-400">
                        {row.failures}
                      </td>
                      <td className="px-5 py-2.5 text-emerald-600 dark:text-emerald-400">
                        {row.passes}
                      </td>
                      <td className="px-5 py-2.5 text-zinc-500">{row.total_runs}</td>
                    </tr>
                    {expandedJob === row.name && (
                      <ExpandedJobRow jobName={row.name} colSpan={6} />
                    )}
                  </Fragment>
                ))}
                {pagedFailures.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-zinc-400">
                      No job failures in this period
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {analysisTab === "duration" && (
        <div className="rounded-lg border border-line bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="px-5 py-2.5 font-medium">#</th>
                  <th className="px-5 py-2.5 font-medium">Job</th>
                  <th className="cursor-pointer select-none px-5 py-2.5 font-medium hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => toggleDurationSort("p50_duration")}>
                    Median (p50)<SortArrow active={durationSort.col === "p50_duration"} asc={durationSort.asc} />
                  </th>
                  <th className="cursor-pointer select-none px-5 py-2.5 font-medium hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => toggleDurationSort("p90_duration")}>
                    p90<SortArrow active={durationSort.col === "p90_duration"} asc={durationSort.asc} />
                  </th>
                  <th className="cursor-pointer select-none px-5 py-2.5 font-medium hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => toggleDurationSort("avg_duration")}>
                    Avg<SortArrow active={durationSort.col === "avg_duration"} asc={durationSort.asc} />
                  </th>
                  <th className="cursor-pointer select-none px-5 py-2.5 font-medium hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => toggleDurationSort("max_duration")}>
                    Max<SortArrow active={durationSort.col === "max_duration"} asc={durationSort.asc} />
                  </th>
                  <th className="cursor-pointer select-none px-5 py-2.5 font-medium hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => toggleDurationSort("total_runs")}>
                    Runs<SortArrow active={durationSort.col === "total_runs"} asc={durationSort.asc} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedDuration.map((row, i) => (
                  <Fragment key={row.name}>
                    <tr
                      className={`cursor-pointer border-b border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/30 ${expandedJob === row.name ? "bg-surface-muted/60" : ""}`}
                      onClick={() => toggleExpanded(row.name)}
                    >
                      <td className="px-5 py-2.5 text-zinc-400">{page * pageSize + i + 1}</td>
                      <td className="px-5 py-2.5 font-medium">
                        <JobName name={row.name} />
                        <JobBadges name={row.name} hasSoftFail={false} />
                      </td>
                      <td className="px-5 py-2.5">
                        <DurationBar
                          secs={parseInt(row.p50_duration, 10)}
                          maxSecs={maxP50}
                        />
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-zinc-600 dark:text-zinc-400">
                        {formatDuration(parseInt(row.p90_duration, 10))}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-zinc-600 dark:text-zinc-400">
                        {formatDuration(parseInt(row.avg_duration, 10))}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-zinc-600 dark:text-zinc-400">
                        {formatDuration(parseInt(row.max_duration, 10))}
                      </td>
                      <td className="px-5 py-2.5 text-zinc-500">{row.total_runs}</td>
                    </tr>
                    {expandedJob === row.name && (
                      <ExpandedJobRow jobName={row.name} colSpan={7} />
                    )}
                  </Fragment>
                ))}
                {pagedDuration.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-8 text-center text-zinc-400">
                      No job duration data
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted">
            Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, totalItems)} of {totalItems} jobs
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="min-h-11 rounded-md border border-line px-3 text-sm font-medium transition-colors hover:bg-zinc-100 active:scale-[0.98] disabled:opacity-40 disabled:hover:bg-transparent sm:min-h-10 dark:hover:bg-zinc-800"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page + 1 >= totalPages}
              className="min-h-11 rounded-md border border-line px-3 text-sm font-medium transition-colors hover:bg-zinc-100 active:scale-[0.98] disabled:opacity-40 disabled:hover:bg-transparent sm:min-h-10 dark:hover:bg-zinc-800"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main page ── */
const JOBS_URL_DEFAULTS = {
  pipeline: "CI",
  branch: "main",
  start: "",
  end: "",
  tab: "failures",
  page: "0",
  softfail: "",
  optional: "",
};

function JobsPageContent() {
  const [url, setUrl] = useUrlState(JOBS_URL_DEFAULTS);
  const pipeline = url.pipeline;
  const branch = url.branch;
  const startDate = url.start || isoDate(14);
  const endDate = url.end || isoDate(0);
  const setPipeline = (next: string) => setUrl({ pipeline: next, page: "0" });
  const setBranch = (next: string) => setUrl({ branch: next, page: "0" });
  const setStartDate = (next: string) => setUrl({ start: next, page: "0" });
  const setEndDate = (next: string) => setUrl({ end: next, page: "0" });

  const { data: filters } = useSWR<FiltersResponse>(
    "/api/builds/filters",
    fetcher
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jobs"
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

      <JobAnalysisTab
        pipeline={pipeline}
        branch={branch}
        startDate={startDate}
        endDate={endDate}
      />
    </div>
  );
}

export default function JobsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center text-sm text-muted">
          Loading jobs...
        </div>
      }
    >
      <JobsPageContent />
    </Suspense>
  );
}
