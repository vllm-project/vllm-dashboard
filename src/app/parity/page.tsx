"use client";

import { Fragment, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";

import { JobName, jobNameText } from "@/components/job-name";
import { SegmentedControl } from "@/components/segmented-control";
import { StatCard } from "@/components/stat-card";
import type { ParityCounts, ParityJob } from "@/lib/gpu-parity";
import type {
  ParityHistoryResponse,
  ParitySnapshotResponse,
} from "@/lib/gpu-parity-source";

const ParityTrendChart = dynamic(
  () =>
    import("@/components/parity-trend-chart").then(
      (module) => module.ParityTrendChart,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[280px] items-center justify-center text-sm text-zinc-400">
        Loading chart…
      </div>
    ),
  },
);

type Mode = "gating" | "all";
type JobFilter = "all" | "missing";

const HISTORY_WEEKS = 26;

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || `Request failed: ${response.status}`);
  }
  return data;
};

function percent(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function coverageColor(value: number | null): "green" | "yellow" | "red" | "default" {
  if (value == null) return "default";
  if (value >= 0.75) return "green";
  if (value >= 0.5) return "yellow";
  return "red";
}

function coverageBarClass(value: number | null): string {
  if (value == null) return "bg-zinc-300 dark:bg-zinc-700";
  if (value >= 0.75) return "bg-emerald-500";
  if (value >= 0.5) return "bg-amber-500";
  return "bg-rose-500";
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "warn" | "bad" | "ok";
}) {
  const tones = {
    neutral:
      "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
    warn:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
    bad:
      "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300",
    ok:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300",
  };
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function DeviceChip({ device }: { device: string | null }) {
  if (!device) return null;
  return (
    <span className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      {device}
    </span>
  );
}

function CoverageBar({ counts }: { counts: ParityCounts }) {
  const width = counts.coverage == null ? 0 : counts.coverage * 100;
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-2 w-28 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        role="img"
        aria-label={`${percent(counts.coverage)} of NVIDIA jobs have an AMD mirror`}
      >
        <div
          className={`h-full rounded-full ${coverageBarClass(counts.coverage)}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="w-10 text-right text-sm tabular-nums">
        {percent(counts.coverage)}
      </span>
    </div>
  );
}

function JobRow({ job }: { job: ParityJob }) {
  return (
    <li className="grid gap-2 px-4 py-3 sm:grid-cols-2 sm:gap-6 sm:px-6">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium" title={jobNameText(job.label)}>
            <JobName name={job.label} />
          </span>
          <DeviceChip device={job.device} />
          {job.numDevices > 1 && (
            <span className="text-xs text-zinc-500">×{job.numDevices} GPUs</span>
          )}
          {job.parallelism > 1 && (
            <span className="text-xs text-zinc-500">{job.parallelism} shards</span>
          )}
        </p>
        {(job.optional || job.softFail || job.autorunOnMain) && (
          <p className="mt-1.5 flex flex-wrap gap-1.5">
            {job.optional && <Badge tone="warn">optional</Badge>}
            {job.softFail && <Badge tone="warn">soft fail</Badge>}
            {job.autorunOnMain && <Badge>autorun on main</Badge>}
          </p>
        )}
      </div>
      <div className="min-w-0">
        {job.mirror ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span title={jobNameText(job.mirror.label)}>
              <JobName name={job.mirror.label} />
            </span>
            <DeviceChip device={job.mirror.device} />
            {job.gating && !job.mirror.gating && (
              <Badge tone="warn">
                {job.mirror.softFail ? "mirror soft fail" : "mirror optional"}
              </Badge>
            )}
          </p>
        ) : (
          <p className="text-sm text-rose-600 dark:text-rose-400">No AMD mirror</p>
        )}
      </div>
    </li>
  );
}

export default function ParityPage() {
  const [mode, setMode] = useState<Mode>("gating");
  const [jobFilter, setJobFilter] = useState<JobFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, error, isLoading } = useSWR<ParitySnapshotResponse>(
    "/api/parity",
    fetcher,
    { refreshInterval: 15 * 60 * 1000 },
  );
  const {
    data: history,
    error: historyError,
    isLoading: historyLoading,
    mutate: retryHistory,
  } = useSWR<ParityHistoryResponse>(
    `/api/parity/history?weeks=${HISTORY_WEEKS}`,
    fetcher,
    { refreshInterval: 60 * 60 * 1000, shouldRetryOnError: false },
  );

  const summary = data?.summary[mode];
  const groups = useMemo(() => {
    if (!data) return [];
    return data.groups
      .filter((group) => group[mode].nvidiaJobs > 0)
      .map((group) => {
        const jobs = data.jobs.filter(
          (job) => job.group === group.group && (mode === "all" || job.gating),
        );
        return {
          ...group,
          counts: group[mode],
          missing: group[mode].nvidiaJobs - group[mode].mirroredJobs,
          jobs:
            jobFilter === "missing" ? jobs.filter((job) => !job.mirror) : jobs,
        };
      })
      .sort(
        (a, b) =>
          b.missing - a.missing ||
          (a.counts.coverage ?? 0) - (b.counts.coverage ?? 0) ||
          a.group.localeCompare(b.group),
      );
  }, [data, mode, jobFilter]);

  function toggle(group: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const allExpanded = groups.length > 0 && groups.every((group) => expanded.has(group.group));

  if (isLoading && !data) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Reading .buildkite/test_areas…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm font-medium text-red-600 dark:text-red-400">
          Failed to load parity data.
        </p>
        <p className="text-xs text-zinc-500">
          {error instanceof Error ? error.message : "GitHub may be unavailable."}
        </p>
      </div>
    );
  }

  const missing = summary ? summary.nvidiaJobs - summary.mirroredJobs : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Parity</h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-500 dark:text-zinc-400">
            NVIDIA test jobs declared in{" "}
            <a
              href={`https://github.com/${data.source.repo}/tree/${data.source.commit}/${data.source.directory}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-500 dark:text-zinc-300 dark:decoration-zinc-600"
            >
              {data.source.repo}/{data.source.directory}
            </a>{" "}
            and whether each declares an AMD mirror. Snapshot of{" "}
            <a
              href={data.source.commitUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-500 dark:text-zinc-300 dark:decoration-zinc-600"
            >
              {data.source.commit.slice(0, 10)}
            </a>{" "}
            on {data.source.ref}, {formatDateTime(data.source.commitDate)}.
          </p>
        </div>
        <SegmentedControl<Mode>
          label="Job scope"
          value={mode}
          onChange={setMode}
          options={[
            {
              value: "gating",
              label: "Gating jobs",
              count: data.summary.gating.nvidiaJobs,
            },
            { value: "all", label: "All jobs", count: data.summary.all.nvidiaJobs },
          ]}
        />
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <StatCard
            label="NVIDIA jobs"
            value={summary.nvidiaJobs}
            detail={
              mode === "gating"
                ? `${data.summary.nonGating.nvidiaJobs} more are optional or soft-fail`
                : `${data.summary.gating.nvidiaJobs} gate builds`
            }
          />
          <StatCard
            label="With AMD mirror"
            value={summary.mirroredJobs}
            detail="Steps declaring a mirror.amd block"
          />
          <StatCard
            label="AMD coverage"
            value={percent(summary.coverage)}
            color={coverageColor(summary.coverage)}
            detail={
              mode === "gating"
                ? "Share of gating NVIDIA jobs with a mirror"
                : "Share of all NVIDIA jobs with a mirror"
            }
          />
          <StatCard
            label="Missing mirror"
            value={missing}
            color={missing > 0 ? "red" : "green"}
            detail={`Across ${groups.filter((group) => group.missing > 0).length} test areas`}
          />
        </div>
      )}

      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 className="text-sm font-semibold">AMD mirror coverage over time</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Weekly samples of test_areas on {data.source.ref} for the last{" "}
            {HISTORY_WEEKS} weeks; the last point is the current snapshot.
          </p>
        </div>
        {history && history.samples.length > 0 ? (
          <ParityTrendChart samples={history.samples} mode={mode} />
        ) : historyLoading ? (
          <div
            className="flex h-[280px] flex-col items-center justify-center gap-2 text-center"
            role="status"
            aria-live="polite"
          >
            <span
              className="h-5 w-5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600 motion-reduce:animate-none dark:border-blue-900 dark:border-t-blue-400"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Sampling {HISTORY_WEEKS} weeks of history from GitHub…
            </p>
            <p className="text-xs text-zinc-400">
              The current snapshot above is already complete.
            </p>
          </div>
        ) : (
          <div
            className="flex h-[280px] flex-col items-center justify-center gap-2 text-center"
            role="alert"
          >
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              History couldn&apos;t be loaded.
            </p>
            <p className="text-xs text-zinc-400">
              {historyError instanceof Error
                ? historyError.message
                : "No samples were returned."}
            </p>
            <button
              type="button"
              onClick={() => retryHistory()}
              className="dashboard-control mt-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              Retry
            </button>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-col gap-3 border-b border-zinc-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5 dark:border-zinc-800">
          <div>
            <h2 className="text-sm font-semibold">By test area</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Areas with the most unmirrored jobs first. Expand an area to see each job and its mirror.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl<JobFilter>
              label="Job filter"
              value={jobFilter}
              onChange={setJobFilter}
              options={[
                { value: "all", label: "All jobs" },
                { value: "missing", label: "Missing mirror", count: missing },
              ]}
            />
            <button
              type="button"
              onClick={() =>
                setExpanded(
                  allExpanded ? new Set() : new Set(groups.map((group) => group.group)),
                )
              }
              className="dashboard-control inline-flex h-8 items-center rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-600"
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th scope="col" className="px-4 py-2.5 sm:px-5">Test area</th>
                <th scope="col" className="px-3 py-2.5 text-right">NVIDIA jobs</th>
                <th scope="col" className="px-3 py-2.5 text-right">With mirror</th>
                <th scope="col" className="px-3 py-2.5 text-right">Missing</th>
                <th scope="col" className="px-3 py-2.5 sm:px-5">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const open = expanded.has(group.group);
                return (
                  <Fragment key={group.group}>
                    <tr
                      className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/60"
                    >
                      <td className="px-4 py-2.5 sm:px-5">
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => toggle(group.group)}
                          className="dashboard-control inline-flex items-center gap-2 text-left font-medium text-zinc-900 dark:text-zinc-100"
                        >
                          <Chevron open={open} />
                          {group.group}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {group.counts.nvidiaJobs}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {group.counts.mirroredJobs}
                      </td>
                      <td
                        className={`px-3 py-2.5 text-right tabular-nums ${
                          group.missing > 0
                            ? "font-medium text-rose-600 dark:text-rose-400"
                            : "text-zinc-400"
                        }`}
                      >
                        {group.missing}
                      </td>
                      <td className="px-3 py-2.5 sm:px-5">
                        <CoverageBar counts={group.counts} />
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-zinc-100 bg-zinc-50/60 last:border-b-0 dark:border-zinc-900 dark:bg-zinc-900/40">
                        <td colSpan={5} className="p-0">
                          {group.jobs.length === 0 ? (
                            <p className="px-4 py-3 text-sm text-zinc-500 sm:px-6">
                              Every {mode === "gating" ? "gating " : ""}job in this area has an AMD mirror.
                            </p>
                          ) : (
                            <ul className="divide-y divide-zinc-200/70 dark:divide-zinc-800">
                              <li className="hidden px-6 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-400 sm:grid sm:grid-cols-2 sm:gap-6">
                                <span>NVIDIA job</span>
                                <span>AMD mirror</span>
                              </li>
                              {group.jobs.map((job) => (
                                <JobRow key={`${job.file}:${job.label}`} job={job} />
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500 sm:px-5 dark:border-zinc-800 dark:text-zinc-400">
          A job gates a build when it is neither <code className="font-mono">optional</code> nor{" "}
          <code className="font-mono">soft_fail</code>. Mirrors inherit both flags from their
          NVIDIA job unless the mirror block overrides them. CPU-only steps ({data.skipped.cpuJobs}) are
          excluded.
          {data.skipped.unknown.length > 0 &&
            ` ${data.skipped.unknown.length} step(s) with an unrecognised device were also excluded.`}
        </p>
      </section>
    </div>
  );
}
