"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { JobName, jobNameText } from "@/components/job-name";
import { SegmentedControl } from "@/components/segmented-control";
import { StatCard } from "@/components/stat-card";
import {
  SHARDING_WINDOWS,
  type Platform,
  type ShardingJob,
  type ShardingStatus,
  type ShardingSummary,
} from "@/lib/automatic-sharding";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface ShardingResponse {
  days: number;
  summary: ShardingSummary;
  jobs: ShardingJob[];
  generatedAt: string;
  error?: string;
}

const STATUSES: Array<{
  value: ShardingStatus;
  label: string;
  bar: string;
  badge: string;
}> = [
  {
    value: "sharding",
    label: "Sharding",
    bar: "bg-emerald-500",
    badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400",
  },
  {
    value: "flagged-one-job",
    label: "Flagged, ran as one job",
    bar: "bg-amber-400",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  },
  {
    value: "flagged-not-run",
    label: "Flagged, not run",
    bar: "bg-emerald-200 dark:bg-emerald-900",
    badge: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  },
  {
    value: "fixed-split",
    label: "Fixed split",
    bar: "bg-blue-400",
    badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  },
  {
    value: "not-flagged",
    label: "Not on sharding",
    bar: "bg-zinc-200 dark:bg-zinc-700",
    badge: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  },
];
const STATUS_BY_VALUE = new Map(STATUSES.map((status) => [status.value, status]));

type StatusFilter = "all" | ShardingStatus;
type PlatformFilter = "all" | Platform;

const PLATFORM_LABELS: Record<Platform, string> = {
  nvidia: "NVIDIA",
  amd: "AMD",
  other: "Other",
};

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

function formatDuration(secs: number | null | undefined): string {
  if (secs == null) return "—";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const rest = mins % 60;
  return rest ? `${Math.floor(mins / 60)}h ${rest}m` : `${Math.floor(mins / 60)}h`;
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return "<1h ago";
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function StatusBar({ jobs }: { jobs: ShardingJob[] }) {
  const counts = new Map<ShardingStatus, number>();
  for (const job of jobs) counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
      {STATUSES.map((status) => {
        const count = counts.get(status.value) ?? 0;
        return count > 0 ? (
          <div
            key={status.value}
            className={status.bar}
            style={{ width: `${(count / jobs.length) * 100}%` }}
            title={`${status.label}: ${count}`}
          />
        ) : null;
      })}
    </div>
  );
}

export default function ShardingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedDays = Number(searchParams.get("days") ?? 7);
  const days = (SHARDING_WINDOWS as readonly number[]).includes(requestedDays)
    ? requestedDays
    : 7;
  const status = (searchParams.get("status") ?? "all") as StatusFilter;
  const platform = (searchParams.get("platform") ?? "all") as PlatformFilter;
  const [query, setQuery] = useState("");

  const updateParams = (next: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === "all" || (key === "days" && value === "7")) params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    router.replace(qs ? `/sharding?${qs}` : "/sharding", { scroll: false });
  };

  const { data, error, isLoading } = useSWR<ShardingResponse>(
    `/api/sharding?days=${days}`,
    fetcher,
    { keepPreviousData: true },
  );

  const jobs = useMemo(() => data?.jobs ?? [], [data?.jobs]);
  const platformJobs = useMemo(
    () => (platform === "all" ? jobs : jobs.filter((job) => job.platform === platform)),
    [jobs, platform],
  );
  const visibleJobs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return platformJobs
      .filter((job) => status === "all" || job.status === status)
      .filter(
        (job) =>
          !needle ||
          jobNameText(job.label).toLowerCase().includes(needle) ||
          job.group.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          (b.observed?.p50WallSecs ?? -1) - (a.observed?.p50WallSecs ?? -1) ||
          a.label.localeCompare(b.label),
      );
  }, [platformJobs, status, query]);
  const groups = useMemo(() => {
    const byGroup = new Map<string, ShardingJob[]>();
    for (const job of platformJobs) {
      byGroup.set(job.group, [...(byGroup.get(job.group) ?? []), job]);
    }
    return [...byGroup.entries()]
      .map(([group, groupJobs]) => ({
        group,
        jobs: groupJobs,
        sharding: groupJobs.filter((job) => job.status === "sharding").length,
      }))
      .sort((a, b) => b.jobs.length - a.jobs.length || a.group.localeCompare(b.group));
  }, [platformJobs]);

  if (isLoading && !data) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading sharding data...
      </div>
    );
  }

  if (error || data?.error || !data) {
    return (
      <div className="flex h-64 items-center justify-center text-red-400">
        Failed to load sharding data.
      </div>
    );
  }

  const { summary } = data;
  const statusCounts = new Map<ShardingStatus, number>();
  for (const job of platformJobs) {
    statusCounts.set(job.status, (statusCounts.get(job.status) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Automatic sharding</h1>
        <p className="mt-1 text-zinc-500 dark:text-zinc-400">
          How many vLLM CI jobs are on runtime sharding, and how they ran on
          main.
        </p>
        <p className="mt-3 rounded-lg border border-zinc-200 bg-white p-3 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          A job is <strong>on automatic sharding</strong> when its step in{" "}
          <a
            href="https://github.com/vllm-project/vllm/tree/main/.buildkite/test_areas"
            target="_blank"
            rel="noopener"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            .buildkite/test_areas
          </a>{" "}
          sets <code>automatic_shard: true</code> (an AMD mirror also needs
          its own). The pipeline generator then splits it into{" "}
          <code>Shard N/M</code> jobs planned from recent test timings. It
          leaves a flagged job whole when it is multi-node, runs in
          docker-in-docker, or has test commands that are not all plain
          pytest. Each job is counted once, from the YAML on main; how it
          ran comes from main builds in the last {days} days.{" "}
          <a
            href="https://github.com/vllm-project/ci-infra/blob/main/automatic-shard-onboarding.md"
            target="_blank"
            rel="noopener"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            Onboarding guide
          </a>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="On automatic sharding"
          value={percent(summary.flagged, summary.jobs)}
          detail={`${summary.flagged} of ${summary.jobs} CI jobs flagged`}
        />
        <StatCard
          label="Sharding now"
          value={summary.sharding}
          detail={`ran as shards on main · last ${days}d`}
          color="green"
        />
        {(["nvidia", "amd"] as const).map((key) => (
          <StatCard
            key={key}
            label={key === "nvidia" ? "NVIDIA jobs" : "AMD jobs"}
            value={`${summary.byPlatform[key].flagged} / ${summary.byPlatform[key].jobs}`}
            detail={`flagged · ${summary.byPlatform[key].sharding} sharding`}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-5 dark:border-zinc-800">
        <SegmentedControl<PlatformFilter>
          label="Platform"
          value={platform}
          onChange={(value) => updateParams({ platform: value })}
          options={[
            { value: "all", label: "All", count: jobs.length },
            ...(["nvidia", "amd", "other"] as const).map((value) => ({
              value,
              label: PLATFORM_LABELS[value],
              count: summary.byPlatform[value].jobs,
            })),
          ]}
        />
        <SegmentedControl<string>
          label="Window"
          value={String(days)}
          onChange={(value) => updateParams({ days: value })}
          options={SHARDING_WINDOWS.map((value) => ({
            value: String(value),
            label: `${value}d`,
          }))}
        />
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <StatusBar jobs={platformJobs} />
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          {STATUSES.map((entry) => (
            <span key={entry.value} className="flex items-center gap-1.5">
              <span className={`h-2.5 w-2.5 rounded-sm ${entry.bar}`} />
              {entry.label}
              <span className="tabular-nums text-zinc-400 dark:text-zinc-500">
                {statusCounts.get(entry.value) ?? 0}
              </span>
            </span>
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">By group</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-5 py-3 font-medium">Group</th>
                <th className="px-5 py-3 text-right font-medium">Jobs</th>
                <th className="px-5 py-3 text-right font-medium whitespace-nowrap">Sharding</th>
                <th className="w-2/5 px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((row) => (
                <tr
                  key={row.group}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50"
                >
                  <td className="px-5 py-2.5">
                    <button
                      type="button"
                      onClick={() => setQuery(row.group)}
                      className="text-left hover:underline"
                    >
                      {row.group}
                    </button>
                  </td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{row.jobs.length}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                    {row.sharding} ({percent(row.sharding, row.jobs.length)})
                  </td>
                  <td className="px-5 py-2.5">
                    <StatusBar jobs={row.jobs} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Jobs</h2>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by job or group"
            aria-label="Filter jobs by name or group"
            className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm sm:w-72 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
        <div className="mb-3 overflow-x-auto">
          <SegmentedControl<StatusFilter>
            label="Status"
            value={status}
            onChange={(value) => updateParams({ status: value })}
            options={[
              { value: "all", label: "All", count: platformJobs.length },
              ...STATUSES.map((entry) => ({
                value: entry.value,
                label: entry.label,
                count: statusCounts.get(entry.value) ?? 0,
              })),
            ]}
          />
        </div>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-5 py-3 font-medium">Job</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 text-right font-medium">Shards</th>
                <th
                  className="px-3 py-3 text-right font-medium whitespace-nowrap"
                  title="Median over builds of the job's run time; for a sharded job, its slowest shard's"
                >
                  Typical run time
                </th>
                <th
                  className="px-3 py-3 text-right font-medium whitespace-nowrap"
                  title="Builds where it ran as shards, of builds where it ran"
                >
                  Sharded runs
                </th>
                <th className="px-3 py-3 text-right font-medium whitespace-nowrap">Last ran</th>
              </tr>
            </thead>
            <tbody>
              {visibleJobs.map((job) => {
                const entry = STATUS_BY_VALUE.get(job.status)!;
                const observed = job.observed;
                const runs = observed
                  ? observed.shardedBuilds + observed.unshardedBuilds
                  : 0;
                return (
                  <tr
                    key={job.label}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50"
                  >
                    <td className="max-w-[24rem] px-5 py-2">
                      <span className="block truncate" title={jobNameText(job.label)}>
                        <JobName name={job.label} />
                      </span>
                      <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {job.group}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${entry.badge}`}>
                        {entry.label}
                      </span>
                      {job.multiNode && (
                        <span className="ml-1.5 text-xs text-zinc-400">multi-node</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                      {observed?.latestShards ??
                        (observed?.maxShards ? `≤${observed.maxShards}` : "—")}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {formatDuration(observed?.p50WallSecs)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                      {observed ? `${observed.shardedBuilds} / ${runs}` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                      {relativeTime(observed?.lastSeen)}
                    </td>
                  </tr>
                );
              })}
              {visibleJobs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-zinc-400">
                    No jobs match
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        {summary.jobs} CI jobs from the test-area YAML on vLLM main ·
        how they ran: CI pipeline, main branch, last {days} days · generated{" "}
        {new Date(data.generatedAt).toLocaleString()}
      </p>
    </div>
  );
}
