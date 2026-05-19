"use client";

import { useState, useCallback } from "react";
import type { GroupStatus } from "@/lib/test-groups";
import { isOptionalJob, isSoftFailJob } from "@/lib/optional-jobs";

export interface Build {
  id: string;
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
  testGroups?: GroupStatus[];
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

function DotWithTooltip({
  color,
  label,
  detail,
  borderClass,
  href,
}: {
  color: string;
  label: string;
  detail: string;
  borderClass?: string;
  href?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <td className={`relative px-0 py-2 text-center ${borderClass ?? ""}`}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-5 w-5 items-center justify-center"
          onMouseEnter={() => setShow(true)}
          onMouseLeave={() => setShow(false)}
        >
          <span className={`block h-3.5 w-3.5 rounded-sm ${color}`} />
        </a>
      ) : (
        <div
          className="inline-flex h-5 w-5 cursor-default items-center justify-center"
          onMouseEnter={() => setShow(true)}
          onMouseLeave={() => setShow(false)}
        >
          <span className={`block h-3.5 w-3.5 rounded-sm ${color}`} />
        </div>
      )}
      {show && (
        <div className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <p className="font-medium">{label}</p>
          <p className="text-zinc-500 dark:text-zinc-400">{detail}</p>
        </div>
      )}
    </td>
  );
}

interface Column {
  type: "group" | "job";
  group: string;
  jobName?: string;
}

export function BuildsTable({ builds, showBranch, hideSoftFail, hideOptional, selectedGroups, selectedJobs }: { builds: Build[]; showBranch?: boolean; hideSoftFail?: boolean; hideOptional?: boolean; selectedGroups?: Set<string>; selectedJobs?: Set<string> }) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

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
      for (const j of g.jobs) {
        if (!shouldHideJob(j.name)) jobSet.add(j.name);
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

  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Recent Builds
          {expandedGroups.size > 0 && (
            <button
              onClick={() => setExpandedGroups(new Set())}
              className="ml-3 text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              Collapse all
            </button>
          )}
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="text-sm" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th className="sticky left-0 z-10 bg-white px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">Started</th>
              <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">Commit</th>
              {showBranch && <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">Branch</th>}
              <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">PR</th>
              <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">Author</th>
              <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">Status</th>
              <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">Message</th>
              {hasGroups &&
                columns.map((col, i) => {
                  const key = col.type === "job" ? `${col.group}::${col.jobName}` : col.group;
                  const label = col.type === "job" ? col.jobName! : col.group;
                  const isGroup = col.type === "group";
                  const isExpanded = isGroup && expandedGroups.has(col.group);
                  const isLastJob =
                    col.type === "job" &&
                    (i === columns.length - 1 || columns[i + 1].type === "group");

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
                                isExpanded
                                  ? "text-blue-600 dark:text-blue-400"
                                  : "text-zinc-700 hover:text-zinc-900 dark:text-zinc-200 dark:hover:text-zinc-100"
                              }`
                            : "text-[10px] font-normal text-zinc-400 dark:text-zinc-500"
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
                (build.testGroups ?? []).map((g) => [g.group, g])
              );

              return (
                <tr
                  key={build.id}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50"
                >
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-4 py-2 dark:bg-zinc-950">
                    {build.web_url ? (
                      <a
                        href={build.web_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-500 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
                      >
                        {build.created_at ? formatTime(build.created_at) : "—"}
                      </a>
                    ) : (
                      <span className="text-zinc-500 dark:text-zinc-400">
                        {build.created_at ? formatTime(build.created_at) : "—"}
                      </span>
                    )}
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
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
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
                  <td className="max-w-[16rem] truncate px-4 py-2 text-zinc-600 dark:text-zinc-400">
                    {build.message ?? "—"}
                  </td>
                  {columns.map((col, i) => {
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

                    if (isGroup) {
                      if (!groupStatus) {
                        return (
                          <td key={key} className={`px-0 py-2 text-center ${borderL}`}>
                            <div className="inline-flex h-5 w-5 items-center justify-center">
                              <span className="block h-3.5 w-3.5 rounded-sm bg-zinc-200 dark:bg-zinc-800" />
                            </div>
                          </td>
                        );
                      }
                      return (
                        <DotWithTooltip
                          key={key}
                          color={dotColor(groupStatus.state)}
                          label={groupStatus.group}
                          detail={`${groupStatus.passed} passed, ${groupStatus.failed} failed, ${groupStatus.running} running, ${groupStatus.blocked} blocked`}
                          borderClass={borderL}
                        />
                      );
                    }

                    // Expanded job
                    const job = groupStatus?.jobs.find(
                      (j) => j.name === col.jobName
                    );
                    if (!job) {
                      return (
                        <td key={key} className={`px-0 py-2 text-center ${borderR}`}>
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
                        label={job.name}
                        detail={job.state}
                        href={job.web_url}
                        borderClass={borderR}
                      />
                    );
                  })}
                </tr>
              );
            })}
            {builds.length === 0 && (
              <tr>
                <td
                  colSpan={FIXED_COLS + columns.length}
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
