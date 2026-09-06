"use client";

import Link from "next/link";
import { useMemo } from "react";
import useSWR from "swr";
import { DateRangePicker } from "@/components/date-range-picker";
import { JobName } from "@/components/job-name";
import { JobRunsChart, type JobRun } from "@/components/job-runs-chart";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelEmpty } from "@/components/panel";
import { SearchableSelect } from "@/components/searchable-select";
import { StatCard } from "@/components/stat-card";
import { formatRelativeTime } from "@/lib/alerts-shared";
import { isOptionalJob, isSoftFailJob } from "@/lib/optional-jobs";
import { isoDate, useUrlState } from "@/lib/use-url-state";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface FiltersResponse {
  pipelines: string[];
  branches: string[];
}

const FAILED_STATES = new Set(["failed", "failing", "broken", "timed_out"]);

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[index];
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const DEFAULTS = { pipeline: "CI", branch: "main", start: "", end: "" };

export default function JobDetail({ jobName }: { jobName: string }) {
  const [url, setUrl] = useUrlState(DEFAULTS);
  const pipeline = url.pipeline;
  const branch = url.branch;
  const startDate = url.start || isoDate(14);
  const endDate = url.end || isoDate(0);

  const { data: filters } = useSWR<FiltersResponse>("/api/builds/filters", fetcher);

  const params = new URLSearchParams({
    jobName,
    pipeline,
    branch,
    startDate,
    endDate,
  });
  const { data, error, isLoading } = useSWR<{ runs: JobRun[]; error?: string }>(
    `/api/jobs/runs?${params.toString()}`,
    fetcher,
    { refreshInterval: 5 * 60 * 1000, keepPreviousData: true },
  );

  const runs = useMemo(() => data?.runs ?? [], [data?.runs]);
  const stats = useMemo(() => {
    const failed = runs.filter((run) => FAILED_STATES.has(run.state)).length;
    const durations = runs
      .map((run) => (run.duration_secs === null ? NaN : Number(run.duration_secs)))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    const byDay = new Map<string, { total: number; failed: number }>();
    for (const run of runs) {
      const day = run.build_created_at.slice(0, 10);
      const entry = byDay.get(day) ?? { total: 0, failed: 0 };
      entry.total += 1;
      if (FAILED_STATES.has(run.state)) entry.failed += 1;
      byDay.set(day, entry);
    }
    const dailyFailRate = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, d]) => Math.round((d.failed / d.total) * 100));
    const lastFailed = [...runs].reverse().find((run) => FAILED_STATES.has(run.state));
    const lastPassed = [...runs].reverse().find((run) => !FAILED_STATES.has(run.state));
    return {
      total: runs.length,
      failed,
      failureRate: runs.length > 0 ? Math.round((failed / runs.length) * 100) : null,
      p50: percentile(durations, 0.5),
      p90: percentile(durations, 0.9),
      dailyFailRate,
      lastFailed,
      lastPassed,
    };
  }, [runs]);

  const recent = useMemo(() => [...runs].reverse().slice(0, 15), [runs]);
  const flags = [
    isSoftFailJob(jobName) ? "soft fail" : null,
    isOptionalJob(jobName) ? "optional" : null,
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            <span className="break-words">
              <JobName name={jobName} />
            </span>
            {flags.map((flag) => (
              <span
                key={flag}
                className="rounded-md bg-warn-soft px-1.5 py-0.5 text-xs font-medium text-warn"
              >
                {flag}
              </span>
            ))}
          </span>
        }
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {pipeline} · {branch}
            </span>
            {stats.lastFailed && (
              <span>Last failed {formatRelativeTime(stats.lastFailed.build_created_at)}</span>
            )}
            {stats.lastPassed && (
              <span>Last passed {formatRelativeTime(stats.lastPassed.build_created_at)}</span>
            )}
            <Link href="/jobs" className="text-accent hover:underline">
              All jobs
            </Link>
          </span>
        }
        actions={
          <>
            <SearchableSelect
              label="Pipeline"
              value={pipeline}
              onChange={(v) => setUrl({ pipeline: v })}
              options={filters?.pipelines ?? []}
              allLabel="All Pipelines"
            />
            <SearchableSelect
              label="Branch"
              value={branch}
              onChange={(v) => setUrl({ branch: v })}
              options={filters?.branches ?? []}
              allLabel="All Branches"
            />
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onChange={(s, e) => setUrl({ start: s, end: e })}
            />
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Runs" value={data ? stats.total : "—"} detail="in the selected range" />
        <StatCard
          label="Failure rate"
          value={stats.failureRate === null ? "—" : `${stats.failureRate}%`}
          color={
            stats.failureRate === null
              ? "default"
              : stats.failureRate >= 50
                ? "red"
                : stats.failureRate >= 10
                  ? "yellow"
                  : "green"
          }
          detail={data ? `${stats.failed} failed` : undefined}
          trend={stats.dailyFailRate}
        />
        <StatCard label="Median duration" value={formatDuration(stats.p50)} />
        <StatCard label="p90 duration" value={formatDuration(stats.p90)} />
      </div>

      {error || data?.error ? (
        <PanelEmpty className="rounded-xl border border-dashed border-line">
          Run history could not be loaded.
        </PanelEmpty>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Outcome per run" description="Oldest on the left." padded>
              <JobRunsChart runs={runs} mode="failures" loading={isLoading && !data} />
            </Panel>
            <Panel title="Duration per run" description="Red bars failed." padded>
              <JobRunsChart runs={runs} mode="duration" loading={isLoading && !data} />
            </Panel>
          </div>

          <Panel title="Recent runs" description="Newest first. Each run opens in Buildkite.">
            {recent.length === 0 ? (
              <PanelEmpty>No runs in the selected range.</PanelEmpty>
            ) : (
              <ul className="divide-y divide-line">
                {recent.map((run) => {
                  const failed = FAILED_STATES.has(run.state);
                  const duration =
                    run.duration_secs === null ? null : Number(run.duration_secs);
                  return (
                    <li
                      key={run.job_id}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5"
                    >
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 shrink-0 rounded-full ${failed ? "bg-bad" : "bg-ok"}`}
                      />
                      <span
                        className={`w-16 shrink-0 text-xs font-medium capitalize ${failed ? "text-bad" : "text-ok"}`}
                      >
                        {run.state.replace(/_/g, " ")}
                      </span>
                      <a
                        href={`https://github.com/vllm-project/vllm/commit/${run.commit_sha}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 font-mono text-xs text-accent hover:underline"
                      >
                        {run.commit_sha.slice(0, 7)}
                      </a>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted">
                        {formatRelativeTime(run.build_created_at)}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted">
                        {formatDuration(duration)}
                      </span>
                      {run.web_url && (
                        <a
                          href={run.web_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-xs text-muted hover:text-accent"
                          aria-label="Open run in Buildkite"
                        >
                          ↗
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
