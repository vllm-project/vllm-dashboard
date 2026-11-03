"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import useSWR from "swr";
import { JobName, jobNameText } from "@/components/job-name";
import { buildTestTree, type TestTreeNode } from "@/lib/test-tree";
import { JobGpuTimeline, type GpuAxis } from "@/components/job-gpu-timeline";
import { formatDuration } from "@/lib/format-duration";
import { TimelineCursorLabel, TimelineCursorProvider, TimelineHoverArea } from "@/components/timeline-cursor";

type LaneKind = "job" | "step" | "command" | "test";
/** Lanes from the API plus the client-side step-group and pytest grouping rows. */
type RowKind = LaneKind | "group" | "test-file" | "test-case";

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
  gpuAvailable?: boolean;
  /** Shorter label for tree rows: the part not shown by enclosing groups. */
  displayLabel?: string;
  /** Total tests under a grouping row. */
  testCount?: number;
  failedCount?: number;
  /** A step-group row holding a build-limiting job. */
  containsCritical?: boolean;
}

interface StepGroupsResponse {
  byKey: Record<string, string>;
  byLabel: Record<string, string>;
  complete: boolean;
}

interface VisibleRow {
  lane: WaterfallLane;
  depth: number;
  /** Ids from the top-level job down to this lane, inclusive. */
  path: string[];
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
const INDENT_PX = 18;
const ROW_GRID = "grid-cols-[minmax(22rem,34rem)_minmax(28rem,1fr)]";
const GROUP_ID_PREFIX = "group:";
const MINUTE = 60_000;
// Round axis steps, from which the one giving roughly ten ticks is chosen.
const TICK_STEPS = [
  1_000, 5_000, 10_000, 30_000,
  MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 20 * MINUTE, 30 * MINUTE,
  60 * MINUTE, 120 * MINUTE, 240 * MINUTE,
];

async function fetchTrace(url: string): Promise<TraceResponse> {
  const response = await fetch(url);
  const body = (await response.json()) as TraceResponse;
  if (!response.ok) throw new Error(body.error ?? "Failed to load trace");
  return body;
}

async function fetchStepGroups(url: string): Promise<StepGroupsResponse> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to load step groups");
  return (await response.json()) as StepGroupsResponse;
}

/** Fractions of the axis at round elapsed-time steps, e.g. every 10m. */
function axisTicks(durationMs: number): { fraction: number; ms: number }[] {
  const step = TICK_STEPS.find((candidate) => durationMs / candidate <= 10) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks = [];
  for (let ms = 0; ms <= durationMs; ms += step) ticks.push({ fraction: ms / durationMs, ms });
  return ticks;
}

/** Axis ticks fall on round steps, so "10m" rather than formatDuration's "10m 0s". */
function formatTick(ms: number): string {
  if (ms < MINUTE) return `${Math.round(ms / 1_000)}s`;
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function groupLane(label: string, jobs: WaterfallLane[]): WaterfallLane {
  const start = Math.min(...jobs.map((job) => Date.parse(job.startTime)));
  const end = Math.max(...jobs.map((job) => Date.parse(job.endTime)));
  const status: WaterfallLane["status"] = jobs.some((job) => job.status === "failed")
    ? "failed"
    : jobs.every((job) => job.status === "skipped")
      ? "skipped"
      : jobs.every((job) => job.status === "passed" || job.status === "skipped")
        ? "passed"
        : "unknown";
  return {
    id: `${GROUP_ID_PREFIX}${label}`,
    parentId: null,
    kind: "group",
    label,
    group: label,
    stepKey: null,
    jobId: null,
    queue: null,
    startTime: new Date(start).toISOString(),
    endTime: new Date(end).toISOString(),
    durationMs: end - start,
    waitMs: 0,
    status,
    outcome: null,
    url: null,
    critical: false,
    childCount: jobs.length,
    containsCritical: jobs.some((job) => job.critical),
  };
}

/**
 * Keep a header row under the sticky nav while its container scrolls past.
 * CSS `position: sticky` cannot do this here: the builds table scrolls
 * horizontally, and that overflow container also captures vertical sticking.
 */
function usePinnedHeader(
  containerRef: RefObject<HTMLDivElement | null>,
  headerRef: RefObject<HTMLDivElement | null>,
  sectionRef: RefObject<HTMLElement | null>,
  ready: boolean,
) {
  useEffect(() => {
    const container = containerRef.current;
    const header = headerRef.current;
    const section = sectionRef.current;
    if (!container || !header || !section) return;

    // Match the visible width of the scroller the waterfall sits in, so the
    // panel spans the page however wide the builds table is.
    let scroller: HTMLElement | null = section.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowX)) {
      scroller = scroller.parentElement;
    }

    let frame = 0;
    const update = () => {
      frame = 0;
      if (scroller) section.style.width = `${scroller.clientWidth}px`;
      const navBottom = document.querySelector(".dashboard-nav")?.getBoundingClientRect().bottom ?? 0;
      const box = container.getBoundingClientRect();
      const offset = Math.max(0, Math.min(navBottom - box.top, box.height - header.offsetHeight));
      header.style.transform = offset > 0 ? `translateY(${offset}px)` : "";
      header.dataset.pinned = offset > 0 ? "true" : "false";
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    if (scroller) observer.observe(scroller);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [containerRef, headerRef, sectionRef, ready]);
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

function GridLines({ ticks }: { ticks: number[] }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {ticks.map((tick) => (
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

function isStepGroup(lane: WaterfallLane): boolean {
  return lane.kind === "group";
}

function isTestGroup(lane: WaterfallLane): boolean {
  return lane.kind === "test-file" || lane.kind === "test-case";
}

/** Pytest node IDs contain `::`, which JobName would misread as shortcodes. */
function laneText(lane: WaterfallLane): string {
  return isJobLane(lane) || isStepGroup(lane) ? jobNameText(lane.label) : lane.label;
}

function laneColor(lane: WaterfallLane): string {
  if (lane.critical) {
    return "border border-amber-500 bg-amber-300 shadow-[0_0_0_1px_rgb(245_158_11_/_0.12)] dark:bg-amber-500";
  }
  if (isStepGroup(lane)) {
    // A group bar spans its jobs; a tint keeps it from reading as one job.
    if (lane.status === "failed") return "border border-red-500/70 bg-red-500/20 dark:bg-red-500/25";
    return "border border-blue-500/60 bg-blue-500/15 dark:bg-blue-500/25";
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
  const [gpuLaneId, setGpuLaneId] = useState<string | null>(null);
  const [gpuAxis, setGpuAxis] = useState<GpuAxis>("selection");
  const [groupByStep, setGroupByStep] = useState(true);
  const sectionRef = useRef<HTMLElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const params = new URLSearchParams({ organization, pipeline, buildNumber });
  const { data, error, isLoading, isValidating, mutate } = useSWR<TraceResponse>(
    `/api/builds/trace?${params.toString()}`,
    fetchTrace,
    {
      keepPreviousData: true,
      refreshInterval: (latest) => (latest?.complete ? 0 : 10_000),
    },
  );
  // Until bootstrap uploads the generated pipeline there is nothing to group by.
  const { data: stepGroups } = useSWR<StepGroupsResponse>(
    `/api/builds/step-groups?${params.toString()}`,
    fetchStepGroups,
    { refreshInterval: (latest) => (latest?.complete ? 0 : 30_000) },
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

  // Step groups start open, like Buildkite's waterfall.
  const isOpen = (id: string) =>
    openOverrides.get(id) ?? (defaultOpen.has(id) || id.startsWith(GROUP_ID_PREFIX));

  const jobGroupLabel = useMemo(() => {
    const byKey = stepGroups?.byKey ?? {};
    const byLabel = stepGroups?.byLabel ?? {};
    return (lane: WaterfallLane): string | null =>
      lane.group ?? (lane.stepKey ? byKey[lane.stepKey] : undefined) ?? byLabel[lane.label] ?? null;
  }, [stepGroups]);
  const hasStepGroups = useMemo(
    () => jobLanes.some((lane) => jobGroupLabel(lane) !== null),
    [jobGroupLabel, jobLanes],
  );
  const grouped = groupByStep && hasStepGroups;

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

  // Ungrouped jobs (bootstrap) sit between the groups in start order.
  const { topLanes, groupMembers } = useMemo(() => {
    const groupMembers = new Map<string, WaterfallLane[]>();
    if (!grouped) return { topLanes: visibleJobs, groupMembers };
    const members = new Map<string, WaterfallLane[]>();
    const top: WaterfallLane[] = [];
    for (const job of visibleJobs) {
      const label = jobGroupLabel(job);
      if (label === null) {
        top.push(job);
        continue;
      }
      const jobs = members.get(label) ?? [];
      jobs.push(job);
      members.set(label, jobs);
    }
    for (const [label, jobs] of members) {
      const row = groupLane(label, jobs);
      groupMembers.set(row.id, jobs);
      top.push(row);
    }
    top.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || b.durationMs - a.durationMs);
    return { topLanes: top, groupMembers };
  }, [grouped, jobGroupLabel, visibleJobs]);

  const visibleRows = useMemo(() => {
    const flattened: VisibleRow[] = [];
    const walk = (lane: WaterfallLane, depth: number, ancestors: string[]) => {
      const path = [...ancestors, lane.id];
      flattened.push({ lane, depth, path });
      const open = openOverrides.get(lane.id) ??
        (defaultOpen.has(lane.id) || lane.id.startsWith(GROUP_ID_PREFIX));
      if (!open) return;
      for (const child of groupMembers.get(lane.id) ?? childrenByParent.get(lane.id) ?? []) {
        walk(child, depth + 1, path);
      }
    };
    for (const lane of topLanes) walk(lane, 0, []);
    return flattened;
  }, [childrenByParent, defaultOpen, groupMembers, openOverrides, topLanes]);
  const gpuLane = useMemo(
    () => (gpuLaneId === null ? null : visibleRows.find((row) => row.lane.id === gpuLaneId)?.lane ?? null),
    [gpuLaneId, visibleRows],
  );

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
      // Commands inside a collapsed group would stay hidden.
      if (!allExpanded) for (const id of groupMembers.keys()) next.set(id, true);
      return next;
    });
  }

  usePinnedHeader(timelineRef, axisRef, sectionRef, Boolean(data?.summary && jobLanes.length > 0));

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
  const ticks = axisTicks(timelineDuration);
  const tickFractions = ticks.map((tick) => tick.fraction);
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
    <TimelineCursorProvider>
    <section
      ref={sectionRef}
      aria-label={`Build ${buildNumber} waterfall`}
      className="sticky left-0 w-[calc(100vw-2rem)] border-t border-zinc-200 bg-zinc-50/80 sm:w-[calc(100vw-3rem)] lg:w-[calc(100vw-4rem)] dark:border-zinc-800 dark:bg-zinc-900/35"
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
          {hasStepGroups && (
            <button
              type="button"
              aria-pressed={groupByStep}
              onClick={() => setGroupByStep((value) => !value)}
              className={`dashboard-control min-h-9 rounded-md border px-3 text-xs font-medium ${groupByStep ? "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200" : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"}`}
            >
              {groupByStep ? "Grouped by step group" : "Group by step group"}
            </button>
          )}
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
        <div ref={timelineRef} className="min-w-[760px] px-5">
          <div
            ref={axisRef}
            className={`relative z-30 -mx-5 grid ${ROW_GRID} items-center gap-4 border-b border-zinc-200 bg-zinc-50 px-5 py-1.5 will-change-transform data-[pinned=true]:shadow-[0_6px_12px_-10px_rgb(0_0_0_/_0.35)] dark:border-zinc-800 dark:bg-zinc-900`}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
              {grouped ? "Group / job / command / test" : "Job / command / test"}
            </div>
            <TimelineHoverArea start={timelineStart} end={timelineEnd} className="h-6 font-mono text-[10px] text-zinc-400">
              {ticks.map((tick, index) => (
                <span
                  key={tick.ms}
                  className={`absolute top-1/2 -translate-y-1/2 whitespace-nowrap ${index === 0 ? "" : "-translate-x-1/2"}`}
                  style={{ left: `${tick.fraction * 100}%` }}
                >
                  {formatTick(tick.ms)}
                </span>
              ))}
              <TimelineCursorLabel start={timelineStart} end={timelineEnd} format={formatDuration} />
            </TimelineHoverArea>
          </div>

          <div>
            {visibleRows.map(({ lane, depth, path }, index) => {
              const start = Date.parse(lane.startTime);
              const end = Date.parse(lane.endTime);
              const queueStart = Math.max(timelineStart, start - lane.waitMs);
              const queueLeft = clampPercent(((queueStart - timelineStart) / timelineDuration) * 100);
              const queueWidth = clampPercent(((start - queueStart) / timelineDuration) * 100);
              const runLeft = clampPercent(((start - timelineStart) / timelineDuration) * 100);
              const runWidth = clampPercent(((end - start) / timelineDuration) * 100);
              const children = groupMembers.get(lane.id) ?? childrenByParent.get(lane.id) ?? [];
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
              const isJob = isJobLane(lane);
              const isStep = isStepGroup(lane);
              const rowTone = isStep
                ? "bg-zinc-100/80 dark:bg-zinc-800/40"
                : isJob
                  ? ""
                  : lane.kind === "command"
                    ? "bg-cyan-50/35 dark:bg-cyan-950/10"
                    : "bg-emerald-50/30 dark:bg-emerald-950/10";
              const guideTone = isJob
                ? "bg-zinc-300 dark:bg-zinc-700"
                : lane.kind === "command"
                  ? "bg-cyan-200 dark:bg-cyan-900"
                  : "bg-emerald-200 dark:bg-emerald-900";
              const isGroup = isTestGroup(lane);
              const countBadge = isGroup
                ? `${lane.testCount ?? displayedChildCount} ${lane.testCount === 1 ? "test" : "tests"}`
                : isStep
                  ? `${displayedChildCount} ${displayedChildCount === 1 ? "job" : "jobs"}`
                  : String(displayedChildCount);

              // The GPU panel follows the selected lane's whole visible subtree, so
              // a job's commands stay directly under the job row.
              const inGpuSubtree = gpuLaneId !== null && path.includes(gpuLaneId);
              const nextInGpuSubtree = gpuLaneId !== null && (visibleRows[index + 1]?.path.includes(gpuLaneId) ?? false);
              const showGpuPanel = inGpuSubtree && !nextInGpuSubtree && gpuLane?.jobId;

              return (
                <Fragment key={lane.id}>
                <div className={`grid min-h-10 ${ROW_GRID} items-center gap-4 border-b border-zinc-200/70 last:border-0 dark:border-zinc-800/70 ${rowTone} ${gpuLaneId === lane.id ? "bg-cyan-50/60 dark:bg-cyan-950/20" : ""}`}>
                  <div className="relative min-w-0 py-1.5" style={{ paddingLeft: `${depth * INDENT_PX}px` }}>
                    {depth > 0 && <span aria-hidden="true" className={`absolute inset-y-0 w-px ${guideTone}`} style={{ left: `${(depth - 1) * INDENT_PX + 8}px` }} />}
                    <div className="flex items-center gap-1.5">
                      {isExpandable ? (
                        <button type="button" onClick={() => toggleExpanded(lane)} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${text}`} className="dashboard-control flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                          <span aria-hidden="true" className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
                        </button>
                      ) : <span className="w-6 shrink-0" />}
                      {lane.critical && <span aria-label="Inferred build-limiting job" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
                      {lane.containsCritical && <span aria-label="Holds a build-limiting job" className="h-1.5 w-1.5 shrink-0 rounded-full border border-amber-500" />}
                      <span
                        className={`truncate text-xs ${isStep ? "font-semibold text-zinc-900 dark:text-zinc-100" : isJob ? "font-medium text-zinc-800 dark:text-zinc-200" : isGroup ? "font-mono text-[11px] font-medium text-zinc-700 dark:text-zinc-300" : "font-mono text-[11px] text-zinc-800 dark:text-zinc-200"}`}
                        title={text}
                      >
                        {isJob || isStep ? <JobName name={lane.label} /> : (lane.displayLabel ?? lane.label)}
                      </span>
                      {isExpandable && <span className="shrink-0 rounded bg-zinc-200/70 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{countBadge}</span>}
                      {isGroup && (lane.failedCount ?? 0) > 0 && <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 font-mono text-[9px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">{lane.failedCount} failed</span>}
                      {isLoadingDetails && <span className="shrink-0 text-[9px] text-cyan-600 dark:text-cyan-400">loading tests…</span>}
                      {hasDetailError && <span className="shrink-0 text-[9px] text-red-600 dark:text-red-400">test trace load failed; select again to retry</span>}
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-400">{formatDuration(lane.durationMs)}</span>
                      {lane.jobId && jobLanes.some((job) => job.jobId === lane.jobId && job.gpuAvailable) && (
                        <button
                          type="button"
                          aria-pressed={gpuLaneId === lane.id}
                          aria-label={`${gpuLaneId === lane.id ? "Hide" : "Show"} GPU activity during ${text}`}
                          title="GPU utilization and memory during this interval"
                          onClick={() => setGpuLaneId(gpuLaneId === lane.id ? null : lane.id)}
                          className={`dashboard-control inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-[10px] font-medium transition-colors ${
                            gpuLaneId === lane.id
                              ? "border-cyan-400 bg-cyan-100 text-cyan-800 dark:border-cyan-600 dark:bg-cyan-950 dark:text-cyan-200"
                              : "border-zinc-300 bg-white text-zinc-500 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-cyan-800 dark:hover:bg-cyan-950/50 dark:hover:text-cyan-300"
                          }`}
                        >
                          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3">
                            <rect x="3" y="3" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                            <rect x="6" y="6" width="4" height="4" rx="0.5" fill="currentColor" />
                          </svg>
                          GPU
                        </button>
                      )}
                    </div>
                    {isJob && (
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 pl-7 font-mono text-[10px] text-zinc-400">
                        <span className="truncate">{lane.queue ?? lane.group ?? lane.kind}</span>
                        {lane.waitMs > 0 && <span className="shrink-0">+{formatDuration(lane.waitMs)} wait</span>}
                      </div>
                    )}
                  </div>
                  <TimelineHoverArea start={timelineStart} end={timelineEnd} className="flex min-h-7 self-stretch items-center">
                    <div className="relative h-7 w-full">
                      <GridLines ticks={tickFractions} />
                      {queueWidth > 0.08 && isJob && (
                        <span aria-hidden="true" className="absolute top-2 h-3 rounded-l-sm bg-zinc-300 dark:bg-zinc-700" style={{ left: `${queueLeft}%`, width: `${Math.max(queueWidth, 0.2)}%`, backgroundImage: "repeating-linear-gradient(135deg, transparent, transparent 3px, rgb(255 255 255 / 0.35) 3px, rgb(255 255 255 / 0.35) 4px)" }} />
                      )}
                      {lane.url ? (
                        <a href={lane.url} target="_blank" rel="noopener noreferrer" aria-label={detail} title={detail} className={`absolute top-1.5 h-4 min-w-1 rounded-sm transition-[filter] hover:brightness-110 ${laneColor(lane)}`} style={{ left: `${runLeft}%`, width: `${Math.max(runWidth, 0.25)}%` }} />
                      ) : (
                        <span role="img" aria-label={detail} title={detail} className={`absolute top-1.5 h-4 min-w-1 rounded-sm ${laneColor(lane)}`} style={{ left: `${runLeft}%`, width: `${Math.max(runWidth, 0.25)}%` }} />
                      )}
                    </div>
                  </TimelineHoverArea>
                </div>
                {showGpuPanel && gpuLane?.jobId && (
                  <JobGpuTimeline
                    key={`gpu-${gpuLane.id}-${gpuLane.startTime}-${gpuLane.endTime}`}
                    organization={organization}
                    pipeline={pipeline}
                    buildNumber={buildNumber}
                    jobId={gpuLane.jobId}
                    label={laneText(gpuLane)}
                    startTime={gpuLane.startTime}
                    endTime={gpuLane.endTime}
                    timelineStart={timelineStart}
                    timelineEnd={timelineEnd}
                    onClose={() => setGpuLaneId(null)}
                    axis={gpuAxis}
                    onAxisChange={setGpuAxis}
                  />
                )}
                </Fragment>
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
    </TimelineCursorProvider>
  );
}
