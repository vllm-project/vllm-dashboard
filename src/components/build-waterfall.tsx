"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { JobName, jobNameText } from "@/components/job-name";
import { buildTestTree, type TestTreeNode } from "@/lib/test-tree";

type LaneKind = "job" | "step" | "command" | "test";
/** Lanes from the API plus the client-side pytest grouping rows. */
type RowKind = LaneKind | "test-file" | "test-case";

interface WaterfallLane {
  id: string;
  parentId: string | null;
  kind: RowKind;
  label: string;
  group: string | null;
  stepKey: string | null;
  jobId: string | null;
  queue: string | null;
  startTime: string;
  endTime: string;
  durationMs: number;
  waitMs: number;
  status: "passed" | "failed" | "skipped" | "unknown";
  outcome: string | null;
  url: string | null;
  critical: boolean;
  childCount: number;
  /** Shorter label for tree rows: the part not shown by enclosing groups. */
  displayLabel?: string;
  /** Total tests under a grouping row. */
  testCount?: number;
  failedCount?: number;
}

interface VisibleRow {
  lane: WaterfallLane;
  depth: number;
}

interface TraceResponse {
  available: boolean;
  complete: boolean;
  truncated: boolean;
  nextPage: number | null;
  lanes: WaterfallLane[];
  summary: {
    observedStart: string;
    observedEnd: string;
    observedDurationMs: number;
    spanCount: number;
    laneCount: number;
    commandCount: number;
    testCount: number;
    traceCount: number;
    queueCount: number;
    criticalCount: number;
    latestReceivedAt: string;
  } | null;
  error?: string;
}

interface BuildWaterfallProps {
  organization: string;
  pipeline: string;
  buildNumber: string;
  buildUrl: string;
  startedJobCount?: number;
}

const INITIAL_JOB_LIMIT = 36;
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const INDENT_PX = 18;
const ROW_GRID = "grid-cols-[minmax(22rem,34rem)_minmax(28rem,1fr)]";

async function fetchTrace(url: string): Promise<TraceResponse> {
  const response = await fetch(url);
  const body = (await response.json()) as TraceResponse;
  if (!response.ok) throw new Error(body.error ?? "Failed to load trace");
  return body;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const seconds = ms / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const totalSeconds = Math.round(ms / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function GridLines() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {TICKS.map((tick) => (
        <span
          key={tick}
          className="absolute inset-y-0 w-px bg-zinc-200/70 dark:bg-zinc-800"
          style={{ left: `${tick * 100}%` }}
        />
      ))}
    </div>
  );
}

function isJobLane(lane: WaterfallLane): boolean {
  return lane.kind === "job" || lane.kind === "step";
}

function isTestGroup(lane: WaterfallLane): boolean {
  return lane.kind === "test-file" || lane.kind === "test-case";
}

/** Pytest node IDs contain `::`, which JobName would misread as shortcodes. */
function laneText(lane: WaterfallLane): string {
  return isJobLane(lane) ? jobNameText(lane.label) : lane.label;
}

function laneColor(lane: WaterfallLane): string {
  if (lane.critical) {
    return "border border-amber-500 bg-amber-300 shadow-[0_0_0_1px_rgb(245_158_11_/_0.12)] dark:bg-amber-500";
  }
  if (isTestGroup(lane)) {
    // Grouping rows span their children; keep them visually lighter than
    // the leaf tests so a file row does not read as one giant test.
    if (lane.status === "failed") return "border border-red-500/70 bg-red-500/25 dark:bg-red-500/30";
    if (lane.status === "skipped") return "border border-zinc-400/70 bg-zinc-300/50 dark:bg-zinc-600/50";
    return "border border-emerald-500/70 bg-emerald-500/25 dark:bg-emerald-500/30";
  }
  if (lane.status === "failed") return "bg-red-500 dark:bg-red-500";
  if (lane.status === "skipped") return "bg-zinc-300 dark:bg-zinc-600";
  if (lane.kind === "test") return "bg-emerald-500 dark:bg-emerald-500";
  if (lane.kind === "command") return "bg-cyan-500 dark:bg-cyan-500";
  return "bg-blue-500 dark:bg-blue-500";
}

/**
 * Turn a pytest command's flat test lanes into file → function → parameter
 * rows. Returns the direct children of the command and registers every
 * deeper level in `children`.
 */
function attachTestTree(
  commandId: string,
  tests: WaterfallLane[],
  children: Map<string, WaterfallLane[]>,
): WaterfallLane[] {
  const template = tests[0];
  const materialize = (nodes: TestTreeNode<WaterfallLane>[], parentId: string): WaterfallLane[] =>
    nodes.map((node) => {
      if (node.type === "leaf") {
        return { ...node.lane, parentId, displayLabel: node.displayLabel };
      }
      const row: WaterfallLane = {
        ...template,
        id: node.id,
        parentId,
        kind: node.kind,
        label: node.label,
        startTime: node.startTime,
        endTime: node.endTime,
        durationMs: node.durationMs,
        waitMs: 0,
        status: node.status,
        outcome: null,
        url: null,
        critical: false,
        childCount: node.children.length,
        displayLabel: node.label,
        testCount: node.testCount,
        failedCount: node.failedCount,
      };
      children.set(node.id, materialize(node.children, node.id));
      return row;
    });
  return materialize(buildTestTree(commandId, tests), commandId);
}

export function BuildWaterfall({
  organization,
  pipeline,
  buildNumber,
  buildUrl,
  startedJobCount,
}: BuildWaterfallProps) {
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Explicit open/closed choices; rows absent here fall back to their default.
  const [openOverrides, setOpenOverrides] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const [jobDetails, setJobDetails] = useState<Record<string, WaterfallLane[]>>(
    {},
  );
  const [loadingJobs, setLoadingJobs] = useState<Set<string>>(() => new Set());
  const [detailErrors, setDetailErrors] = useState<Set<string>>(() => new Set());
  const params = new URLSearchParams({ organization, pipeline, buildNumber });
  const { data, error, isLoading, isValidating, mutate } = useSWR<TraceResponse>(
    `/api/builds/trace?${params.toString()}`,
    fetchTrace,
    {
      keepPreviousData: true,
      refreshInterval: (latest) => (latest?.complete ? 0 : 10_000),
    },
  );

  const { jobLanes, childrenByParent, defaultOpen } = useMemo(() => {
    const detailedJobIds = new Set(Object.keys(jobDetails));
    const lanes = [
      ...(data?.lanes ?? []).filter(
        (lane) =>
          !lane.jobId ||
          !detailedJobIds.has(lane.jobId) ||
          lane.kind === "job" ||
          lane.kind === "step",
      ),
      ...Object.values(jobDetails).flat(),
    ];
    const roots = lanes
      .filter((lane) => lane.kind === "job" || lane.kind === "step")
      .sort((a, b) => {
        const start = Date.parse(a.startTime) - Date.parse(b.startTime);
        return start !== 0 ? start : b.durationMs - a.durationMs;
      });
    const children = new Map<string, WaterfallLane[]>();
    for (const lane of lanes) {
      if (!lane.parentId || lane.kind === "job" || lane.kind === "step") continue;
      const siblings = children.get(lane.parentId) ?? [];
      siblings.push(lane);
      children.set(lane.parentId, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((a, b) => {
        const index = a.kind === "command" && b.kind === "command"
          ? Number(a.label.split(".", 1)[0]) - Number(b.label.split(".", 1)[0])
          : 0;
        if (Number.isFinite(index) && index !== 0) return index;
        return Date.parse(a.startTime) - Date.parse(b.startTime);
      });
    }
    // A shard with one test file gains nothing from a collapsed file row, so
    // that row starts open and the viewer lands directly on the functions.
    const defaultOpen = new Set<string>();
    // Snapshot the entries: attaching a tree adds group rows to the map, and
    // iterating those would regroup the leaves again without end.
    for (const [parentId, siblings] of [...children]) {
      if (!siblings.some((lane) => lane.kind === "test")) continue;
      const tests = siblings.filter((lane) => lane.kind === "test");
      const others = siblings.filter((lane) => lane.kind !== "test");
      const grouped = attachTestTree(parentId, tests, children);
      children.set(parentId, [...others, ...grouped]);
      const files = grouped.filter((lane) => lane.kind === "test-file");
      if (files.length === 1 && others.length === 0) defaultOpen.add(files[0].id);
    }
    return { jobLanes: roots, childrenByParent: children, defaultOpen };
  }, [data?.lanes, jobDetails]);

  const isOpen = (id: string) => openOverrides.get(id) ?? defaultOpen.has(id);

  const visibleJobs = useMemo(() => {
    const filtered = criticalOnly
      ? jobLanes.filter((lane) => lane.critical)
      : jobLanes;
    if (showAll || filtered.length <= INITIAL_JOB_LIMIT) return filtered;
    const initiallyVisible = new Set(
      filtered.slice(0, INITIAL_JOB_LIMIT).map((lane) => lane.id),
    );
    for (const lane of filtered) {
      if (lane.critical) initiallyVisible.add(lane.id);
    }
    return filtered.filter((lane) => initiallyVisible.has(lane.id));
  }, [criticalOnly, jobLanes, showAll]);

  const visibleRows = useMemo(() => {
    const flattened: VisibleRow[] = [];
    const walk = (lane: WaterfallLane, depth: number) => {
      flattened.push({ lane, depth });
      if (!(openOverrides.get(lane.id) ?? defaultOpen.has(lane.id))) return;
      for (const child of childrenByParent.get(lane.id) ?? []) walk(child, depth + 1);
    };
    for (const job of visibleJobs) walk(job, 0);
    return flattened;
  }, [childrenByParent, defaultOpen, openOverrides, visibleJobs]);

  async function loadJobDetails(jobId: string, jobParentId: string | null) {
    if (jobDetails[jobId] || loadingJobs.has(jobId)) return;

    setLoadingJobs((current) => new Set(current).add(jobId));
    setDetailErrors((current) => {
      const next = new Set(current);
      next.delete(jobId);
      return next;
    });

    try {
      const lanes = new Map<string, WaterfallLane>();
      let page: number | null = 0;
      while (page !== null) {
        const detailParams = new URLSearchParams({
          organization,
          pipeline,
          buildNumber,
          jobId,
          page: String(page),
        });
        const response = await fetchTrace(
          `/api/builds/trace?${detailParams.toString()}`,
        );
        for (const lane of response.lanes) {
          if (lane.kind === "command" || lane.kind === "test") {
            lanes.set(
              lane.id,
              lane.kind === "command" && jobParentId
                ? { ...lane, parentId: jobParentId }
                : lane,
            );
          }
        }
        page = response.nextPage;
      }
      setJobDetails((current) => ({
        ...current,
        [jobId]: [...lanes.values()],
      }));
    } catch {
      setDetailErrors((current) => new Set(current).add(jobId));
    } finally {
      setLoadingJobs((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
    }
  }

  function toggleExpanded(lane: WaterfallLane) {
    if (lane.kind === "command" && lane.jobId && lane.childCount > 0) {
      void loadJobDetails(lane.jobId, lane.parentId);
    }
    const open = isOpen(lane.id);
    setOpenOverrides((current) => new Map(current).set(lane.id, !open));
  }

  function toggleAllJobs() {
    const expandableJobs = jobLanes
      .filter((lane) => (childrenByParent.get(lane.id)?.length ?? 0) > 0)
      .map((lane) => lane.id);
    const allExpanded = expandableJobs.every((id) => isOpen(id));
    setOpenOverrides((current) => {
      const next = new Map(current);
      for (const id of expandableJobs) next.set(id, !allExpanded);
      return next;
    });
  }

  if (isLoading && !data) {
    return (
      <div className="flex min-h-40 items-center justify-center border-t border-zinc-200 bg-zinc-50/70 px-6 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-400">
        Loading trace spans…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 border-t border-zinc-200 bg-zinc-50/70 px-6 text-center dark:border-zinc-800 dark:bg-zinc-900/30">
        <p className="text-sm font-medium text-red-600 dark:text-red-400">
          Trace data could not be loaded.
        </p>
        <button
          type="button"
          onClick={() => mutate()}
          className="dashboard-control min-h-10 rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data?.available || !data.summary || jobLanes.length === 0) {
    return (
      <div className="border-t border-zinc-200 bg-zinc-50/70 px-6 py-8 dark:border-zinc-800 dark:bg-zinc-900/30">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          No trace spans for this build
        </p>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          Older builds predate OTel collection. Active builds populate here as
          spans finish; the current build roster still comes from Databricks.
        </p>
      </div>
    );
  }

  const { summary } = data;
  const timelineStart = Date.parse(summary.observedStart);
  const timelineEnd = Date.parse(summary.observedEnd);
  const timelineDuration = Math.max(1, timelineEnd - timelineStart);
  const hiddenCount = Math.max(0, jobLanes.length - visibleJobs.length);
  const hasCoverage = typeof startedJobCount === "number" && startedJobCount > 0;
  const coverageTotal = hasCoverage
    ? Math.max(startedJobCount, summary.laneCount)
    : null;
  const isPartial =
    data.complete && coverageTotal !== null && summary.laneCount < coverageTotal;
  const traceState = !data.complete ? "Live" : isPartial ? "Partial" : "Complete";
  const traceStateColor = !data.complete
    ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
    : isPartial
      ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
      : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";
  const expandableJobs = jobLanes.filter(
    (lane) => (childrenByParent.get(lane.id)?.length ?? 0) > 0,
  );
  const allJobsExpanded =
    expandableJobs.length > 0 && expandableJobs.every((lane) => isOpen(lane.id));

  return (
    <section
      aria-label={`Build ${buildNumber} waterfall`}
      className="sticky left-0 w-[calc(100vw-2rem)] max-w-[1376px] border-t border-zinc-200 bg-zinc-50/80 sm:w-[calc(100vw-3rem)] lg:w-[calc(100vw-4rem)] dark:border-zinc-800 dark:bg-zinc-900/35"
    >
      <div className="flex flex-col gap-4 border-b border-zinc-200 px-5 py-4 lg:flex-row lg:items-start lg:justify-between dark:border-zinc-800">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Build #{buildNumber} timeline
            </h4>
            <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] ${traceStateColor}`}>
              {traceState}
            </span>
            {isValidating && <span className="text-[11px] text-zinc-400">Checking…</span>}
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            Select a traced job to see its commands, and a pytest command to see
            its test files, functions and parameter combinations. Amber jobs are
            the inferred critical path: the chain of work that set the build&apos;s
            duration.
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 lg:items-end">
          <a
            href={buildUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="dashboard-control inline-flex min-h-9 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-blue-600 hover:border-blue-300 hover:bg-blue-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-blue-400 dark:hover:border-blue-800 dark:hover:bg-blue-950/50"
          >
            Open Buildkite #{buildNumber}<span aria-hidden="true">↗</span>
          </a>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span><strong className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">{formatDuration(summary.observedDurationMs)}</strong> observed</span>
            <span><strong className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">{summary.laneCount}{coverageTotal !== null ? ` of ${coverageTotal}` : ""}</strong> jobs traced</span>
            {summary.commandCount > 0 && <span><strong className="font-mono font-semibold text-cyan-700 dark:text-cyan-300">{summary.commandCount}</strong> commands</span>}
            {summary.testCount > 0 && <span><strong className="font-mono font-semibold text-emerald-700 dark:text-emerald-300">{summary.testCount}</strong> tests</span>}
            <span><strong className="font-mono font-semibold text-amber-700 dark:text-amber-300">{summary.criticalCount}</strong> build-limiting</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <div className="flex flex-wrap items-center gap-4 text-[11px] text-zinc-500 dark:text-zinc-400">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-blue-500" /> job</span>
          {summary.commandCount > 0 && <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-cyan-500" /> command</span>}
          {summary.testCount > 0 && <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-emerald-500" /> test</span>}
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-red-500" /> failed</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-zinc-300 dark:bg-zinc-700" /> queued / skipped</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {expandableJobs.length > 0 && (
            <button type="button" onClick={toggleAllJobs} className="dashboard-control min-h-9 rounded-md border border-cyan-300 bg-cyan-50 px-3 text-xs font-medium text-cyan-800 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200 dark:hover:bg-cyan-950/70">
              {allJobsExpanded ? "Collapse commands" : `Show commands (${summary.commandCount})`}
            </button>
          )}
          <button
            type="button"
            aria-pressed={criticalOnly}
            onClick={() => setCriticalOnly((value) => !value)}
            className={`dashboard-control min-h-9 rounded-md border px-3 text-xs font-medium ${criticalOnly ? "border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-600 dark:bg-amber-950/60 dark:text-amber-200" : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"}`}
          >
            {criticalOnly ? "Show all jobs" : "Show build-limiting jobs"}
          </button>
          {!criticalOnly && jobLanes.length > INITIAL_JOB_LIMIT && (
            <button type="button" onClick={() => setShowAll((value) => !value)} className="dashboard-control min-h-9 rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900">
              {showAll ? "Show less" : `Show all ${jobLanes.length} jobs`}
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto pb-2">
        <div className="min-w-[760px] px-5">
          <div className={`grid ${ROW_GRID} gap-4 border-b border-zinc-200 pb-2 dark:border-zinc-800`}>
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Job / command / test</div>
            <div className="relative h-5 font-mono text-[10px] text-zinc-400">
              {TICKS.map((tick) => (
                <span key={tick} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${tick * 100}%` }}>
                  {formatDuration(timelineDuration * tick)}
                </span>
              ))}
            </div>
          </div>

          <div>
            {visibleRows.map(({ lane, depth }) => {
              const start = Date.parse(lane.startTime);
              const end = Date.parse(lane.endTime);
              const queueStart = Math.max(timelineStart, start - lane.waitMs);
              const queueLeft = clampPercent(((queueStart - timelineStart) / timelineDuration) * 100);
              const queueWidth = clampPercent(((start - queueStart) / timelineDuration) * 100);
              const runLeft = clampPercent(((start - timelineStart) / timelineDuration) * 100);
              const runWidth = clampPercent(((end - start) / timelineDuration) * 100);
              const children = childrenByParent.get(lane.id) ?? [];
              const displayedChildCount = lane.kind === "command"
                ? Math.max(lane.childCount, children.length)
                : children.length;
              const isExpandable = displayedChildCount > 0;
              const open = isOpen(lane.id);
              const isLoadingDetails = Boolean(
                lane.kind === "command" &&
                lane.jobId &&
                loadingJobs.has(lane.jobId),
              );
              const hasDetailError = Boolean(
                lane.kind === "command" &&
                lane.jobId &&
                detailErrors.has(lane.jobId),
              );
              const text = laneText(lane);
              const detail = `${text} · ${formatTime(lane.startTime)}–${formatTime(lane.endTime)} · ${formatDuration(lane.durationMs)}${lane.outcome ? ` · ${lane.outcome}` : ""}${lane.testCount ? ` · ${lane.testCount} tests${lane.failedCount ? `, ${lane.failedCount} failed` : ""}` : ""}`;
              const rowTone = depth === 0 ? "" : depth === 1 ? "bg-cyan-50/35 dark:bg-cyan-950/10" : "bg-emerald-50/30 dark:bg-emerald-950/10";
              const isGroup = isTestGroup(lane);
              const countBadge = isGroup
                ? `${lane.testCount ?? displayedChildCount} ${lane.testCount === 1 ? "test" : "tests"}`
                : String(displayedChildCount);

              return (
                <div key={lane.id} className={`grid min-h-10 ${ROW_GRID} items-center gap-4 border-b border-zinc-200/70 last:border-0 dark:border-zinc-800/70 ${rowTone}`}>
                  <div className="relative min-w-0 py-1.5" style={{ paddingLeft: `${depth * INDENT_PX}px` }}>
                    {depth > 0 && <span aria-hidden="true" className={`absolute inset-y-0 w-px ${depth === 1 ? "bg-cyan-200 dark:bg-cyan-900" : "bg-emerald-200 dark:bg-emerald-900"}`} style={{ left: `${(depth - 1) * INDENT_PX + 8}px` }} />}
                    <div className="flex items-center gap-1.5">
                      {isExpandable ? (
                        <button type="button" onClick={() => toggleExpanded(lane)} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${text}`} className="dashboard-control flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                          <span aria-hidden="true" className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
                        </button>
                      ) : <span className="w-6 shrink-0" />}
                      {lane.critical && <span aria-label="Inferred build-limiting job" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
                      <span
                        className={`truncate text-xs ${depth === 0 ? "font-medium text-zinc-800 dark:text-zinc-200" : isGroup ? "font-mono text-[11px] font-medium text-zinc-700 dark:text-zinc-300" : "font-mono text-[11px] text-zinc-800 dark:text-zinc-200"}`}
                        title={text}
                      >
                        {isJobLane(lane) ? <JobName name={lane.label} /> : (lane.displayLabel ?? lane.label)}
                      </span>
                      {isExpandable && <span className="shrink-0 rounded bg-zinc-200/70 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{countBadge}</span>}
                      {isGroup && (lane.failedCount ?? 0) > 0 && <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 font-mono text-[9px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">{lane.failedCount} failed</span>}
                      {isLoadingDetails && <span className="shrink-0 text-[9px] text-cyan-600 dark:text-cyan-400">loading tests…</span>}
                      {hasDetailError && <span className="shrink-0 text-[9px] text-red-600 dark:text-red-400">test trace load failed; select again to retry</span>}
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-400">{formatDuration(lane.durationMs)}</span>
                    </div>
                    {depth === 0 && (
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 pl-7 font-mono text-[10px] text-zinc-400">
                        <span className="truncate">{lane.queue ?? lane.group ?? lane.kind}</span>
                        {lane.waitMs > 0 && <span className="shrink-0">+{formatDuration(lane.waitMs)} wait</span>}
                      </div>
                    )}
                  </div>
                  <div className="relative h-7">
                    <GridLines />
                    {queueWidth > 0.08 && depth === 0 && (
                      <span aria-hidden="true" className="absolute top-2 h-3 rounded-l-sm bg-zinc-300 dark:bg-zinc-700" style={{ left: `${queueLeft}%`, width: `${Math.max(queueWidth, 0.2)}%`, backgroundImage: "repeating-linear-gradient(135deg, transparent, transparent 3px, rgb(255 255 255 / 0.35) 3px, rgb(255 255 255 / 0.35) 4px)" }} />
                    )}
                    {lane.url ? (
                      <a href={lane.url} target="_blank" rel="noopener noreferrer" aria-label={detail} title={detail} className={`absolute top-1.5 h-4 min-w-1 rounded-sm transition-[filter] hover:brightness-110 ${laneColor(lane)}`} style={{ left: `${runLeft}%`, width: `${Math.max(runWidth, 0.25)}%` }} />
                    ) : (
                      <span role="img" aria-label={detail} title={detail} className={`absolute top-1.5 h-4 min-w-1 rounded-sm ${laneColor(lane)}`} style={{ left: `${runLeft}%`, width: `${Math.max(runWidth, 0.25)}%` }} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {hiddenCount > 0 && !criticalOnly && (
            <button type="button" onClick={() => setShowAll(true)} className="dashboard-control my-2 min-h-10 w-full rounded-md text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200">
              Show {hiddenCount} more jobs
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 px-5 py-2.5 font-mono text-[10px] text-zinc-400 dark:border-zinc-800">
        <span>{formatTime(summary.observedStart)} → {formatTime(summary.observedEnd)}</span>
        <span>Last span received {formatTime(summary.latestReceivedAt)}{data.truncated ? " · first 5,000 spans" : ""}</span>
      </div>
    </section>
  );
}
