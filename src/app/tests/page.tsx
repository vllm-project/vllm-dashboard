"use client";

import { Fragment, useDeferredValue, useMemo, useState } from "react";
import useSWR from "swr";

type Period = "1hour" | "4hours" | "1day" | "7days" | "14days" | "28days";
type TestState = "all" | "enabled" | "muted" | "skipped";
type TestLabel = "all" | "flaky";
type SortBy = "reliability" | "duration_avg";

interface TestRecord {
  id: string;
  web_url: string;
  scope: string;
  name: string;
  location: string | null;
  file_name: string | null;
  labels: string[];
  reliability: number | null;
  duration_avg: number;
  duration_sum: number;
  duration_min: number;
  duration_max: number;
  executions_count: number;
  executions_count_by_result: Record<string, number>;
}

interface TestsResponse {
  tests: TestRecord[];
  pagination: { page: number; pageSize: number; hasNext: boolean };
  suite: { name: string; slug: string; organization: string };
  error?: string;
}

const periods: Array<{ value: Period; label: string }> = [
  { value: "1hour", label: "1h" },
  { value: "4hours", label: "4h" },
  { value: "1day", label: "1d" },
  { value: "7days", label: "7d" },
  { value: "14days", label: "14d" },
  { value: "28days", label: "28d" },
];

async function fetcher(url: string): Promise<TestsResponse> {
  const response = await fetch(url);
  const data = (await response.json()) as TestsResponse;
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) {
    return seconds < 10 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatReliability(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const percent = value * 100;
  return `${percent < 99 ? percent.toFixed(1) : percent.toFixed(2)}%`;
}

function reliabilityTone(value: number | null) {
  if (value == null) return "bg-zinc-300 dark:bg-zinc-700";
  if (value < 0.95) return "bg-rose-500";
  if (value < 0.99) return "bg-amber-500";
  return "bg-emerald-500";
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={`h-4 w-4 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="m7.5 4.5 5 5.5-5 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path d="M11 4h5v5M16 4l-7 7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 11v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="8.5" cy="8.5" r="4.5" />
      <path d="m12 12 4 4" strokeLinecap="round" />
    </svg>
  );
}

function SortMark({ active, order }: { active: boolean; order: "asc" | "desc" }) {
  return (
    <span aria-hidden="true" className={active ? "text-blue-600 dark:text-blue-400" : "text-zinc-300 dark:text-zinc-700"}>
      {active ? (order === "asc" ? "↑" : "↓") : "↕"}
    </span>
  );
}

function HistoryPanel({ test }: { test: TestRecord }) {
  const results = test.executions_count_by_result ?? {};
  const passed = results.passed ?? 0;
  const failed = results.failed ?? 0;
  const skipped = results.skipped ?? 0;
  const pending = results.pending ?? 0;
  const decided = passed + failed;
  const passWidth = decided > 0 ? (passed / decided) * 100 : 0;

  return (
    <div className="grid gap-5 px-5 py-5 sm:px-7 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="mb-2 flex items-center justify-between gap-4">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
            Results in this window
          </p>
          <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
            {test.executions_count.toLocaleString()} executions
          </p>
        </div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden="true">
          {decided > 0 && (
            <>
              <div className="bg-emerald-500" style={{ width: `${passWidth}%` }} />
              <div className="bg-rose-500" style={{ width: `${100 - passWidth}%` }} />
            </>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs tabular-nums">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {passed.toLocaleString()} passed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-rose-500" />
            {failed.toLocaleString()} failed
          </span>
          {skipped > 0 && <span className="text-zinc-500">{skipped.toLocaleString()} skipped</span>}
          {pending > 0 && <span className="text-zinc-500">{pending.toLocaleString()} pending</span>}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 lg:justify-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400">Duration range</p>
          <p className="mt-1 text-sm font-medium tabular-nums">
            {formatDuration(test.duration_min)} – {formatDuration(test.duration_max)}
          </p>
        </div>
        <a
          href={test.web_url}
          target="_blank"
          rel="noreferrer"
          className="dashboard-control inline-flex min-h-10 items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 shadow-sm hover:border-zinc-300 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:text-zinc-50"
        >
          Open execution history
          <ExternalLinkIcon />
        </a>
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="grid grid-cols-[1fr_120px_100px] gap-6 px-5 py-5 sm:px-7">
          <div className="space-y-2">
            <div className="h-4 w-2/3 animate-pulse rounded bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-zinc-100 motion-reduce:animate-none dark:bg-zinc-900" />
          </div>
          <div className="h-4 animate-pulse rounded bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800" />
          <div className="h-4 animate-pulse rounded bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800" />
        </div>
      ))}
    </div>
  );
}

export default function TestsPage() {
  const [period, setPeriod] = useState<Period>("1day");
  const [state, setState] = useState<TestState>("all");
  const [label, setLabel] = useState<TestLabel>("all");
  const [sortBy, setSortBy] = useState<SortBy>("reliability");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const params = new URLSearchParams({
    period,
    sortBy,
    order,
    page: String(page),
  });
  if (state !== "all") params.set("state", state);
  if (label !== "all") params.set("label", label);

  const { data, error, isLoading, isValidating } = useSWR<TestsResponse>(
    `/api/tests?${params.toString()}`,
    fetcher,
    { refreshInterval: 5 * 60 * 1000, keepPreviousData: true },
  );

  const visibleTests = useMemo(() => {
    if (!deferredQuery) return data?.tests ?? [];
    return (data?.tests ?? []).filter((test) =>
      [test.scope, test.name, test.location, ...test.labels]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(deferredQuery)),
    );
  }, [data?.tests, deferredQuery]);

  function changePeriod(next: Period) {
    setPeriod(next);
    setPage(1);
    setExpanded(null);
  }

  function changeSort(next: SortBy) {
    if (sortBy === next) {
      setOrder((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(next);
      setOrder(next === "reliability" ? "asc" : "desc");
    }
    setPage(1);
    setExpanded(null);
  }

  const errorMessage = error instanceof Error ? error.message : null;
  const firstItem = (page - 1) * (data?.pagination.pageSize ?? 30) + 1;
  const lastItem = firstItem + (data?.tests.length ?? 0) - 1;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-5 border-b border-zinc-200 pb-6 dark:border-zinc-800 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-blue-600 dark:text-blue-400">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
            CI · Test Engine
          </div>
          <h1 className="text-2xl font-semibold sm:text-3xl">Tests</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
            Find unreliable tests and inspect their results over time.
          </p>
        </div>
        <div className="inline-flex w-fit rounded-lg border border-zinc-200 bg-white p-1 shadow-sm dark:border-zinc-800 dark:bg-zinc-950" aria-label="History window">
          {periods.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={period === item.value}
              onClick={() => changePeriod(item.value)}
              className={`dashboard-control min-h-9 min-w-10 rounded-md px-2.5 text-sm font-medium tabular-nums sm:min-w-11 ${
                period === item.value
                  ? "bg-blue-50 text-blue-700 shadow-sm ring-1 ring-blue-100 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-400/20"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-4 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="test-state">Test state</label>
            <select
              id="test-state"
              value={state}
              onChange={(event) => {
                setState(event.target.value as TestState);
                setPage(1);
                setExpanded(null);
              }}
              className="dashboard-control min-h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
            >
              <option value="all">All states</option>
              <option value="enabled">Enabled</option>
              <option value="muted">Muted</option>
              <option value="skipped">Skipped</option>
            </select>
            <label className="sr-only" htmlFor="test-label">Test label</label>
            <select
              id="test-label"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value as TestLabel);
                setPage(1);
                setExpanded(null);
              }}
              className="dashboard-control min-h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
            >
              <option value="all">All tests</option>
              <option value="flaky">Flaky only</option>
            </select>
          </div>
          <label className="relative block w-full sm:w-72">
            <span className="sr-only">Search tests on this page</span>
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-400">
              <SearchIcon />
            </span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search this page"
              className="dashboard-control min-h-10 w-full rounded-md border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm shadow-sm placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        </div>

        {errorMessage ? (
          <div className="flex min-h-72 items-center justify-center px-6 py-12 text-center">
            <div className="max-w-lg">
              <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-rose-50 text-lg text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">!</div>
              <h2 className="text-base font-semibold">Tests are not available</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{errorMessage}</p>
            </div>
          </div>
        ) : isLoading ? (
          <LoadingRows />
        ) : (
          <>
            <div className="divide-y divide-zinc-200 md:hidden dark:divide-zinc-800">
              {visibleTests.map((test) => {
                const isOpen = expanded === test.id;
                const failed = test.executions_count_by_result?.failed ?? 0;
                return (
                  <div key={test.id} className={isOpen ? "bg-blue-50/40 dark:bg-blue-500/[0.04]" : ""}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : test.id)}
                      className="group w-full px-4 py-4 text-left"
                    >
                      <span className="flex min-w-0 items-start gap-2.5">
                        <span className="mt-0.5 shrink-0 text-zinc-400 group-hover:text-zinc-700 dark:group-hover:text-zinc-200">
                          <Chevron open={isOpen} />
                        </span>
                        <span className="min-w-0">
                          <span className="line-clamp-2 break-words text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {test.scope ? `${test.scope} · ` : ""}{test.name}
                          </span>
                          <span className="mt-1 block truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                            {test.location || test.file_name || "Location not reported"}
                          </span>
                          {test.labels.length > 0 && (
                            <span className="mt-2 flex flex-wrap gap-1">
                              {test.labels.map((label) => (
                                <span key={label} className={`rounded px-1.5 py-0.5 font-sans text-[10px] font-medium ${label === "flaky" ? "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"}`}>{label}</span>
                              ))}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="mt-4 grid grid-cols-3 gap-3 pl-6.5">
                        <span>
                          <span className="block font-mono text-[9px] uppercase tracking-[0.08em] text-zinc-400">Reliability</span>
                          <span className="mt-1 flex items-center gap-2 text-sm font-semibold tabular-nums">
                            <span className={`h-4 w-1 rounded-full ${reliabilityTone(test.reliability)}`} />
                            {formatReliability(test.reliability)}
                          </span>
                        </span>
                        <span>
                          <span className="block font-mono text-[9px] uppercase tracking-[0.08em] text-zinc-400">Executions</span>
                          <span className="mt-1 block text-sm font-medium tabular-nums">
                            {test.executions_count.toLocaleString()}
                            {failed > 0 && <span className="ml-1 text-[10px] text-rose-600 dark:text-rose-400">· {failed} failed</span>}
                          </span>
                        </span>
                        <span>
                          <span className="block font-mono text-[9px] uppercase tracking-[0.08em] text-zinc-400">Average</span>
                          <span className="mt-1 block text-sm font-medium tabular-nums">{formatDuration(test.duration_avg)}</span>
                        </span>
                      </span>
                    </button>
                    {isOpen && <HistoryPanel test={test} />}
                  </div>
                );
              })}
            </div>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[760px] table-fixed text-left">
                <thead className="border-b border-zinc-200 bg-zinc-50/70 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
                  <tr>
                    <th className="w-auto px-5 py-3 font-medium sm:px-7">Test</th>
                    <th className="w-36 px-4 py-3 font-medium">Executions</th>
                    <th className="w-40 px-4 py-3 font-medium">
                      <button type="button" onClick={() => changeSort("reliability")} className="inline-flex min-h-8 items-center gap-1.5 rounded px-1 tabular-nums hover:text-zinc-950 dark:hover:text-zinc-100">
                        Reliability
                        <SortMark active={sortBy === "reliability"} order={order} />
                      </button>
                    </th>
                    <th className="w-36 px-5 py-3 text-right font-medium sm:px-7">
                      <button type="button" onClick={() => changeSort("duration_avg")} className="inline-flex min-h-8 items-center gap-1.5 rounded px-1 tabular-nums hover:text-zinc-950 dark:hover:text-zinc-100">
                        Avg duration
                        <SortMark active={sortBy === "duration_avg"} order={order} />
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {visibleTests.map((test) => {
                    const isOpen = expanded === test.id;
                    const failed = test.executions_count_by_result?.failed ?? 0;
                    return (
                      <Fragment key={test.id}>
                        <tr className={isOpen ? "bg-blue-50/40 dark:bg-blue-500/[0.04]" : "hover:bg-zinc-50/70 dark:hover:bg-zinc-900/40"}>
                          <td className="px-5 py-4 sm:px-7">
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              onClick={() => setExpanded(isOpen ? null : test.id)}
                              className="group flex min-h-10 w-full min-w-0 items-start gap-3 rounded text-left"
                            >
                              <span className="mt-1 text-zinc-400 group-hover:text-zinc-700 dark:group-hover:text-zinc-200"><Chevron open={isOpen} /></span>
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                  {test.scope ? `${test.scope} · ` : ""}{test.name}
                                </span>
                                <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                                  <span className="truncate font-mono">{test.location || test.file_name || "Location not reported"}</span>
                                  {test.labels.map((label) => (
                                    <span key={label} className={`shrink-0 rounded px-1.5 py-0.5 font-sans text-[10px] font-medium ${label === "flaky" ? "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"}`}>{label}</span>
                                  ))}
                                </span>
                              </span>
                            </button>
                          </td>
                          <td className="px-4 py-4 text-sm tabular-nums">
                            <span className="font-medium">{test.executions_count.toLocaleString()}</span>
                            {failed > 0 && <span className="ml-2 text-xs text-rose-600 dark:text-rose-400">· {failed} failed</span>}
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex items-center gap-3">
                              <span className={`h-8 w-1 rounded-full ${reliabilityTone(test.reliability)}`} />
                              <span className="text-sm font-semibold tabular-nums">{formatReliability(test.reliability)}</span>
                            </div>
                          </td>
                          <td className="px-5 py-4 text-right text-sm font-medium tabular-nums sm:px-7">{formatDuration(test.duration_avg)}</td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-zinc-50/80 dark:bg-zinc-900/50">
                            <td colSpan={4}><HistoryPanel test={test} /></td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {visibleTests.length === 0 && (
              <div className="flex min-h-56 items-center justify-center px-6 py-12 text-center">
                <div>
                  <h2 className="text-sm font-semibold">No tests match this view</h2>
                  <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                    {query ? "Clear the page search or change the filters." : "Try a longer history window or another filter."}
                  </p>
                </div>
              </div>
            )}

            <footer className="flex flex-col gap-3 border-t border-zinc-200 px-5 py-4 text-sm dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between sm:px-7">
              <p className="text-zinc-500 dark:text-zinc-400">
                {data?.tests.length ? `Tests ${firstItem.toLocaleString()}–${lastItem.toLocaleString()}` : "No tests"}
                {query && ` · ${visibleTests.length} match${visibleTests.length === 1 ? "" : "es"} on this page`}
                {isValidating && <span className="ml-2 text-blue-600 dark:text-blue-400">Refreshing…</span>}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page === 1}
                  onClick={() => { setPage((value) => Math.max(1, value - 1)); setExpanded(null); }}
                  className="dashboard-control min-h-10 rounded-md border border-zinc-200 bg-white px-3 font-medium shadow-sm hover:border-zinc-300 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={!data?.pagination.hasNext}
                  onClick={() => { setPage((value) => value + 1); setExpanded(null); }}
                  className="dashboard-control min-h-10 rounded-md border border-zinc-200 bg-white px-3 font-medium shadow-sm hover:border-zinc-300 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600"
                >
                  Next
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
