"use client";

import { Fragment, useMemo, useState } from "react";
import useSWR from "swr";

import { JobName, jobNameText } from "@/components/job-name";
import { SegmentedControl } from "@/components/segmented-control";
import { StatCard } from "@/components/stat-card";
import type {
  JobScope,
  PlatformSide,
  ScopeCounts,
  ScopedJob,
} from "@/lib/platform-scope";
import type { PlatformScopeResponse } from "@/lib/platform-scope-source";

type Population = "all" | "gating";
type JobFilter = "all" | "gaps" | JobScope;

const RULES_URL =
  "https://github.com/vllm-project/vllm-dashboard/blob/main/src/lib/platform-scope-rules.ts";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || `Request failed: ${response.status}`);
  }
  return data;
};

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const SCOPE_STYLE: Record<JobScope, { label: string; bar: string; badge: string }> = {
  common: {
    label: "Common",
    bar: "bg-sky-500",
    badge:
      "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-300",
  },
  "nvidia-only": {
    label: "NVIDIA only",
    bar: "bg-lime-600",
    badge:
      "border-lime-200 bg-lime-50 text-lime-800 dark:border-lime-900 dark:bg-lime-950/50 dark:text-lime-300",
  },
  "rocm-only": {
    label: "ROCm only",
    bar: "bg-orange-500",
    badge:
      "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950/50 dark:text-orange-300",
  },
  unclassified: {
    label: "Unclassified",
    bar: "bg-zinc-400 dark:bg-zinc-600",
    badge:
      "border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
  },
};

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
  className = "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] ${className}`}
    >
      {children}
    </span>
  );
}

const WARN_BADGE =
  "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300";

function ScopeBadge({ job }: { job: ScopedJob }) {
  return <Badge className={SCOPE_STYLE[job.scope].badge}>{SCOPE_STYLE[job.scope].label}</Badge>;
}

function DeviceChip({ device }: { device: string | null }) {
  if (!device) return null;
  return (
    <span className="inline-flex items-center rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      {device}
    </span>
  );
}

/** One platform's column for a job: its step, mirror, counterpart, or why there is none. */
function SideCell({
  job,
  side,
  platform,
}: {
  job: ScopedJob;
  side: PlatformSide | null;
  platform: "nvidia" | "amd";
}) {
  if (side) {
    return (
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span title={jobNameText(side.label)}>
            <JobName name={side.label} />
          </span>
          <DeviceChip device={side.device} />
        </p>
        {(side.via !== "step" || side.optional || side.softFail) && (
          <p className="mt-1.5 flex flex-wrap gap-1.5">
            {side.via === "mirror" && <Badge>mirror</Badge>}
            {side.via === "counterpart" && <Badge>separate step</Badge>}
            {side.optional && <Badge className={WARN_BADGE}>optional</Badge>}
            {side.softFail && <Badge className={WARN_BADGE}>soft fail</Badge>}
          </p>
        )}
      </div>
    );
  }
  const vendorName = platform === "nvidia" ? "NVIDIA" : "AMD";
  if (job.scope === "common") {
    return (
      <p className="text-sm font-medium text-rose-600 dark:text-rose-400">
        Missing: no {vendorName} step
      </p>
    );
  }
  if (job.scope === "unclassified") {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Not decided</p>;
  }
  return (
    <p className="text-sm text-zinc-400 dark:text-zinc-500">Not applicable</p>
  );
}

function JobRow({ job }: { job: ScopedJob }) {
  return (
    <li className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)] sm:gap-6 sm:px-6">
      <div className="min-w-0">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-400 sm:hidden">
          NVIDIA
        </p>
        <SideCell job={job} side={job.nvidia} platform="nvidia" />
      </div>
      <div className="min-w-0">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-400 sm:hidden">
          AMD
        </p>
        <SideCell job={job} side={job.amd} platform="amd" />
      </div>
      <div className="min-w-0 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        <p className="mb-1 flex flex-wrap items-center gap-1.5">
          <ScopeBadge job={job} />
          {job.numNodes > 1 && <Badge>{job.numNodes} nodes</Badge>}
        </p>
        {job.reason}
      </div>
    </li>
  );
}

function JobList({ jobs, empty }: { jobs: ScopedJob[]; empty: string }) {
  if (jobs.length === 0) {
    return <p className="px-4 py-3 text-sm text-zinc-500 sm:px-6">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-zinc-200/70 dark:divide-zinc-800">
      <li className="hidden px-6 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-400 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)] sm:gap-6">
        <span>NVIDIA</span>
        <span>AMD</span>
        <span>Scope</span>
      </li>
      {jobs.map((job) => (
        <JobRow key={`${job.file}:${job.id}`} job={job} />
      ))}
    </ul>
  );
}

function ScopeBar({ counts }: { counts: ScopeCounts }) {
  const parts: Array<[JobScope, number]> = [
    ["common", counts.common],
    ["nvidia-only", counts.nvidiaOnly],
    ["rocm-only", counts.rocmOnly],
    ["unclassified", counts.unclassified],
  ];
  return (
    <div
      className="flex h-2 w-32 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
      role="img"
      aria-label={parts
        .filter(([, n]) => n > 0)
        .map(([scope, n]) => `${n} ${SCOPE_STYLE[scope].label.toLowerCase()}`)
        .join(", ")}
    >
      {parts.map(([scope, n]) =>
        n > 0 ? (
          <div
            key={scope}
            className={`h-full ${SCOPE_STYLE[scope].bar}`}
            style={{ width: `${(n / Math.max(counts.jobs, 1)) * 100}%` }}
          />
        ) : null,
      )}
    </div>
  );
}

function matchesFilter(job: ScopedJob, filter: JobFilter): boolean {
  if (filter === "all") return true;
  if (filter === "gaps") return job.scope === "common" && job.missingOn !== null;
  return job.scope === filter;
}

function scopeOrder(job: ScopedJob): number {
  if (job.scope === "common" && job.missingOn) return 0;
  return { unclassified: 1, common: 2, "nvidia-only": 3, "rocm-only": 4 }[job.scope];
}

export default function PlatformsPage() {
  const [population, setPopulation] = useState<Population>("all");
  const [jobFilter, setJobFilter] = useState<JobFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, error, isLoading } = useSWR<PlatformScopeResponse>(
    "/api/platforms",
    fetcher,
    { refreshInterval: 15 * 60 * 1000 },
  );

  const jobs = useMemo(
    () =>
      (data?.jobs ?? []).filter(
        (job) => population === "all" || !job.optional,
      ),
    [data, population],
  );
  const summary = data?.summary[population];
  const gaps = useMemo(
    () => jobs.filter((job) => matchesFilter(job, "gaps")),
    [jobs],
  );

  const groups = useMemo(() => {
    if (!data) return [];
    return data.groups
      .map((group) => {
        const counts = group[population];
        const groupJobs = jobs
          .filter((job) => job.group === group.group)
          .sort((a, b) => scopeOrder(a) - scopeOrder(b) || a.label.localeCompare(b.label));
        return {
          ...group,
          counts,
          gaps: counts.missingOnAmd + counts.missingOnNvidia,
          jobs: groupJobs.filter((job) => matchesFilter(job, jobFilter)),
        };
      })
      .filter((group) => group.counts.jobs > 0)
      .filter((group) => jobFilter === "all" || group.jobs.length > 0)
      .sort(
        (a, b) =>
          b.gaps - a.gaps ||
          b.counts.unclassified - a.counts.unclassified ||
          a.group.localeCompare(b.group),
      );
  }, [data, jobs, population, jobFilter]);

  function toggle(group: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const allExpanded =
    groups.length > 0 && groups.every((group) => expanded.has(group.group));

  if (isLoading && !data) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Reading .buildkite/test_areas…
      </div>
    );
  }

  if (error || !data || !summary) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm font-medium text-red-600 dark:text-red-400">
          Failed to load platform scope.
        </p>
        <p className="text-xs text-zinc-500">
          {error instanceof Error ? error.message : "GitHub may be unavailable."}
        </p>
      </div>
    );
  }

  const gapCount = summary.missingOnAmd + summary.missingOnNvidia;
  const linkClass =
    "font-mono text-xs text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-500 dark:text-zinc-300 dark:decoration-zinc-600";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Platform Scope</h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-500 dark:text-zinc-400">
            Which GPU jobs in{" "}
            <a
              href={`https://github.com/${data.source.repo}/tree/${data.source.commit}/${data.source.directory}`}
              target="_blank"
              rel="noreferrer"
              className={linkClass}
            >
              {data.source.repo}/{data.source.directory}
            </a>{" "}
            are on the common path that both NVIDIA and AMD should run, and which
            belong to one platform. Jobs with a <code className="font-mono text-xs">mirror.amd</code>{" "}
            block are common; everything else is classified in{" "}
            <a href={RULES_URL} target="_blank" rel="noreferrer" className={linkClass}>
              platform-scope-rules.ts
            </a>
            . Snapshot of{" "}
            <a href={data.source.commitUrl} target="_blank" rel="noreferrer" className={linkClass}>
              {data.source.commit.slice(0, 10)}
            </a>{" "}
            on {data.source.ref}, {formatDateTime(data.source.commitDate)}.
          </p>
        </div>
        <SegmentedControl<Population>
          label="Job population"
          value={population}
          onChange={setPopulation}
          options={[
            { value: "all", label: "All jobs", count: data.summary.all.jobs },
            { value: "gating", label: "Non-optional", count: data.summary.gating.jobs },
          ]}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Common path"
          value={summary.common}
          detail={`${summary.commonOnBoth} run on both platforms`}
        />
        <StatCard
          label="Common-path gaps"
          value={gapCount}
          color={gapCount > 0 ? "red" : "green"}
          detail={`${summary.missingOnAmd} missing on AMD · ${summary.missingOnNvidia} missing on NVIDIA`}
        />
        <StatCard
          label="NVIDIA only"
          value={summary.nvidiaOnly}
          detail="CUDA-only kernels, libraries or formats"
        />
        <StatCard
          label="ROCm only"
          value={summary.rocmOnly}
          detail="ROCm-only kernels, connectors or backends"
        />
      </div>

      {(summary.unclassified > 0 || data.staleRules.length > 0) && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          role="status"
        >
          {summary.unclassified > 0 && (
            <p>
              <span className="font-medium">{summary.unclassified} unclassified</span>{" "}
              job{summary.unclassified === 1 ? "" : "s"}: no AMD mirror and no platform
              rule. Add an AMD mirror if the job is common, or a rule in{" "}
              <a href={RULES_URL} target="_blank" rel="noreferrer" className="underline">
                platform-scope-rules.ts
              </a>{" "}
              if it belongs to one platform.
            </p>
          )}
          {data.staleRules.length > 0 && (
            <details className={summary.unclassified > 0 ? "mt-2" : ""}>
              <summary className="dashboard-control cursor-pointer font-medium">
                {data.staleRules.length} stale platform rule
                {data.staleRules.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-2 space-y-1 text-xs">
                {data.staleRules.map((rule) => (
                  <li key={`${rule.id}:${rule.problem}`}>
                    <code className="font-mono">{rule.id}</code>: {rule.problem}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 px-4 py-3 sm:px-5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Common-path gaps</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Jobs both platforms should run that have no step on one of them.
          </p>
        </div>
        <JobList jobs={gaps} empty="Every common-path job runs on both platforms." />
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-col gap-3 border-b border-zinc-200 px-4 py-3 lg:flex-row lg:items-center lg:justify-between sm:px-5 dark:border-zinc-800">
          <div>
            <h2 className="text-sm font-semibold">By test area</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Areas with gaps first. Expand an area to see each job on both platforms.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl<JobFilter>
              label="Job filter"
              value={jobFilter}
              onChange={setJobFilter}
              options={[
                { value: "all", label: "All", count: summary.jobs },
                { value: "common", label: "Common", count: summary.common },
                { value: "gaps", label: "Gaps", count: gapCount },
                { value: "nvidia-only", label: "NVIDIA only", count: summary.nvidiaOnly },
                { value: "rocm-only", label: "ROCm only", count: summary.rocmOnly },
                ...(summary.unclassified > 0
                  ? [{ value: "unclassified" as const, label: "Unclassified", count: summary.unclassified }]
                  : []),
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
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th scope="col" className="px-4 py-2.5 sm:px-5">Test area</th>
                <th scope="col" className="px-3 py-2.5 text-right">Common</th>
                <th scope="col" className="px-3 py-2.5 text-right">Gaps</th>
                <th scope="col" className="px-3 py-2.5 text-right">NVIDIA only</th>
                <th scope="col" className="px-3 py-2.5 text-right">ROCm only</th>
                <th scope="col" className="px-3 py-2.5 sm:px-5">Mix</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const open = expanded.has(group.group);
                return (
                  <Fragment key={group.group}>
                    <tr className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/60">
                      <td className="px-4 py-2.5 sm:px-5">
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => toggle(group.group)}
                          className="dashboard-control inline-flex items-center gap-2 text-left font-medium text-zinc-900 dark:text-zinc-100"
                        >
                          <Chevron open={open} />
                          {group.group}
                          {group.counts.unclassified > 0 && (
                            <Badge className={SCOPE_STYLE.unclassified.badge}>
                              {group.counts.unclassified} unclassified
                            </Badge>
                          )}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{group.counts.common}</td>
                      <td
                        className={`px-3 py-2.5 text-right tabular-nums ${
                          group.gaps > 0
                            ? "font-medium text-rose-600 dark:text-rose-400"
                            : "text-zinc-400"
                        }`}
                      >
                        {group.gaps}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{group.counts.nvidiaOnly}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{group.counts.rocmOnly}</td>
                      <td className="px-3 py-2.5 sm:px-5">
                        <ScopeBar counts={group.counts} />
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-zinc-100 bg-zinc-50/60 last:border-b-0 dark:border-zinc-900 dark:bg-zinc-900/40">
                        <td colSpan={6} className="p-0">
                          <JobList jobs={group.jobs} empty="No jobs in this area match the filter." />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500 sm:px-5 dark:border-zinc-800 dark:text-zinc-400">
          {(["common", "nvidia-only", "rocm-only"] as const).map((scope) => (
            <span key={scope} className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${SCOPE_STYLE[scope].bar}`} aria-hidden="true" />
              {SCOPE_STYLE[scope].label}
            </span>
          ))}
          <span>
            Non-optional means the step is not <code className="font-mono">optional: true</code>.
            CPU-only steps ({data.skipped.cpuJobs}) are left out.
            {data.skipped.unknown.length > 0 &&
              ` ${data.skipped.unknown.length} step(s) with an unrecognised device were also left out.`}
          </span>
        </p>
      </section>
    </div>
  );
}
