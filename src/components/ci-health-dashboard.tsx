"use client";

import Link from "next/link";
import useSWR from "swr";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}`);
  return response.json();
};

interface BuildSummary {
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  };
  builds: BuildRow[];
  error?: string;
}

interface BuildRow {
  number: string | null;
  url: string | null;
  state: string;
  commit: string | null;
  author: string | null;
  pr: string | null;
  message: string;
  created_at: string | null;
  duration_mins: number | null;
}

interface FailureRow {
  name: string;
  total_runs: string;
  failures: string;
  passes: string;
  failure_rate: string;
  has_soft_fail: string;
}

interface JobsSummary {
  failureRanking: FailureRow[];
  error?: string;
}

const base = "pipeline=CI&branch=main&hours=24&format=json&jobs=false";
const currentSummaryUrl = `/api/builds/summary?${base}&per_page=1`;
const priorSummaryUrl = `/api/builds/summary?${base}&offsetHours=24&per_page=1`;
const recentFailuresUrl =
  `/api/builds/summary?${base}&state=failed&per_page=10`;
const firstFailureUrl =
  `/api/builds/summary?${base}&state=failed&order=asc&per_page=1`;
const currentJobsUrl = "/api/jobs?pipeline=CI&branch=main&hours=24";
const priorJobsUrl =
  "/api/jobs?pipeline=CI&branch=main&hours=24&offsetHours=24";

function number(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDelta(value: number): string {
  if (value === 0) return "No change vs prior 24h";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)} pts vs prior 24h`;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unknown time";
  const parsed = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function KpiCard({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "good" | "warning" | "critical";
}) {
  const toneClass = {
    neutral: "text-zinc-950 dark:text-zinc-50",
    good: "text-emerald-700 dark:text-emerald-400",
    warning: "text-amber-700 dark:text-amber-400",
    critical: "text-red-700 dark:text-red-400",
  }[tone];

  return (
    <article className="min-w-0 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
        {label}
      </p>
      <p className={`mt-2 truncate text-2xl font-bold tracking-[-0.03em] ${toneClass}`}>
        {value}
      </p>
      <p className="mt-1.5 min-h-8 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
        {detail}
      </p>
    </article>
  );
}

function ComparisonBar({
  label,
  passRate,
  failures,
  total,
}: {
  label: string;
  passRate: number;
  failures: number;
  total: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4 text-[11px]">
        <span className="font-semibold text-zinc-700 dark:text-zinc-300">
          {label}
        </span>
        <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
          {passRate}% pass · {failures} failed · {total} total
        </span>
      </div>
      <div
        className="mt-2 flex h-3 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
        aria-label={`${label}: ${passRate}% pass rate`}
      >
        <div
          className="bg-emerald-500"
          style={{ width: `${Math.max(0, Math.min(100, passRate))}%` }}
        />
        <div className="min-w-0 flex-1 bg-red-400" />
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-zinc-200 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800">
      <div>
        <h2 className="text-[13px] font-semibold text-zinc-950 dark:text-zinc-50">
          {title}
        </h2>
        <p className="mt-0.5 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-5" aria-label="Loading CI Health summary">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-32 animate-pulse rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
      <div className="h-72 animate-pulse rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
    </div>
  );
}

export function CiHealthDashboard() {
  const current = useSWR<BuildSummary>(currentSummaryUrl, fetcher);
  const prior = useSWR<BuildSummary>(priorSummaryUrl, fetcher);
  const recentFailures = useSWR<BuildSummary>(recentFailuresUrl, fetcher);
  const firstFailure = useSWR<BuildSummary>(firstFailureUrl, fetcher);
  const currentJobs = useSWR<JobsSummary>(currentJobsUrl, fetcher);
  const priorJobs = useSWR<JobsSummary>(priorJobsUrl, fetcher);

  const requests = [
    current,
    prior,
    recentFailures,
    firstFailure,
    currentJobs,
    priorJobs,
  ];
  const loading = requests.some((request) => request.isLoading);
  const failed = requests.some((request) => request.error);

  if (loading) return <LoadingState />;

  if (failed || !current.data || !prior.data || !currentJobs.data || !priorJobs.data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
        CI Health could not load all live data. Builds and Jobs remain available in their tabs.
      </div>
    );
  }

  const currentStats = current.data.summary;
  const priorStats = prior.data.summary;
  const currentFailureRows = currentJobs.data.failureRanking ?? [];
  const priorFailureNames = new Set(
    (priorJobs.data.failureRanking ?? []).map((row) => row.name),
  );
  const newFailureClusters = currentFailureRows.filter(
    (row) => number(row.failures) > 0 && !priorFailureNames.has(row.name),
  );
  const intermittentJobs = currentFailureRows.filter((row) => {
    const rate = number(row.failure_rate);
    return number(row.failures) >= 2 && rate > 0 && rate < 20;
  });
  const firstFailedBuild = firstFailure.data?.builds?.[0];
  const failureRows = (recentFailures.data?.builds ?? []).filter((build) =>
    ["failed", "failing", "broken", "timed_out"].includes(build.state),
  );
  const passDelta = currentStats.passRate - priorStats.passRate;
  const concentratedFailures = [...currentFailureRows]
    .sort((a, b) => {
      const failures = number(b.failures) - number(a.failures);
      return failures || number(b.failure_rate) - number(a.failure_rate);
    })
    .slice(0, 6);

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[28px] font-bold leading-[34px] tracking-[-0.03em] text-zinc-950 dark:text-zinc-50">
            CI Health summary
          </h1>
          <p className="mt-1 text-[13px] leading-5 text-zinc-500 dark:text-zinc-400">
            A live 24-hour rollup. Use Builds for the default operational workflow and Jobs for run-level diagnosis.
          </p>
        </div>
        <span className="inline-flex min-h-8 items-center self-start rounded-full bg-emerald-50 px-3 text-[11px] font-semibold text-emerald-700 sm:self-auto dark:bg-emerald-950/50 dark:text-emerald-300">
          Live · CI / main
        </span>
      </header>

      <section aria-label="CI Health key indicators" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Pass rate"
          value={`${currentStats.passRate}%`}
          detail={`${currentStats.passed} passed of ${currentStats.passed + currentStats.failed} completed · ${formatDelta(passDelta)}`}
          tone={currentStats.passRate >= 95 ? "good" : currentStats.passRate >= 85 ? "warning" : "critical"}
        />
        <KpiCard
          label="New failure clusters"
          value={`${newFailureClusters.length}`}
          detail={
            newFailureClusters.length > 0
              ? `${newFailureClusters.slice(0, 2).map((row) => row.name).join(", ")}${newFailureClusters.length > 2 ? " + more" : ""}`
              : "No failing job names absent from the prior 24h"
          }
          tone={newFailureClusters.length > 0 ? "critical" : "good"}
        />
        <KpiCard
          label="Earliest recent failure"
          value={firstFailedBuild?.commit ?? "None"}
          detail={
            firstFailedBuild
              ? `${formatTimestamp(firstFailedBuild.created_at)} · ${firstFailedBuild.author ?? "Unknown author"}`
              : "No failed builds in the last 24 hours"
          }
          tone={firstFailedBuild ? "critical" : "good"}
        />
        <KpiCard
          label="Intermittent jobs"
          value={`${intermittentJobs.length}`}
          detail="Jobs with 2+ failures and a failure rate below 20%"
          tone={intermittentJobs.length > 0 ? "warning" : "good"}
        />
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.85fr)]">
        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <SectionHeader
            title="Pass rate and failure volume"
            description="Exact rolling windows from live Buildkite data; no calendar-day approximation."
            action={
              <Link
                href="/ci/builds"
                className="dashboard-control inline-flex min-h-10 items-center self-start rounded-md text-xs font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
              >
                Open Builds <span aria-hidden="true">→</span>
              </Link>
            }
          />
          <div className="space-y-6 p-4 sm:p-5">
            <ComparisonBar
              label="Latest 24 hours"
              passRate={currentStats.passRate}
              failures={currentStats.failed}
              total={currentStats.total}
            />
            <ComparisonBar
              label="Previous 24 hours"
              passRate={priorStats.passRate}
              failures={priorStats.failed}
              total={priorStats.total}
            />
            <div className="grid grid-cols-2 gap-3 border-t border-zinc-100 pt-4 sm:grid-cols-4 dark:border-zinc-800">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-zinc-400">Delta</p>
                <p className={`mt-1 text-sm font-semibold tabular-nums ${passDelta >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
                  {passDelta > 0 ? "+" : ""}{passDelta.toFixed(1)} pts
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-zinc-400">Failures</p>
                <p className="mt-1 text-sm font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">{currentStats.failed}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-zinc-400">Completed</p>
                <p className="mt-1 text-sm font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">{currentStats.passed + currentStats.failed}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-zinc-400">All builds</p>
                <p className="mt-1 text-sm font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">{currentStats.total}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <SectionHeader
            title="Failure concentration"
            description="Jobs ranked by failing runs, with newly observed names called out."
            action={
              <Link
                href="/ci/jobs"
                className="dashboard-control inline-flex min-h-10 items-center self-start rounded-md text-xs font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
              >
                Open Jobs <span aria-hidden="true">→</span>
              </Link>
            }
          />
          {concentratedFailures.length === 0 ? (
            <div className="flex min-h-56 items-center justify-center px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
              No failing jobs in the latest 24-hour window.
            </div>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {concentratedFailures.map((row, index) => {
                const isNew = !priorFailureNames.has(row.name);
                return (
                  <div key={row.name} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-xs">
                    <span className="text-[11px] font-semibold tabular-nums text-zinc-400">{index + 1}</span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate font-medium text-zinc-950 dark:text-zinc-50" title={row.name}>{row.name}</p>
                        {isNew ? (
                          <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em] text-red-700 dark:bg-red-950/50 dark:text-red-300">
                            New
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                        {number(row.failures)} failures across {number(row.total_runs)} runs
                      </p>
                    </div>
                    <span className="font-semibold tabular-nums text-red-700 dark:text-red-400">
                      {number(row.failure_rate).toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <section className="min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <SectionHeader
          title="Recent failed changes"
          description="Latest failed CI builds in the rolling window, linked back to the source run."
          action={
            <Link
              href="/ci/builds"
              className="dashboard-control inline-flex min-h-10 items-center self-start rounded-md text-xs font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              Inspect all builds <span aria-hidden="true">→</span>
            </Link>
          }
        />
        {failureRows.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No failed builds in the last 24 hours.
          </div>
        ) : (
          <>
            <div className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
              {failureRows.map((build) => (
                <article key={`${build.number}-${build.created_at}`} className="space-y-2 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs font-semibold text-zinc-950 dark:text-zinc-50">{build.commit ?? "unknown"}</span>
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{formatTimestamp(build.created_at)}</span>
                  </div>
                  <p className="text-xs font-medium leading-5 text-zinc-950 dark:text-zinc-50">{build.message || "No build message"}</p>
                  <div className="flex items-center justify-between gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <span>{build.author ?? "Unknown author"}{build.pr ? ` · PR #${build.pr}` : ""}</span>
                    {build.url ? (
                      <a href={build.url} target="_blank" rel="noreferrer" className="dashboard-control inline-flex min-h-10 items-center font-semibold text-blue-600 dark:text-blue-400">
                        Build #{build.number ?? "?"} <span aria-hidden="true">↗</span>
                      </a>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[820px] text-left text-xs">
                <thead className="bg-zinc-50 text-[10px] font-bold uppercase tracking-[0.05em] text-zinc-500 dark:bg-zinc-900/60 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-2.5">Commit</th>
                    <th className="px-4 py-2.5">PR</th>
                    <th className="px-4 py-2.5">Author</th>
                    <th className="px-4 py-2.5">Message</th>
                    <th className="px-4 py-2.5">Started</th>
                    <th className="px-4 py-2.5 text-right">Run</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {failureRows.map((build) => (
                    <tr key={`${build.number}-${build.created_at}`}>
                      <td className="px-4 py-3 font-mono font-semibold text-zinc-950 dark:text-zinc-50">{build.commit ?? "unknown"}</td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">{build.pr ? `#${build.pr}` : "—"}</td>
                      <td className="max-w-36 truncate px-4 py-3 text-zinc-600 dark:text-zinc-300">{build.author ?? "Unknown"}</td>
                      <td className="max-w-[360px] truncate px-4 py-3 font-medium text-zinc-950 dark:text-zinc-50" title={build.message}>{build.message || "No build message"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-zinc-500 dark:text-zinc-400">{formatTimestamp(build.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        {build.url ? (
                          <a href={build.url} target="_blank" rel="noreferrer" className="dashboard-control inline-flex min-h-10 items-center justify-end font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">
                            #{build.number ?? "?"} <span aria-hidden="true">↗</span>
                          </a>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
