"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";

interface WaterfallLane {
  id: string;
  kind: "job" | "step";
  label: string;
  group: string | null;
  stepKey: string | null;
  jobId: string | null;
  queue: string | null;
  startTime: string;
  endTime: string;
  durationMs: number;
  waitMs: number;
  status: "passed" | "failed" | "unknown";
  url: string | null;
  critical: boolean;
}

interface TraceResponse {
  available: boolean;
  complete: boolean;
  truncated: boolean;
  lanes: WaterfallLane[];
  summary: {
    observedStart: string;
    observedEnd: string;
    observedDurationMs: number;
    spanCount: number;
    laneCount: number;
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

const INITIAL_LANE_LIMIT = 36;
const TICKS = [0, 0.25, 0.5, 0.75, 1];

async function fetchTrace(url: string): Promise<TraceResponse> {
  const response = await fetch(url);
  const body = (await response.json()) as TraceResponse;
  if (!response.ok) {
    throw new Error(body.error ?? "Failed to load trace");
  }
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

export function BuildWaterfall({
  organization,
  pipeline,
  buildNumber,
  buildUrl,
  startedJobCount,
}: BuildWaterfallProps) {
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const params = new URLSearchParams({
    organization,
    pipeline,
    buildNumber,
  });
  const { data, error, isLoading, isValidating, mutate } = useSWR<TraceResponse>(
    `/api/builds/trace?${params.toString()}`,
    fetchTrace,
    {
      keepPreviousData: true,
      refreshInterval: (latest) => (latest?.complete ? 0 : 10_000),
    },
  );

  const orderedLanes = useMemo(
    () =>
      [...(data?.lanes ?? [])].sort((a, b) => {
        const start = Date.parse(a.startTime) - Date.parse(b.startTime);
        if (start !== 0) return start;
        return b.durationMs - a.durationMs;
      }),
    [data?.lanes],
  );

  const visibleLanes = useMemo(() => {
    if (criticalOnly) return orderedLanes.filter((lane) => lane.critical);
    if (showAll || orderedLanes.length <= INITIAL_LANE_LIMIT) return orderedLanes;
    const initiallyVisible = new Set(
      orderedLanes.slice(0, INITIAL_LANE_LIMIT).map((lane) => lane.id),
    );
    for (const lane of orderedLanes) {
      if (lane.critical) initiallyVisible.add(lane.id);
    }
    return orderedLanes.filter((lane) => initiallyVisible.has(lane.id));
  }, [criticalOnly, orderedLanes, showAll]);

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

  if (!data?.available || !data.summary || data.lanes.length === 0) {
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
  const hiddenCount = Math.max(0, orderedLanes.length - visibleLanes.length);
  const hasCoverage =
    typeof startedJobCount === "number" && startedJobCount > 0;
  const coverageTotal = hasCoverage
    ? Math.max(startedJobCount, summary.laneCount)
    : null;
  const isPartial =
    data.complete && coverageTotal !== null && summary.laneCount < coverageTotal;
  const traceState = !data.complete
    ? "Live"
    : isPartial
      ? "Partial"
      : "Complete";
  const traceStateColor = !data.complete
    ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
    : isPartial
      ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
      : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";

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
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] ${traceStateColor}`}
            >
              {traceState}
            </span>
            {isValidating && (
              <span className="text-[11px] text-zinc-400">Checking…</span>
            )}
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            Amber marks jobs most likely to determine when the build finished.
            This is inferred from timing because Buildkite OTel does not include
            dependency links.
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 lg:items-end">
          <a
            href={buildUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="dashboard-control inline-flex min-h-9 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-blue-600 hover:border-blue-300 hover:bg-blue-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-blue-400 dark:hover:border-blue-800 dark:hover:bg-blue-950/50"
          >
            Open Buildkite #{buildNumber}
            <span aria-hidden="true">↗</span>
          </a>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span>
              <strong className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                {formatDuration(summary.observedDurationMs)}
              </strong>{" "}
              observed
            </span>
            <span>
              <strong className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                {summary.laneCount}
                {coverageTotal !== null ? ` of ${coverageTotal}` : ""}
              </strong>{" "}
              jobs traced
            </span>
            <span>
              <strong className="font-mono font-semibold text-amber-700 dark:text-amber-300">
                {summary.criticalCount}
              </strong>{" "}
              build-limiting
            </span>
            <span>
              <strong className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                {summary.queueCount}
              </strong>{" "}
              queues
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <div className="flex items-center gap-4 text-[11px] text-zinc-500 dark:text-zinc-400">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-sm bg-blue-500" /> run
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-sm bg-red-500" /> failed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-sm border border-amber-500 bg-amber-300 dark:bg-amber-500" />
            build-limiting
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-sm bg-zinc-300 dark:bg-zinc-700" /> queued
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={criticalOnly}
            onClick={() => setCriticalOnly((value) => !value)}
            className={`dashboard-control min-h-9 rounded-md border px-3 text-xs font-medium ${
              criticalOnly
                ? "border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-600 dark:bg-amber-950/60 dark:text-amber-200"
                : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
            }`}
          >
            {criticalOnly ? "Show all jobs" : "Show build-limiting jobs"}
          </button>
          {!criticalOnly && orderedLanes.length > INITIAL_LANE_LIMIT && (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="dashboard-control min-h-9 rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {showAll ? "Show less" : `Show all ${orderedLanes.length}`}
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto pb-2">
        <div className="min-w-[760px] px-5">
          <div className="grid grid-cols-[minmax(13rem,17rem)_minmax(32rem,1fr)] gap-4 border-b border-zinc-200 pb-2 dark:border-zinc-800">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
              Job / span
            </div>
            <div className="relative h-5 font-mono text-[10px] text-zinc-400">
              {TICKS.map((tick) => (
                <span
                  key={tick}
                  className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
                  style={{ left: `${tick * 100}%` }}
                >
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
              const queueLeft = clampPercent(
                ((queueStart - timelineStart) / timelineDuration) * 100,
              );
              const queueWidth = clampPercent(
                ((start - queueStart) / timelineDuration) * 100,
              );
              const runLeft = clampPercent(
                ((start - timelineStart) / timelineDuration) * 100,
              );
              const runWidth = clampPercent(
                ((end - start) / timelineDuration) * 100,
              );
              const runColor = lane.critical
                ? "border border-amber-500 bg-amber-300 shadow-[0_0_0_1px_rgb(245_158_11_/_0.12)] dark:bg-amber-500"
                : lane.status === "failed"
                  ? "bg-red-500 dark:bg-red-500"
                  : "bg-blue-500 dark:bg-blue-500";
              const detail = `${lane.label} · ${formatTime(lane.startTime)}–${formatTime(lane.endTime)} · ${formatDuration(lane.durationMs)}${lane.queue ? ` · ${lane.queue}` : ""}`;

              return (
                <div
                  key={lane.id}
                  className="grid min-h-11 grid-cols-[minmax(13rem,17rem)_minmax(32rem,1fr)] items-center gap-4 border-b border-zinc-200/70 last:border-0 dark:border-zinc-800/70"
                >
                  <div className="min-w-0 py-2">
                    <div className="flex items-center gap-2">
                      {lane.critical && (
                        <span
                          aria-label="Inferred build-limiting job"
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                        />
                      )}
                      <span
                        className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200"
                        title={lane.label}
                      >
                        {lane.label}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-400">
                        {formatDuration(lane.durationMs)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-2 pl-3.5 font-mono text-[10px] text-zinc-400">
                      <span className="truncate">
                        {lane.queue ?? lane.group ?? lane.kind}
                      </span>
                      {lane.waitMs > 0 && (
                        <span className="shrink-0">
                          +{formatDuration(lane.waitMs)} wait
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="relative h-7">
                    <GridLines />
                    {queueWidth > 0.08 && (
                      <span
                        aria-hidden="true"
                        className="absolute top-2 h-3 rounded-l-sm bg-zinc-300 dark:bg-zinc-700"
                        style={{
                          left: `${queueLeft}%`,
                          width: `${Math.max(queueWidth, 0.2)}%`,
                          backgroundImage:
                            "repeating-linear-gradient(135deg, transparent, transparent 3px, rgb(255 255 255 / 0.35) 3px, rgb(255 255 255 / 0.35) 4px)",
                        }}
                      />
                    )}
                    {lane.url ? (
                      <a
                        href={lane.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={detail}
                        title={detail}
                        className={`absolute top-1.5 h-4 min-w-1 rounded-sm transition-[filter] hover:brightness-110 ${runColor}`}
                        style={{
                          left: `${runLeft}%`,
                          width: `${Math.max(runWidth, 0.25)}%`,
                        }}
                      />
                    ) : (
                      <span
                        role="img"
                        aria-label={detail}
                        title={detail}
                        className={`absolute top-1.5 h-4 min-w-1 rounded-sm ${runColor}`}
                        style={{
                          left: `${runLeft}%`,
                          width: `${Math.max(runWidth, 0.25)}%`,
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {hiddenCount > 0 && !criticalOnly && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="dashboard-control my-2 min-h-10 w-full rounded-md text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200"
            >
              Show {hiddenCount} more spans
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 px-5 py-2.5 font-mono text-[10px] text-zinc-400 dark:border-zinc-800">
        <span>
          {formatTime(summary.observedStart)} → {formatTime(summary.observedEnd)}
        </span>
        <span>
          Last span received {formatTime(summary.latestReceivedAt)}
          {data.truncated ? " · first 2,000 spans" : ""}
        </span>
      </div>
    </section>
  );
}
