"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { JobName, jobNameText } from "@/components/job-name";

type LaneKind = "job" | "step" | "command" | "test";

interface WaterfallLane {
  id: string;
  parentId: string | null;
  kind: LaneKind;
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

function laneDepth(lane: WaterfallLane): number {
  if (lane.kind === "test") return 2;
  if (lane.kind === "command") return 1;
  return 0;
}

function laneColor(lane: WaterfallLane): string {
  if (lane.critical) {
    return "border border-amber-500 bg-amber-300 shadow-[0_0_0_1px_rgb(245_158_11_/_0.12)] dark:bg-amber-500";
  }
  if (lane.status === "failed") return "bg-red-500 dark:bg-red-500";
  if (lane.status === "skipped") return "bg-zinc-300 dark:bg-zinc-600";
  if (lane.kind === "test") return "bg-emerald-500 dark:bg-emerald-500";
  if (lane.kind === "command") return "bg-cyan-500 dark:bg-cyan-500";
  return "bg-blue-500 dark:bg-blue-500";
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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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

  const { jobLanes, childrenByParent } = useMemo(() => {
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
    return { jobLanes: roots, childrenByParent: children };
  }, [data?.lanes, jobDetails]);

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

  const visibleLanes = useMemo(() => {
    const flattened: WaterfallLane[] = [];
    for (const job of visibleJobs) {
      flattened.push(job);
      if (!expanded.has(job.id)) continue;
      for (const command of childrenByParent.get(job.id) ?? []) {
        flattened.push(command);
        if (!expanded.has(command.id)) continue;
        flattened.push(...(childrenByParent.get(command.id) ?? []));
      }
    }
    return flattened;
  }, [childrenByParent, expanded, visibleJobs]);

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
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(lane.id)) next.delete(lane.id);
      else next.add(lane.id);
      return next;
    });
  }

  function toggleAllJobs() {
    const expandableJobs = jobLanes
      .filter((lane) => (childrenByParent.get(lane.id)?.length ?? 0) > 0)
      .map((lane) => lane.id);
    const allExpanded = expandableJobs.every((id) => expanded.has(id));
    setExpanded((current) => {
      const next = new Set(current);
      for (const id of expandableJobs) {
        if (allExpanded) next.delete(id);
        else next.add(id);
      }
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
    expandableJobs.length > 0 && expandableJobs.every((lane) => expanded.has(lane.id));

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
            Select a traced job to see its commands. Select a pytest command to
            see every test. Amber jobs are inferred build-limiting work.
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
          <div className="grid grid-cols-[minmax(16rem,21rem)_minmax(32rem,1fr)] gap-4 border-b border-zinc-200 pb-2 dark:border-zinc-800">
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
            {visibleLanes.map((lane) => {
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
              const depth = laneDepth(lane);
              const detail = `${jobNameText(lane.label)} · ${formatTime(lane.startTime)}–${formatTime(lane.endTime)} · ${formatDuration(lane.durationMs)}${lane.outcome ? ` · ${lane.outcome}` : ""}`;
              const rowTone = depth === 0 ? "" : depth === 1 ? "bg-cyan-50/35 dark:bg-cyan-950/10" : "bg-emerald-50/30 dark:bg-emerald-950/10";

              return (
                <div key={lane.id} className={`grid min-h-10 grid-cols-[minmax(16rem,21rem)_minmax(32rem,1fr)] items-center gap-4 border-b border-zinc-200/70 last:border-0 dark:border-zinc-800/70 ${rowTone}`}>
                  <div className="relative min-w-0 py-1.5" style={{ paddingLeft: `${depth * 18}px` }}>
                    {depth > 0 && <span aria-hidden="true" className={`absolute inset-y-0 w-px ${depth === 1 ? "left-2 bg-cyan-200 dark:bg-cyan-900" : "left-6 bg-emerald-200 dark:bg-emerald-900"}`} />}
                    <div className="flex items-center gap-1.5">
                      {isExpandable ? (
                        <button type="button" onClick={() => toggleExpanded(lane)} aria-expanded={expanded.has(lane.id)} aria-label={`${expanded.has(lane.id) ? "Collapse" : "Expand"} ${jobNameText(lane.label)}`} className="dashboard-control flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                          <span aria-hidden="true" className={`transition-transform ${expanded.has(lane.id) ? "rotate-90" : ""}`}>›</span>
                        </button>
                      ) : <span className="w-6 shrink-0" />}
                      {lane.critical && <span aria-label="Inferred build-limiting job" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
                      <span className={`truncate text-xs text-zinc-800 dark:text-zinc-200 ${depth === 0 ? "font-medium" : "font-mono text-[11px]"}`} title={jobNameText(lane.label)}><JobName name={lane.label} /></span>
                      {isExpandable && <span className="shrink-0 rounded bg-zinc-200/70 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{displayedChildCount}</span>}
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
