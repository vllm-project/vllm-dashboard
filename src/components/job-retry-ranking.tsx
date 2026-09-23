"use client";

import { Fragment, useState, type ReactNode } from "react";
import useSWR from "swr";
import { JobName, jobNameText } from "@/components/job-name";
import { StatCard } from "@/components/stat-card";
import { JobRunHistory } from "@/components/job-run-history";
import { isOptionalJob, isSoftFailJob } from "@/lib/optional-jobs";

export interface RetryJob {
  name: string;
  retries: number;
  total_runs: number;
  has_soft_fail: boolean;
}

interface RetryResponse {
  retryRanking: RetryJob[];
  source: "otel" | "databricks";
  error?: string;
}

interface RetryFilters {
  searchQuery: string;
  hideSoftFail: boolean;
  hideOptional: boolean;
}

function searchableJobName(name: string): string {
  const text = jobNameText(name);
  // Vendor shortcodes render as icons, but should remain searchable. Older
  // AMD CI labels identify the vendor through their device prefix instead.
  if (/:amd:/i.test(name) || /^AMD: /i.test(name) || /^mi\d+[A-Z]?_\d+:/i.test(name)) {
    return `AMD ${text}`;
  }
  if (/:nvidia:/i.test(name)) return `NVIDIA ${text}`;
  return text;
}

// The ranking and summary cards describe the same filtered set of jobs.
export function filterRetryJobs(jobs: RetryJob[], filters: RetryFilters): RetryJob[] {
  const query = filters.searchQuery.trim().toLowerCase();
  return jobs.filter((job) => {
    if (!(job.retries > 0)) return false;
    if (filters.hideSoftFail && (job.has_soft_fail || isSoftFailJob(job.name))) return false;
    if (filters.hideOptional && isOptionalJob(job.name)) return false;
    return searchableJobName(job.name).toLowerCase().includes(query);
  });
}

async function fetchRetries(url: string): Promise<RetryResponse> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to load retry data");
  const data: RetryResponse = await response.json();
  if (data.error) throw new Error(data.error);
  return data;
}

type SortColumn = "name" | "retries" | "total_runs";

export function retryHistoryUrl(apiUrl: string, jobName: string, source?: RetryResponse["source"]): string {
  const params = new URLSearchParams(apiUrl.split("?")[1] ?? "");
  params.set("jobName", jobName);
  if (source) params.set("source", source);
  return `/api/jobs/retries/runs?${params.toString()}`;
}

function RetryCountBar({ retries, maxRetries }: { retries: number; maxRetries: number }) {
  const width = maxRetries > 0 ? Math.min(100, 100 * retries / maxRetries) : 0;
  return (
    <div className="flex items-center gap-2">
      <div aria-hidden="true" className="h-2 w-24 shrink-0 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className="h-full rounded-full bg-amber-500" style={{ width: `${width}%` }} />
      </div>
      <span className={`font-medium tabular-nums ${retries > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}>
        {retries.toLocaleString()}
      </span>
    </div>
  );
}

export function JobRetryRanking({
  apiUrl,
  controls,
  searchQuery,
  hideSoftFail,
  hideOptional,
}: RetryFilters & { apiUrl: string; controls: ReactNode }) {
  const [sort, setSort] = useState<{ col: SortColumn; asc: boolean }>({ col: "retries", asc: false });
  const [pagination, setPagination] = useState({ scope: "", page: 0 });
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const { data, error, isLoading, mutate } = useSWR<RetryResponse>(apiUrl, fetchRetries, {
    refreshInterval: 5 * 60 * 1000,
  });

  const jobs = filterRetryJobs(data?.retryRanking ?? [], { searchQuery, hideSoftFail, hideOptional })
    .sort((a, b) => {
      const comparison = sort.col === "name"
        ? jobNameText(a.name).localeCompare(jobNameText(b.name))
        : a[sort.col] - b[sort.col];
      return (sort.asc ? comparison : -comparison) || a.name.localeCompare(b.name);
    });
  const totalRetries = jobs.reduce((sum, job) => sum + job.retries, 0);
  const totalAttempts = jobs.reduce((sum, job) => sum + job.total_runs, 0);
  const hasRetriesInPeriod = data?.retryRanking.some(job => job.retries > 0);
  const mostRetried = jobs.reduce<RetryJob | null>(
    (best, job) => job.retries > (best?.retries ?? 0) ? job : best,
    null,
  );
  const pageSize = 20;
  const scope = JSON.stringify([apiUrl, searchQuery, hideSoftFail, hideOptional, sort]);
  // Forget the previous page when filters change, including when a search is
  // cleared back to an earlier selection.
  if (pagination.scope !== scope) {
    setPagination({ scope, page: 0 });
  }
  const totalPages = Math.ceil(jobs.length / pageSize);
  const page = Math.min(pagination.scope === scope ? pagination.page : 0, Math.max(0, totalPages - 1));
  const pagedJobs = jobs.slice(page * pageSize, (page + 1) * pageSize);

  function toggleSort(col: SortColumn) {
    setSort((previous) => ({ col, asc: previous.col === col ? !previous.asc : col === "name" }));
  }

  function toggleJob(name: string) {
    setExpandedJob((previous) => previous === name ? null : name);
  }

  function sortHeader(col: SortColumn, label: string) {
    const active = sort.col === col;
    return (
      <th
        scope="col"
        aria-sort={active ? (sort.asc ? "ascending" : "descending") : "none"}
        className="px-5 py-2.5 font-medium"
      >
        <button
          type="button"
          onClick={() => toggleSort(col)}
          className="min-h-8 whitespace-nowrap hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-4 dark:hover:text-zinc-100"
        >
          {label}
          <span aria-hidden="true" className={`ml-1 ${active ? "" : "text-zinc-300 dark:text-zinc-600"}`}>
            {active ? (sort.asc ? "↑" : "↓") : "↕"}
          </span>
        </button>
      </th>
    );
  }

  return (
    <div className="space-y-6">
      {data && !error && (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <StatCard label="Total Retries" value={totalRetries.toLocaleString()} color={totalRetries > 0 ? "yellow" : "green"} />
          <StatCard label="Jobs with Retries" value={jobs.length} color={jobs.length > 0 ? "yellow" : "green"} />
          <StatCard label="Most Retried Job" value={mostRetried?.retries.toLocaleString() ?? "0"} detail={mostRetried ? jobNameText(mostRetried.name) : "No retries in the current selection"} color={mostRetried ? "yellow" : "green"} />
          <StatCard label="Total Attempts" value={totalAttempts.toLocaleString()} />
        </div>
      )}

      {controls}

      <p className="text-sm leading-6 text-zinc-500 dark:text-zinc-400">
        Counts each additional Buildkite job attempt once, whether it passes or fails.
        Only jobs with retries are shown. The time range applies to attempt start time.
        {" "}Select a job to see its attempt history.
        {" "}Bars compare counts with the most-retried job in the current selection.
        {data?.source === "otel" && " Only completed attempts reported by Buildkite are available."}
      </p>

      {isLoading && !data ? (
        <div role="status" className="flex h-64 items-center justify-center text-zinc-400">
          Loading job retry statistics...
        </div>
      ) : error ? (
        <div role="alert" className="flex h-64 flex-col items-center justify-center gap-3 text-red-600 dark:text-red-400">
          <p>Failed to load job retry data.</p>
          <button type="button" onClick={() => { void mutate(); }} className="min-h-11 rounded-md border border-zinc-200 px-3 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <div className="overflow-x-auto [container-type:inline-size]">
              <table className="w-full text-sm">
                <caption className="sr-only">Buildkite job retries</caption>
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    <th scope="col" className="px-5 py-2.5 font-medium">#</th>
                    {sortHeader("name", "Job")}
                    {sortHeader("retries", "Retries")}
                    {sortHeader("total_runs", "Total Attempts")}
                  </tr>
                </thead>
                <tbody>
                  {pagedJobs.map((job, index) => (
                    <Fragment key={job.name}>
                      <tr onClick={() => toggleJob(job.name)} className={`cursor-pointer border-b border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/30 ${expandedJob === job.name ? "bg-zinc-50 dark:bg-zinc-900/30" : ""}`}>
                        <td className="px-5 py-2.5 text-zinc-400">{page * pageSize + index + 1}</td>
                        <th scope="row" className="px-5 py-2.5 text-left font-medium">
                          <button
                            type="button"
                            aria-expanded={expandedJob === job.name}
                            onClick={(event) => { event.stopPropagation(); toggleJob(job.name); }}
                            className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-4"
                          >
                            <span aria-hidden="true" className="text-zinc-400">{expandedJob === job.name ? "▾" : "▸"}</span>
                            <span><JobName name={job.name} /></span>
                          </button>
                          {(job.has_soft_fail || isSoftFailJob(job.name)) && (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">soft fail</span>
                          )}
                          {isOptionalJob(job.name) && (
                            <span className="ml-2 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-400">optional</span>
                          )}
                        </th>
                        <td className="px-5 py-2.5"><RetryCountBar retries={job.retries} maxRetries={mostRetried?.retries ?? 0} /></td>
                        <td className="px-5 py-2.5 tabular-nums text-zinc-500 dark:text-zinc-400">{job.total_runs.toLocaleString()}</td>
                      </tr>
                      {expandedJob === job.name && (
                        <tr>
                          <td colSpan={4} className="bg-zinc-50 px-5 py-4 dark:bg-zinc-900/50">
                            {/* Keep history within the visible table viewport, including when its columns scroll. */}
                            <div className="sticky left-5 w-[calc(100cqw-2.5rem)]">
                              <JobRunHistory apiUrl={retryHistoryUrl(apiUrl, job.name, data?.source)} mode="retries" />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {pagedJobs.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-5 py-8 text-center text-zinc-400">
                        {hasRetriesInPeriod ? "No retries match the current filters" : "No retries in this period"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, jobs.length)} of {jobs.length} jobs
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setPagination({ scope, page: page - 1 })} disabled={page === 0} className="min-h-11 rounded-md border border-zinc-200 px-3 text-sm font-medium transition-colors hover:bg-zinc-100 active:scale-[0.98] disabled:opacity-40 disabled:hover:bg-transparent sm:min-h-10 dark:border-zinc-700 dark:hover:bg-zinc-800">
                  Previous
                </button>
                <button type="button" onClick={() => setPagination({ scope, page: page + 1 })} disabled={page + 1 >= totalPages} className="min-h-11 rounded-md border border-zinc-200 px-3 text-sm font-medium transition-colors hover:bg-zinc-100 active:scale-[0.98] disabled:opacity-40 disabled:hover:bg-transparent sm:min-h-10 dark:border-zinc-700 dark:hover:bg-zinc-800">
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
