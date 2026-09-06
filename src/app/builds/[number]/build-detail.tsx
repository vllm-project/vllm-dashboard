"use client";

import Link from "next/link";
import { useMemo } from "react";
import useSWR from "swr";
import { BuildWaterfall } from "@/components/build-waterfall";
import { JobName } from "@/components/job-name";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelEmpty } from "@/components/panel";
import { StatCard } from "@/components/stat-card";
import { formatRelativeTime } from "@/lib/alerts-shared";
import { useUrlState } from "@/lib/use-url-state";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error ?? `Request failed: ${response.status}`);
  return data;
};

interface BuildRecord {
  id: string;
  build_number: string;
  organization_slug: string | null;
  pipeline_slug: string | null;
  web_url: string;
  message: string;
  commit_sha: string;
  pipeline: string;
  branch: string;
  state: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  author: string | null;
  pr_number: string | null;
  duration_secs: number | null;
}

interface GroupSummary {
  group: string;
  state: "passed" | "failed" | "running" | "blocked";
  passed: number;
  failed: number;
  running: number;
  blocked: number;
  total: number;
  failedJobs?: Array<{ name: string; web_url: string }>;
}

interface GroupsResponse {
  groupsByBuild: Record<string, GroupSummary[]>;
  startedJobCountsByBuild: Record<string, number>;
  error?: string;
}

function stateTone(state: string): "green" | "red" | "yellow" | "default" {
  if (state === "passed") return "green";
  if (state === "failed" || state === "failing") return "red";
  if (state === "running" || state === "scheduled") return "yellow";
  return "default";
}

function stateBadge(state: string): string {
  switch (stateTone(state)) {
    case "green":
      return "bg-ok-soft text-ok";
    case "red":
      return "bg-bad-soft text-bad";
    case "yellow":
      return "bg-warn-soft text-warn";
    default:
      return "bg-surface-muted text-muted";
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const DEFAULTS = { pipeline: "CI" };

export default function BuildDetail({ number }: { number: string }) {
  const [url] = useUrlState(DEFAULTS);
  const pipeline = url.pipeline;

  const { data, error, isLoading } = useSWR<{ build: BuildRecord }>(
    `/api/builds/${encodeURIComponent(number)}?pipeline=${encodeURIComponent(pipeline)}`,
    fetcher,
    { refreshInterval: 60_000 },
  );
  const build = data?.build ?? null;

  const { data: groupData } = useSWR<GroupsResponse>(
    build ? `/api/builds/groups?buildIds=${encodeURIComponent(build.id)}` : null,
    fetcher,
    { refreshInterval: 60_000 },
  );
  const groups = useMemo(
    () => (build ? groupData?.groupsByBuild[build.id] ?? [] : []),
    [build, groupData],
  );
  const startedJobCount = build
    ? groupData?.startedJobCountsByBuild[build.id]
    : undefined;

  if (isLoading && !data) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted">
        Loading build #{number}...
      </div>
    );
  }

  if (error || !build) {
    return (
      <div className="space-y-4">
        <PageHeader title={`Build #${number}`} />
        <PanelEmpty className="rounded-xl border border-dashed border-line">
          {error instanceof Error && error.message === "Build not found"
            ? `No ${pipeline} build #${number} was found in the warehouse.`
            : "This build could not be loaded."}
          <br />
          <Link href="/builds" className="mt-2 inline-block text-accent hover:underline">
            Back to builds
          </Link>
        </PanelEmpty>
      </div>
    );
  }

  const failedGroups = groups.filter((group) => group.failed > 0);
  const passedGroups = groups.filter((group) => group.failed === 0 && group.passed > 0);
  const runningGroups = groups.filter((group) => group.running > 0);
  const failedJobCount = groups.reduce((sum, group) => sum + group.failed, 0);
  const passedJobCount = groups.reduce((sum, group) => sum + group.passed, 0);
  const canShowTrace = Boolean(
    build.organization_slug && build.pipeline_slug && build.build_number,
  );
  const commitShort = build.commit_sha?.slice(0, 7);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            <span>Build #{build.build_number}</span>
            <span
              className={`rounded-md px-2 py-0.5 text-sm font-medium capitalize ${stateBadge(build.state)}`}
            >
              {build.state}
            </span>
          </span>
        }
        description={build.message}
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {build.pipeline} · {build.branch}
            </span>
            {commitShort && (
              <a
                href={`https://github.com/vllm-project/vllm/commit/${build.commit_sha}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-accent hover:underline"
              >
                {commitShort}
              </a>
            )}
            {build.pr_number && (
              <a
                href={`https://github.com/vllm-project/vllm/pull/${build.pr_number}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                PR #{build.pr_number}
              </a>
            )}
            {build.author && <span>{build.author}</span>}
            <span>{formatRelativeTime(build.created_at)}</span>
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/builds"
              className="dashboard-control inline-flex h-9 items-center rounded-md border border-line px-3 text-sm font-medium hover:bg-surface-muted"
            >
              All builds
            </Link>
            <a
              href={build.web_url}
              target="_blank"
              rel="noopener noreferrer"
              className="dashboard-control inline-flex h-9 items-center gap-1 rounded-md bg-foreground px-3 text-sm font-medium text-background hover:opacity-90"
            >
              Open in Buildkite <span aria-hidden="true">↗</span>
            </a>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Duration"
          value={formatDuration(build.duration_secs)}
          detail={
            build.started_at
              ? `Started ${formatRelativeTime(build.started_at)}`
              : "Not started"
          }
        />
        <StatCard
          label="Failed jobs"
          value={groupData ? failedJobCount : "—"}
          color={failedJobCount > 0 ? "red" : "green"}
          detail={groupData ? `${failedGroups.length} of ${groups.length} groups` : undefined}
        />
        <StatCard
          label="Passed jobs"
          value={groupData ? passedJobCount : "—"}
          color="green"
          detail={groupData ? `${passedGroups.length} groups fully passed` : undefined}
        />
        <StatCard
          label="Jobs started"
          value={startedJobCount ?? "—"}
          detail={
            runningGroups.length > 0
              ? `${runningGroups.length} groups still running`
              : undefined
          }
        />
      </div>

      <Panel
        title="Failed jobs"
        description={
          failedGroups.length > 0
            ? "Grouped by test area. Each job opens in Buildkite."
            : "Nothing failed in this build."
        }
      >
        {!groupData ? (
          <PanelEmpty>Loading job groups...</PanelEmpty>
        ) : failedGroups.length === 0 ? (
          <PanelEmpty>
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-ok" />
              All {groups.length} groups passed or are still running.
            </span>
          </PanelEmpty>
        ) : (
          <ul className="divide-y divide-line">
            {failedGroups.map((group) => (
              <li key={group.group} className="px-4 py-3 sm:px-5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-semibold text-foreground">{group.group}</p>
                  <p className="text-xs tabular-nums text-muted">
                    <span className="font-medium text-bad">{group.failed} failed</span>
                    {" · "}
                    {group.passed} passed
                    {group.running > 0 ? ` · ${group.running} running` : ""}
                  </p>
                </div>
                <ul className="mt-1.5 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {(group.failedJobs ?? []).map((job) => (
                    <li key={job.name} className="truncate text-sm">
                      <a
                        href={job.web_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-bad hover:underline"
                      >
                        <JobName name={job.name} />
                      </a>
                    </li>
                  ))}
                  {(group.failedJobs ?? []).length === 0 && (
                    <li className="text-xs text-muted">Job names not available.</li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Timeline"
        description="When each job ran, and which ones sat on the critical path."
      >
        {canShowTrace ? (
          <BuildWaterfall
            organization={build.organization_slug!}
            pipeline={build.pipeline_slug!}
            buildNumber={build.build_number}
            buildUrl={build.web_url}
            startedJobCount={startedJobCount}
          />
        ) : (
          <PanelEmpty>Timeline is unavailable for this build.</PanelEmpty>
        )}
      </Panel>
    </div>
  );
}
