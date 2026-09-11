"use client";

import {
  Fragment,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type MouseEvent,
  type ReactNode,
} from "react";
import useSWR from "swr";
import { BuildWaterfall } from "@/components/build-waterfall";
import { JobName, jobNameText, splitJobName } from "@/components/job-name";
import type { GroupStatus } from "@/lib/test-groups";
import { isOptionalJob, isSoftFailJob } from "@/lib/optional-jobs";
import {
  buildDurationDisplay,
  isBuildInProgress,
  type BuildDurationKind,
} from "@/lib/build-duration";

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
          className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
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
      return "text-zinc-500 dark:text-zinc-400";
  }
}

/**
 * Current time that re-renders on `intervalMs`. Pass `null` to stop ticking
 * (the value then only updates when the component re-renders for other
 * reasons). Used to keep "so far" durations of running builds fresh.
 */
function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function durationColor(kind: BuildDurationKind) {
  switch (kind) {
    case "running":
      return "font-medium text-yellow-600 dark:text-yellow-400";
    case "queued":
      return "text-yellow-600 dark:text-yellow-400";
    case "unknown":
      return "text-zinc-400 dark:text-zinc-600";
    default:
      return "text-zinc-600 dark:text-zinc-400";
  }
}

function BuildContext({ build }: { build: Build }) {
  return (
    <p className="mt-1.5 border-t border-zinc-100 pt-1.5 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
      {build.build_number ? `Build #${build.build_number}` : "Build"}
      {build.commit_sha ? ` · ${build.commit_sha.slice(0, 7)}` : ""}
      {build.author ? ` · ${build.author}` : ""}
      {build.created_at ? ` · ${formatTime(build.created_at)}` : ""}
    </p>
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

interface BuildsTableProps {
  builds: Build[];
  jobNames: string[];
  jobsByBuild: CompactJobsByBuild;
  startedJobCountsByBuild: Record<string, number>;
  showBranch?: boolean;
  hideSoftFail?: boolean;
  hideOptional?: boolean;
  selectedGroups?: Set<string>;
  selectedJobs?: Set<string>;
  groupsLoading?: boolean;
}

// Placeholder columns shown while the group matrix loads, so the table grows
// shimmer columns instead of the group columns appearing out of nowhere. The
// count approximates the CI pipeline's group count; a small mismatch only
// changes how far the empty area extends, not any real content.
const SKELETON_GROUP_COLUMNS = 40;

// Matrix column headers are rotated so ~40 narrow columns fit. The header row
// must be tall enough for the longest label's vertical extent, otherwise the
// label runs past the top of the table and the scroll container clips it.
const HEADER_LABEL_ANGLE = (55 * Math.PI) / 180;
const HEADER_LABEL_SIN = Math.sin(HEADER_LABEL_ANGLE);
const HEADER_LABEL_COS = Math.cos(HEADER_LABEL_ANGLE);
const HEADER_COLUMN_WIDTH = 28;
const HEADER_LABEL_BOTTOM = 8; // matches the label's bottom-2 offset
const MIN_HEADER_HEIGHT = 160;
// Labels wider than this are truncated with an ellipsis (full name in the
// tooltip) so a single absurdly long job name cannot make the header huge.
const MAX_HEADER_LABEL_WIDTH = 360;
const HEADER_LABEL_LINE_HEIGHT = 16; // tallest label line box (12px semibold)

function headerHeightForLabelWidth(width: number): number {
  const clamped = Math.min(width, MAX_HEADER_LABEL_WIDTH);
  // A rotated box spans width*sin + height*cos vertically.
  const extent =
    clamped * HEADER_LABEL_SIN + HEADER_LABEL_LINE_HEIGHT * HEADER_LABEL_COS;
  return Math.max(
    MIN_HEADER_HEIGHT,
    Math.ceil(extent) + HEADER_LABEL_BOTTOM + 8,
  );
}

// Horizontal room the rotated labels need past the last column's right edge.
function headerSpacerForLabelWidth(width: number): number {
  const clamped = Math.min(width, MAX_HEADER_LABEL_WIDTH);
  return Math.max(
    0,
    Math.ceil(clamped * HEADER_LABEL_COS) - HEADER_COLUMN_WIDTH / 2,
  );
}

// Text widths are measured with a canvas so the header height can be derived
// during render, without a measure-then-set-state pass. Builds arrive
// client-side, so the server never renders header columns and the SSR
// fallback below is only defensive.
const GROUP_LABEL_FONT_SIZE = 12; // text-[12px] font-semibold
const JOB_LABEL_FONT_SIZE = 10; // text-[10px]
const JOB_ICON_WIDTH = 14 + 4; // h-3.5 w-3.5 icon plus mr-1
const LABEL_MEASURE_SLACK = 1.05; // font swap / subpixel rounding
let measureCtx: CanvasRenderingContext2D | null | undefined;
let measureFontFamily: string | undefined;

function measureText(text: string, size: number, weight: number): number {
  if (typeof document === "undefined") return text.length * size * 0.55;
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
    measureFontFamily = getComputedStyle(document.body).fontFamily || "sans-serif";
  }
  if (!measureCtx) return text.length * size * 0.55;
  measureCtx.font = `${weight} ${size}px ${measureFontFamily}`;
  return measureCtx.measureText(text).width;
}

function groupLabelWidth(group: string): number {
  return measureText(`\u25B8 ${group}`, GROUP_LABEL_FONT_SIZE, 600);
}

function jobLabelWidth(jobName: string): number {
  const segments = splitJobName(jobName);
  let width = 0;
  for (const segment of segments) {
    width +=
      segment.type === "icon"
        ? JOB_ICON_WIDTH
        : measureText(segment.text, JOB_LABEL_FONT_SIZE, 400);
  }
  return width;
}

const fetcher = (url: string) => fetch(url).then((response) => response.json());

export function BuildsTable({
  builds,
  jobNames,
  jobsByBuild,
  startedJobCountsByBuild,
  showBranch,
  hideSoftFail,
  hideOptional,
  selectedGroups,
  selectedJobs,
  groupsLoading,
}: BuildsTableProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedBuildId, setExpandedBuildId] = useState<string | null>(null);
  const [hoveredCol, setHoveredCol] = useState<string | null>(null);
  const hasInProgress = useMemo(
    () => builds.some((build) => isBuildInProgress(build.state)),
    [builds],
  );
  const now = useNow(hasInProgress ? 30_000 : null);
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
  const showSkeleton = !hasGroups && Boolean(groupsLoading) && builds.length > 0;
  const skeletonCount = showSkeleton ? SKELETON_GROUP_COLUMNS : 0;
  const FIXED_COLS = showBranch ? 8 : 7;

  // Size the header row for the widest rotated label so long group and job
  // names are not clipped at the top of the table.
  let maxLabelWidth = 0;
  for (const col of columns) {
    const width =
      col.type === "job" ? jobLabelWidth(col.jobName!) : groupLabelWidth(col.group);
    maxLabelWidth = Math.max(maxLabelWidth, width);
  }
  maxLabelWidth = Math.ceil(maxLabelWidth * LABEL_MEASURE_SLACK);

  const headerHeight = headerHeightForLabelWidth(maxLabelWidth);
  const headerSpacer = hasGroups ? headerSpacerForLabelWidth(maxLabelWidth) : 0;
  const spacerCols = headerSpacer > 0 ? 1 : 0;

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
              <th className="sticky left-0 z-10 bg-white px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">Build</th>
              <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">Commit</th>
              {showBranch && <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">Branch</th>}
              <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">PR</th>
              <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">Author</th>
              <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">Status</th>
              <th className="px-4 pb-2 text-left align-bottom font-semibold text-zinc-500 dark:text-zinc-400">Duration</th>
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
                  const isHovered = hoveredCol === key;

                  return (
                    <th
                      key={key}
                      className="relative p-0 align-bottom"
                      style={{
                        width: HEADER_COLUMN_WIDTH,
                        minWidth: HEADER_COLUMN_WIDTH,
                        height: headerHeight,
                      }}
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
                        title={isGroup ? label : jobNameText(label)}
                        className={`absolute bottom-2 left-1/2 origin-bottom-left overflow-hidden text-ellipsis whitespace-nowrap ${
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
                          maxWidth: MAX_HEADER_LABEL_WIDTH,
                        }}
                        onClick={isGroup ? () => toggleGroup(col.group) : undefined}
                      >
                        {isGroup && (
                          <span className="mr-0.5 inline-block text-[10px]">
                            {isExpanded ? "▾" : "▸"}
                          </span>
                        )}
                        {isGroup ? label : <JobName name={label} />}
                      </div>
                    </th>
                  );
                })}
              {spacerCols > 0 && (
                <th
                  aria-hidden
                  className="p-0"
                  style={{ width: headerSpacer, minWidth: headerSpacer }}
                />
              )}
              {showSkeleton &&
                Array.from({ length: skeletonCount }, (_, i) => (
                  <th
                    key={`skeleton-group-${i}`}
                    className="relative p-0 align-bottom"
                    style={{
                      width: HEADER_COLUMN_WIDTH,
                      minWidth: HEADER_COLUMN_WIDTH,
                      height: MIN_HEADER_HEIGHT,
                    }}
                  >
                    <div className="absolute bottom-2 left-1/2 h-16 w-2 -translate-x-1/2 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  </th>
                ))}
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
              const duration = buildDurationDisplay(build, now);
              const startedJobCount = startedJobCountsByBuild[build.id];

              return (
                <Fragment key={build.id}>
                  <tr
                    className={`group border-b border-zinc-100 transition-colors dark:border-zinc-800/50 ${
                      isTraceExpanded ? "bg-zinc-50 dark:bg-zinc-900/30" : ""
                    } ${isTraceExpanded ? "" : "hover:bg-blue-50 dark:hover:bg-blue-950/40"}`}
                  >
                    <td
                      className={`sticky left-0 z-10 whitespace-nowrap px-4 py-2 ${
                        isTraceExpanded
                          ? "bg-zinc-50 dark:bg-zinc-900"
                          : "bg-white group-hover:bg-blue-50 dark:bg-zinc-950 dark:group-hover:bg-blue-950"
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
                                : "border-zinc-300 bg-white text-zinc-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-blue-800 dark:hover:bg-blue-950/50 dark:hover:text-blue-300"
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
                            className="inline-flex min-h-8 items-center rounded-md border border-zinc-200 px-2.5 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-600"
                            title="Timeline unavailable"
                          >
                            No timeline
                          </span>
                        )}
                        <span className="text-zinc-500 dark:text-zinc-400">
                          {build.created_at ? formatTime(build.created_at) : "—"}
                        </span>
                        {build.web_url && build.build_number ? (
                          <a
                            href={build.web_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open Buildkite build ${build.build_number}`}
                            className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline dark:text-blue-400"
                          >
                            Buildkite #{build.build_number}
                            <span aria-hidden="true">↗</span>
                          </a>
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
                  <td className="whitespace-nowrap px-4 py-2 text-xs tabular-nums">
                    <span
                      className={durationColor(duration.kind)}
                      title={duration.title}
                    >
                      {duration.label}
                    </span>
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
                                <span className="text-zinc-500 dark:text-zinc-400">
                                  {` · ${groupStatus.passed} passed, ${groupStatus.failed} failed, ${groupStatus.running} running, ${groupStatus.blocked} blocked`}
                                </span>
                              </p>
                              {failedJobLinks.length > 0 && (
                                <ul className="mt-1 text-red-600 dark:text-red-400">
                                  {failedJobLinks.slice(0, 5).map((job) => (
                                    <li key={job.name}>✕ <JobName name={job.name} /></li>
                                  ))}
                                  {failedJobLinks.length > 5 && (
                                    <li className="text-zinc-500 dark:text-zinc-400">
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
                            <p className="text-zinc-500 dark:text-zinc-400">{col.group}</p>
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
                    {showSkeleton &&
                      Array.from({ length: skeletonCount }, (_, i) => (
                        <td key={`skeleton-group-${i}`} className="px-0 py-2 text-center">
                          <div className="inline-flex h-5 w-5 items-center justify-center">
                            <span className="block h-3.5 w-3.5 animate-pulse rounded-sm bg-zinc-200 dark:bg-zinc-800" />
                          </div>
                        </td>
                      ))}
                  </tr>
                  {isTraceExpanded && canShowTrace && (
                    <tr id={`build-trace-${build.id}`}>
                      <td
                        colSpan={FIXED_COLS + columns.length + skeletonCount + spacerCols}
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
                  colSpan={FIXED_COLS + columns.length + skeletonCount + spacerCols}
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
