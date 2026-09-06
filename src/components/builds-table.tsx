"use client";

import { Fragment, useState, useCallback, useMemo, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import useSWR from "swr";
import { BuildWaterfall } from "@/components/build-waterfall";
import { JobName, jobNameText } from "@/components/job-name";
import { SegmentedControl } from "@/components/segmented-control";
import type { GroupStatus } from "@/lib/test-groups";
import { isOptionalJob, isSoftFailJob } from "@/lib/optional-jobs";

export interface Build {
  id: string;
  build_number: string | null;
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
  testGroups?: Array<
    GroupStatus & {
      failedJobs?: Array<{ name: string; web_url: string }>;
    }
  >;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return timeStr;
  }
  const msPerDay = 86400000;
  const daysAgo = (now.getTime() - d.getTime()) / msPerDay;
  if (daysAgo < 7) {
    return `${DAYS[d.getDay()]} ${timeStr}`;
  }
  const month = d.toLocaleString("en-US", { month: "short" });
  return `${month} ${d.getDate()} ${timeStr}`;
}

function stateColor(state: string) {
  switch (state) {
    case "passed":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400";
    case "failed":
    case "failing":
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400";
    case "running":
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-400";
    case "scheduled":
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-400";
    case "canceled":
    case "canceling":
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
    default:
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  }
}

function dotColor(state: string) {
  switch (state) {
    case "passed":
      return "bg-emerald-500";
    case "failed":
    case "failing":
    case "broken":
    case "timed_out":
      return "bg-red-500";
    case "running":
    case "scheduled":
    case "reserved":
      return "bg-yellow-500 animate-pulse";
    case "mixed":
      return "bg-yellow-500";
    case "blocked":
      return "bg-zinc-300 dark:bg-zinc-500";
    case "skipped":
    case "not_run":
    case "canceled":
    case "canceling":
      return "bg-zinc-200 dark:bg-zinc-700";
    default:
      return "bg-zinc-200 dark:bg-zinc-700";
  }
}

const HIGHLIGHT = "bg-blue-50 dark:bg-blue-950/40";

function DotWithTooltip({
  color,
  ariaLabel,
  tooltip,
  borderClass,
  href,
  onClick,
  highlight,
  onHover,
}: {
  color: string;
  ariaLabel: string;
  tooltip: ReactNode;
  borderClass?: string;
  href?: string;
  onClick?: () => void;
  highlight?: boolean;
  onHover?: (hovering: boolean) => void;
}) {
  // Viewport coordinates of the dot, so the popup can be position:fixed and
  // escape the table's overflow-x-auto clipping.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const enter = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAnchor({ x: r.left + r.width / 2, y: r.top });
    onHover?.(true);
  };
  const leave = () => {
    setAnchor(null);
    onHover?.(false);
  };
  const nearRightEdge =
    anchor !== null &&
    typeof window !== "undefined" &&
    anchor.x > window.innerWidth * 0.7;
  const dot = <span className={`block h-3.5 w-3.5 rounded-sm ${color}`} />;
  const cls = "inline-flex h-5 w-5 items-center justify-center";
  return (
    <td
      className={`relative px-0 py-2 text-center ${borderClass ?? ""} ${highlight ? HIGHLIGHT : ""}`}
    >
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={ariaLabel}
          className={`${cls} cursor-pointer`}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          {dot}
        </a>
      ) : onClick ? (
        <button
          type="button"
          aria-label={ariaLabel}
          className={`${cls} cursor-pointer`}
          onClick={onClick}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          {dot}
        </button>
      ) : (
        <div
          className={`${cls} cursor-default`}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          {dot}
        </div>
      )}
      {anchor && (
        <div
          className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md border border-line bg-white px-3 py-2 text-left text-xs shadow-lg dark:bg-zinc-900"
          style={{
            left: anchor.x,
            top: anchor.y - 8,
            transform: nearRightEdge
              ? "translate(-100%, -100%)"
              : "translate(-50%, -100%)",
          }}
        >
          {tooltip}
        </div>
      )}
    </td>
  );
}

function stateTextColor(state: string) {
  switch (state) {
    case "passed":
      return "text-emerald-600 dark:text-emerald-400";
    case "failed":
    case "failing":
    case "broken":
    case "timed_out":
      return "text-red-600 dark:text-red-400";
    case "running":
    case "scheduled":
    case "reserved":
    case "mixed":
      return "text-yellow-600 dark:text-yellow-400";
    default:
      return "text-muted";
  }
}

function BuildContext({ build }: { build: Build }) {
  return (
    <p className="mt-1.5 border-t border-zinc-100 pt-1.5 text-muted dark:border-zinc-800">
      {build.build_number ? `Build #${build.build_number}` : "Build"}
      {build.commit_sha ? ` · ${build.commit_sha.slice(0, 7)}` : ""}
      {build.author ? ` · ${build.author}` : ""}
      {build.created_at ? ` · ${formatTime(build.created_at)}` : ""}
    </p>
  );
}

type GroupWithJobs = GroupStatus & {
  failedJobs?: Array<{ name: string; web_url: string }>;
  jobs: Array<{ name: string; state: string; web_url?: string }>;
};

/**
 * The compact view's group summary: one chip per failed or running group,
 * and a quiet "all passed" line when nothing needs attention.
 */
function GroupChipsCell({
  build,
  groups,
  expanded,
  onToggle,
}: {
  build: Build;
  groups: GroupWithJobs[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const failed = groups.filter((g) => g.failed > 0);
  const running = groups.filter((g) => g.running > 0 && g.failed === 0);
  const blocked = groups.filter(
    (g) => g.blocked > 0 && g.failed === 0 && g.running === 0 && g.passed === 0,
  );
  const passedCount = groups.filter(
    (g) => g.state === "passed" || (g.failed === 0 && g.running === 0 && g.passed > 0),
  ).length;

  if (groups.length === 0) {
    return (
      <td className="px-4 py-2 text-xs text-muted">
        <span className="inline-block h-2 w-2 rounded-full bg-line-strong align-middle" />{" "}
        No group data yet
      </td>
    );
  }

  const MAX_CHIPS = 6;
  const shown = failed.slice(0, MAX_CHIPS);
  const overflow = failed.length - shown.length;

  return (
    <td className="px-4 py-2 align-middle">
      <div className="flex flex-wrap items-center gap-1.5">
        {failed.length > 0 && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={`build-failures-${build.id}`}
            className="dashboard-control flex flex-wrap items-center gap-1.5 rounded-md text-left"
            title={expanded ? "Hide failed jobs" : "Show failed jobs"}
          >
            {shown.map((group) => (
              <span
                key={group.group}
                className="inline-flex items-center gap-1 rounded-md bg-bad-soft px-1.5 py-0.5 text-xs font-medium text-bad"
              >
                {group.group}
                <span className="tabular-nums opacity-80">{group.failed}</span>
              </span>
            ))}
            {overflow > 0 && (
              <span className="rounded-md bg-bad-soft px-1.5 py-0.5 text-xs font-medium text-bad">
                +{overflow} more
              </span>
            )}
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className={`h-3 w-3 text-muted transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
            >
              <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
            </svg>
          </button>
        )}
        {running.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md bg-warn-soft px-1.5 py-0.5 text-xs font-medium text-warn">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
            {running.length} running
          </span>
        )}
        {failed.length === 0 && running.length === 0 && passedCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            {passedCount} groups passed
          </span>
        )}
        {failed.length === 0 && running.length === 0 && passedCount === 0 && blocked.length > 0 && (
          <span className="text-xs text-muted">{blocked.length} groups blocked</span>
        )}
        {failed.length > 0 && passedCount > 0 && (
          <span className="text-xs text-muted">· {passedCount} passed</span>
        )}
      </div>
    </td>
  );
}

function FailedJobsDetail({ groups }: { groups: GroupWithJobs[] }) {
  const failed = groups.filter((g) => g.failed > 0);
  if (failed.length === 0) {
    return <p className="text-xs text-muted">No failed jobs.</p>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {failed.map((group) => {
        const jobs =
          group.failedJobs && group.failedJobs.length > 0
            ? group.failedJobs
            : group.jobs
                .filter((job) => ["failed", "failing", "broken", "timed_out"].includes(job.state))
                .map((job) => ({ name: job.name, web_url: job.web_url ?? "" }));
        return (
          <div key={group.group} className="min-w-0">
            <p className="text-xs font-semibold text-foreground">
              {group.group}
              <span className="ml-1.5 font-normal text-muted">
                {group.failed} failed · {group.passed} passed
              </span>
            </p>
            <ul className="mt-1 space-y-0.5">
              {jobs.slice(0, 8).map((job) => (
                <li key={job.name} className="truncate text-xs">
                  {job.web_url ? (
                    <a
                      href={job.web_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-bad hover:underline"
                    >
                      <JobName name={job.name} />
                    </a>
                  ) : (
                    <span className="text-bad">
                      <JobName name={job.name} />
                    </span>
                  )}
                </li>
              ))}
              {jobs.length > 8 && (
                <li className="text-xs text-muted">+{jobs.length - 8} more</li>
              )}
              {jobs.length === 0 && (
                <li className="text-xs text-muted">Job list not loaded; open the matrix view.</li>
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

interface Column {
  type: "group" | "job";
  group: string;
  jobName?: string;
}

interface BuildJobsResponse {
  jobsByBuild: Record<
    string,
    Record<string, Array<{ name: string; state: string; web_url?: string }>>
  >;
}

type CompactJobsByBuild = Record<
  string,
  Record<string, Array<[nameIndex: number, state: string]>>
>;

export type BuildsTableView = "compact" | "matrix";

interface BuildsTableProps {
  builds: Build[];
  /** Compact shows failed groups as chips; matrix shows every group column. */
  view?: BuildsTableView;
  onViewChange?: (view: BuildsTableView) => void;
  jobNames: string[];
  jobsByBuild: CompactJobsByBuild;
  startedJobCountsByBuild: Record<string, number>;
  showBranch?: boolean;
  hideSoftFail?: boolean;
  hideOptional?: boolean;
  selectedGroups?: Set<string>;
  selectedJobs?: Set<string>;
}

const fetcher = (url: string) => fetch(url).then((response) => response.json());

export function BuildsTable({
  builds,
  view = "compact",
  onViewChange,
  jobNames,
  jobsByBuild,
  startedJobCountsByBuild,
  showBranch,
  hideSoftFail,
  hideOptional,
  selectedGroups,
  selectedJobs,
}: BuildsTableProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedBuildId, setExpandedBuildId] = useState<string | null>(null);
  const [failuresBuildId, setFailuresBuildId] = useState<string | null>(null);
  const isMatrix = view === "matrix";
  const [hoveredCol, setHoveredCol] = useState<string | null>(null);
  const buildIds = useMemo(
    () => builds.map((build) => build.id),
    [builds],
  );
  const expandedGroupList = useMemo(
    () => [...expandedGroups].sort(),
    [expandedGroups],
  );
  const jobDetailsUrl =
    buildIds.length > 0 && expandedGroupList.length > 0
      ? `/api/builds/jobs?buildIds=${encodeURIComponent(buildIds.join(","))}&groups=${encodeURIComponent(expandedGroupList.join(","))}`
      : null;
  const { data: jobDetails } = useSWR<BuildJobsResponse>(
    jobDetailsUrl,
    fetcher,
    { keepPreviousData: true },
  );

  const shouldHideJob = (name: string): boolean => {
    if (hideSoftFail && isSoftFailJob(name)) return true;
    if (hideOptional && isOptionalJob(name)) return true;
    return false;
  };

  const allGroups = new Map<string, Set<string>>();
  for (const build of builds) {
    for (const g of build.testGroups ?? []) {
      if (!allGroups.has(g.group)) allGroups.set(g.group, new Set());
      const jobSet = allGroups.get(g.group)!;
      const compactJobs = jobsByBuild[build.id]?.[g.group] ?? [];
      for (const [nameIndex] of compactJobs) {
        const name = jobNames[nameIndex];
        if (name && !shouldHideJob(name)) jobSet.add(name);
      }
    }
  }
  const hasGroupFilter = selectedGroups && selectedGroups.size > 0;
  const groupOrder = [...allGroups.keys()]
    .filter((g) => !hasGroupFilter || selectedGroups.has(g))
    .sort();

  const hasJobFilter = selectedJobs && selectedJobs.size > 0;

  const columns: Column[] = [];
  for (const group of groupOrder) {
    columns.push({ type: "group", group });
    if (expandedGroups.has(group)) {
      const jobNames = [...allGroups.get(group)!]
        .filter((name) => !hasJobFilter || selectedJobs.has(name))
        .sort();
      for (const jobName of jobNames) {
        columns.push({ type: "job", group, jobName });
      }
    }
  }

  const toggleGroup = useCallback((group: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const hasGroups = groupOrder.length > 0;
  const FIXED_COLS = showBranch ? 7 : 6;
  const TOTAL_COLS = FIXED_COLS + (isMatrix ? columns.length : 1);
  const headCell =
    "px-4 pb-2 text-left align-bottom text-xs font-semibold uppercase tracking-wide text-muted";

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Recent builds
          </h2>
          <p className="text-xs text-muted">
            {isMatrix
              ? "Every test group as a column. Click a group to expand its jobs."
              : "Failed and running groups per build. Switch to Matrix for every group."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isMatrix && expandedGroups.size > 0 && (
            <button
              type="button"
              onClick={() => setExpandedGroups(new Set())}
              className="dashboard-control text-xs font-medium text-accent hover:text-accent-strong"
            >
              Collapse groups
            </button>
          )}
          {onViewChange && (
            <SegmentedControl
              label="Builds table view"
              value={view}
              onChange={onViewChange}
              options={[
                { value: "compact", label: "Compact" },
                { value: "matrix", label: "Matrix" },
              ]}
            />
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className={`text-sm ${isMatrix ? "" : "w-full"}`} style={{ borderCollapse: "separate", borderSpacing: 0 }}>
          <thead>
            <tr className="border-b border-line">
              <th className={`sticky left-0 z-10 bg-surface pt-3 ${headCell}`}>Build</th>
              <th className={`pt-3 ${headCell}`}>Commit</th>
              {showBranch && <th className={`pt-3 ${headCell}`}>Branch</th>}
              <th className={`pt-3 ${headCell}`}>PR</th>
              <th className={`pt-3 ${headCell}`}>Author</th>
              <th className={`pt-3 ${headCell}`}>Status</th>
              <th className={`pt-3 ${headCell}`}>Message</th>
              {!isMatrix && <th className={`w-full pt-3 ${headCell}`}>Groups</th>}
              {isMatrix &&
                hasGroups &&
                columns.map((col, i) => {
                  const key = col.type === "job" ? `${col.group}::${col.jobName}` : col.group;
                  const label = col.type === "job" ? col.jobName! : col.group;
                  const isGroup = col.type === "group";
                  const isExpanded = isGroup && expandedGroups.has(col.group);
                  const isLastJob =
                    col.type === "job" &&
                    (i === columns.length - 1 || columns[i + 1].type === "group");
                  const isHovered = hoveredCol === key;

                  return (
                    <th
                      key={key}
                      className="relative p-0 align-bottom"
                      style={{ width: 28, minWidth: 28, height: 160 }}
                    >
                      {/* Short vertical tick at the bottom of the header */}
                      {(isExpanded || isLastJob) && (
                        <div
                          className={`absolute bottom-0 h-2 w-px bg-zinc-300 dark:bg-zinc-600 ${
                            isExpanded ? "left-0" : "right-0"
                          }`}
                        />
                      )}
                      <div
                        className={`absolute bottom-2 left-1/2 origin-bottom-left whitespace-nowrap ${
                          isGroup
                            ? `cursor-pointer text-[12px] font-semibold ${
                                isExpanded || isHovered
                                  ? "text-blue-600 dark:text-blue-400"
                                  : "text-zinc-700 hover:text-zinc-900 dark:text-zinc-200 dark:hover:text-zinc-100"
                              }`
                            : `text-[10px] ${
                                isHovered
                                  ? "font-semibold text-blue-600 dark:text-blue-400"
                                  : "font-normal text-zinc-400 dark:text-zinc-500"
                              }`
                        }`}
                        style={{
                          transform: "rotate(-55deg)",
                          transformOrigin: "0% 100%",
                          left: "50%",
                        }}
                        onClick={isGroup ? () => toggleGroup(col.group) : undefined}
                      >
                        {isGroup && (
                          <span className="mr-0.5 inline-block text-[10px]">
                            {isExpanded ? "▾" : "▸"}
                          </span>
                        )}
                        {label}
                      </div>
                    </th>
                  );
                })}
            </tr>
          </thead>
          <tbody>
            {builds.map((build) => {
              const groupMap = new Map(
                (build.testGroups ?? []).map((g) => {
                  const details =
                    jobDetails?.jobsByBuild[build.id]?.[g.group] ?? [];
                  const urlsByName = new Map(
                    details.map((job) => [job.name, job.web_url]),
                  );
                  const failedUrlsByName = new Map(
                    (g.failedJobs ?? []).map((job) => [job.name, job.web_url]),
                  );
                  const jobs = (jobsByBuild[build.id]?.[g.group] ?? [])
                    .map(([nameIndex, state]) => ({
                      name: jobNames[nameIndex],
                      state,
                      web_url:
                        urlsByName.get(jobNames[nameIndex]) ??
                        failedUrlsByName.get(jobNames[nameIndex]),
                    }))
                    .filter((job) => Boolean(job.name));
                  return [g.group, { ...g, jobs }];
                })
              );
              const canShowTrace = Boolean(
                build.organization_slug &&
                  build.pipeline_slug &&
                  build.build_number,
              );
              const isTraceExpanded = expandedBuildId === build.id;
              const startedJobCount = startedJobCountsByBuild[build.id];

              return (
                <Fragment key={build.id}>
                  <tr
                    className={`group border-b border-zinc-100 transition-colors dark:border-zinc-800/50 ${
                      isTraceExpanded ? "bg-surface-muted/60" : ""
                    } ${isTraceExpanded ? "" : "hover:bg-blue-50 dark:hover:bg-blue-950/40"}`}
                  >
                    <td
                      className={`sticky left-0 z-10 whitespace-nowrap px-4 py-2 ${
                        isTraceExpanded
                          ? "bg-zinc-50 dark:bg-zinc-900"
                          : "bg-surface group-hover:bg-blue-50 dark:group-hover:bg-blue-950"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        {canShowTrace ? (
                          <button
                            type="button"
                            aria-label={`${isTraceExpanded ? "Hide" : "Show"} timeline for build ${build.build_number}`}
                            aria-expanded={isTraceExpanded}
                            aria-controls={`build-trace-${build.id}`}
                            onClick={() =>
                              setExpandedBuildId((current) =>
                                current === build.id ? null : build.id,
                              )
                            }
                            className={`dashboard-control inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
                              isTraceExpanded
                                ? "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-300"
                                : "border-zinc-300 bg-surface text-zinc-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-blue-800 dark:hover:bg-blue-950/50 dark:hover:text-blue-300"
                            }`}
                          >
                            <svg
                              viewBox="0 0 16 16"
                              aria-hidden="true"
                              className="h-3.5 w-3.5"
                            >
                              <path
                                d="M2.5 4.25h3v7.5h-3zm4-2h3v9.5h-3zm4 4h3v5.5h-3z"
                                fill="currentColor"
                              />
                            </svg>
                            <span>
                              {isTraceExpanded ? "Hide timeline" : "View timeline"}
                            </span>
                            <svg
                              viewBox="0 0 16 16"
                              aria-hidden="true"
                              className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${isTraceExpanded ? "rotate-90" : ""}`}
                            >
                              <path
                                d="m6 3.5 4.5 4.5L6 12.5"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="1.5"
                              />
                            </svg>
                          </button>
                        ) : (
                          <span
                            className="inline-flex min-h-8 items-center rounded-md border border-line px-2.5 text-xs text-zinc-400 dark:text-zinc-600"
                            title="Timeline unavailable"
                          >
                            No timeline
                          </span>
                        )}
                        <span className="text-muted">
                          {build.created_at ? formatTime(build.created_at) : "—"}
                        </span>
                        {build.build_number ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Link
                              href={`/builds/${build.build_number}${build.pipeline ? `?pipeline=${encodeURIComponent(build.pipeline)}` : ""}`}
                              className="font-medium tabular-nums text-accent hover:underline"
                              title="Build details"
                            >
                              #{build.build_number}
                            </Link>
                            {build.web_url && (
                              <a
                                href={build.web_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`Open Buildkite build ${build.build_number}`}
                                title="Open in Buildkite"
                                className="text-muted hover:text-accent"
                              >
                                <span aria-hidden="true">↗</span>
                              </a>
                            )}
                          </span>
                        ) : null}
                      </div>
                    </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {build.commit_sha ? (
                      <a
                        href={`https://github.com/vllm-project/vllm/commit/${build.commit_sha}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {build.commit_sha.slice(0, 7)}
                      </a>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </td>
                  {showBranch && (
                    <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                      {build.branch}
                    </td>
                  )}
                  <td className="px-4 py-2 text-xs">
                    {build.pr_number ? (
                      <a
                        href={`https://github.com/vllm-project/vllm/pull/${build.pr_number}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        #{build.pr_number}
                      </a>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="max-w-[10rem] truncate px-4 py-2 text-zinc-600 dark:text-zinc-400" title={build.author ?? undefined}>
                    {build.author ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    {build.web_url ? (
                      <a
                        href={build.web_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium underline decoration-current/30 hover:decoration-current ${stateColor(build.state)}`}
                      >
                        {build.state}
                      </a>
                    ) : (
                      <span
                        className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${stateColor(build.state)}`}
                      >
                        {build.state}
                      </span>
                    )}
                  </td>
                  <td className="max-w-[16rem] truncate px-4 py-2 text-zinc-600 dark:text-zinc-400" title={build.message ?? undefined}>
                    {build.message ?? "—"}
                  </td>
                  {!isMatrix && (
                    <GroupChipsCell
                      build={build}
                      groups={[...groupMap.values()]}
                      expanded={failuresBuildId === build.id}
                      onToggle={() =>
                        setFailuresBuildId((current) =>
                          current === build.id ? null : build.id,
                        )
                      }
                    />
                  )}
                    {isMatrix && columns.map((col, i) => {
                    const key =
                      col.type === "job"
                        ? `${col.group}::${col.jobName}`
                        : col.group;
                    const groupStatus = groupMap.get(col.group);
                    const isGroup = col.type === "group";
                    const isExpanded = isGroup && expandedGroups.has(col.group);
                    const isLastJob =
                      col.type === "job" &&
                      (i === columns.length - 1 || columns[i + 1].type === "group");

                    const borderL = isExpanded
                      ? "border-l border-zinc-300 dark:border-zinc-600"
                      : "";
                    const borderR = isLastJob
                      ? "border-r border-zinc-300 dark:border-zinc-600"
                      : "";
                    const colHighlight = hoveredCol === key ? HIGHLIGHT : "";
                    const onHover = (hovering: boolean) =>
                      setHoveredCol(hovering ? key : null);

                    if (isGroup) {
                      if (!groupStatus) {
                        return (
                          <td key={key} className={`px-0 py-2 text-center ${borderL} ${colHighlight}`}>
                            <div className="inline-flex h-5 w-5 items-center justify-center">
                              <span className="block h-3.5 w-3.5 rounded-sm bg-zinc-200 dark:bg-zinc-800" />
                            </div>
                          </td>
                        );
                      }
                      const failedJobLinks = groupStatus.failedJobs ?? [];
                      const failedJobHref =
                        groupStatus.failed === 1 && failedJobLinks.length === 1
                          ? failedJobLinks[0].web_url
                          : undefined;
                      return (
                        <DotWithTooltip
                          key={key}
                          color={dotColor(groupStatus.state)}
                          ariaLabel={`${groupStatus.group}: ${groupStatus.passed} passed, ${groupStatus.failed} failed, ${groupStatus.running} running, ${groupStatus.blocked} blocked`}
                          tooltip={
                            <>
                              <p className="font-medium">{groupStatus.group}</p>
                              <p className={stateTextColor(groupStatus.state)}>
                                <span className="capitalize">{groupStatus.state}</span>
                                <span className="text-muted">
                                  {` · ${groupStatus.passed} passed, ${groupStatus.failed} failed, ${groupStatus.running} running, ${groupStatus.blocked} blocked`}
                                </span>
                              </p>
                              {failedJobLinks.length > 0 && (
                                <ul className="mt-1 text-red-600 dark:text-red-400">
                                  {failedJobLinks.slice(0, 5).map((job) => (
                                    <li key={job.name}>✕ <JobName name={job.name} /></li>
                                  ))}
                                  {failedJobLinks.length > 5 && (
                                    <li className="text-muted">
                                      +{failedJobLinks.length - 5} more
                                    </li>
                                  )}
                                </ul>
                              )}
                              <BuildContext build={build} />
                              {failedJobHref ? (
                                <p className="mt-1 text-zinc-400 dark:text-zinc-500">Click to open job in Buildkite ↗</p>
                              ) : groupStatus.failed > 1 && failedJobLinks.length > 0 ? (
                                <p className="mt-1 text-zinc-400 dark:text-zinc-500">Click to expand jobs</p>
                              ) : null}
                            </>
                          }
                          highlight={hoveredCol === key}
                          onHover={onHover}
                          borderClass={borderL}
                          href={failedJobHref}
                          onClick={
                            groupStatus.failed > 1 && failedJobLinks.length > 0
                              ? () => toggleGroup(groupStatus.group)
                              : undefined
                          }
                        />
                      );
                    }

                    // Expanded job
                    const job = groupStatus?.jobs.find(
                      (j) => j.name === col.jobName
                    );
                    if (!job) {
                      return (
                        <td key={key} className={`px-0 py-2 text-center ${borderR} ${colHighlight}`}>
                          <div className="inline-flex h-5 w-5 items-center justify-center">
                            <span className="block h-3.5 w-3.5 rounded-sm bg-zinc-200 dark:bg-zinc-800" />
                          </div>
                        </td>
                      );
                    }
                    return (
                      <DotWithTooltip
                        key={key}
                        color={dotColor(job.state)}
                        ariaLabel={`${jobNameText(job.name)}: ${job.state}`}
                        tooltip={
                          <>
                            <p className="font-medium"><JobName name={job.name} /></p>
                            <p className="text-muted">{col.group}</p>
                            <p className={`capitalize ${stateTextColor(job.state)}`}>
                              {job.state.replace(/_/g, " ")}
                            </p>
                            <BuildContext build={build} />
                            {job.web_url && (
                              <p className="mt-1 text-zinc-400 dark:text-zinc-500">Click to open in Buildkite ↗</p>
                            )}
                          </>
                        }
                        href={job.web_url}
                        highlight={hoveredCol === key}
                        onHover={onHover}
                        borderClass={borderR}
                      />
                    );
                    })}
                  </tr>
                  {!isMatrix && failuresBuildId === build.id && (
                    <tr id={`build-failures-${build.id}`}>
                      <td colSpan={TOTAL_COLS} className="bg-surface-muted/60 px-4 py-3 sm:px-5">
                        <FailedJobsDetail groups={[...groupMap.values()]} />
                      </td>
                    </tr>
                  )}
                  {isTraceExpanded && canShowTrace && (
                    <tr id={`build-trace-${build.id}`}>
                      <td
                        colSpan={TOTAL_COLS}
                        className="p-0"
                      >
                        <BuildWaterfall
                          organization={build.organization_slug!}
                          pipeline={build.pipeline_slug!}
                          buildNumber={build.build_number!}
                          buildUrl={build.web_url}
                          startedJobCount={startedJobCount}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {builds.length === 0 && (
              <tr>
                <td
                  colSpan={TOTAL_COLS}
                  className="px-5 py-8 text-center text-zinc-400"
                >
                  No builds found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
