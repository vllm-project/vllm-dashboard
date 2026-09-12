"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { SegmentedControl } from "@/components/segmented-control";
import { TimelineHoverArea, useTimelineHoverTime } from "@/components/timeline-cursor";
import { formatDuration } from "@/lib/format-duration";
import {
  gpuSegments,
  summarizeGpuSamples,
  type GpuDeviceSummary,
  type JobGpuResponse,
  type JobGpuSample,
} from "@/lib/job-gpu";

interface Props {
  organization: string;
  pipeline: string;
  buildNumber: string;
  jobId: string;
  /** Human label of the selected job, command, or test. */
  label: string;
  startTime: string;
  endTime: string;
  /** Build-wide axis, so charts can line up with the waterfall bars. */
  timelineStart: number;
  timelineEnd: number;
  onClose?: () => void;
  /** Which time axis the charts use. Owned by the parent so it survives remounts. */
  axis: GpuAxis;
  onAxisChange: (axis: GpuAxis) => void;
}

export type GpuAxis = "selection" | "build";

const AXIS_OPTIONS = [
  { value: "selection", label: "Selection" },
  { value: "build", label: "Full build" },
] as const satisfies ReadonlyArray<{ value: GpuAxis; label: string }>;

/** Mirrors the waterfall's row grid so chart edges sit under the timeline bars. */
const PANEL_GRID = "grid-cols-[minmax(22rem,34rem)_minmax(28rem,1fr)]";
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const CHART_HEIGHT = 100;

function gib(bytes: number | null, digits = 1): string {
  return bytes === null ? "—" : `${(bytes / 1024 ** 3).toFixed(digits)} GiB`;
}

function percent(value: number | null, digits = 0): string {
  return value === null ? "—" : `${value.toFixed(digits)}%`;
}

function memoryPercent(point: JobGpuSample): number | null {
  if (!point.memoryTotalBytes || point.memoryUsedBytes === null) return null;
  return (100 * point.memoryUsedBytes) / point.memoryTotalBytes;
}

async function fetchGpu(url: string): Promise<JobGpuResponse> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to load GPU samples");
  return response.json();
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">{label}</div>
      <div className="font-mono text-[11px] tabular-nums text-zinc-700 dark:text-zinc-300">{value}</div>
    </div>
  );
}

export function GpuSampleChart({
  samples,
  start,
  end,
  intervalMs,
  buildStart,
}: {
  samples: JobGpuSample[];
  start: number;
  end: number;
  intervalMs: number;
  buildStart: number;
}) {
  const hover = useTimelineHoverTime();
  const span = Math.max(1, end - start);
  const x = (time: number) => ((time - start) / span) * 1000;
  const y = (value: number | null) => CHART_HEIGHT - 1 - (value ?? 0) * 0.98;

  const utilizationSegments = useMemo(() => gpuSegments(samples, "utilization", intervalMs), [samples, intervalMs]);
  const memorySegments = useMemo(
    () => gpuSegments(samples.map((point) => (point.memoryTotalBytes ? point : { ...point, memoryUsedBytes: null })), "memoryUsedBytes", intervalMs),
    [samples, intervalMs],
  );

  const selected = useMemo(() => {
    if (hover === null || samples.length === 0) return null;
    let best: JobGpuSample | null = null;
    for (const point of samples) {
      if (!best || Math.abs(point.timestamp - hover) < Math.abs(best.timestamp - hover)) best = point;
    }
    return best && Math.abs(best.timestamp - hover) <= intervalMs * 1.5 ? best : null;
  }, [hover, samples, intervalMs]);

  const cursorInRange = hover !== null && hover >= start && hover <= end;
  const cursorFraction = cursorInRange ? (hover - start) / span : 0;
  const flipLabel = cursorFraction > 0.68;

  return (
    <TimelineHoverArea start={start} end={end} className="h-20">
      <svg
        viewBox={`0 0 1000 ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="GPU utilization and used memory as a percent of device capacity. Gaps are missing samples."
        className="h-full w-full overflow-hidden"
      >
        {[25, 50, 75].map((value) => (
          <line key={value} x1="0" x2="1000" y1={y(value)} y2={y(value)} stroke="currentColor" className="text-zinc-200/80 dark:text-zinc-800" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        <line x1="0" x2="1000" y1={y(0)} y2={y(0)} stroke="currentColor" className="text-zinc-300 dark:text-zinc-700" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {utilizationSegments.map((segment, index) => {
          const points = segment.map((point) => `${x(point.timestamp)},${y(point.utilization)}`).join(" ");
          if (segment.length === 1) {
            return <circle key={`u-${index}`} cx={x(segment[0].timestamp)} cy={y(segment[0].utilization)} r="2" className="fill-cyan-500" />;
          }
          const first = segment[0];
          const last = segment[segment.length - 1];
          return (
            <g key={`u-${index}`} className="text-cyan-500 dark:text-cyan-400">
              <polygon fill="currentColor" fillOpacity="0.14" points={`${x(first.timestamp)},${y(0)} ${points} ${x(last.timestamp)},${y(0)}`} />
              <polyline fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" points={points} />
            </g>
          );
        })}
        {memorySegments.map((segment, index) => {
          const points = segment.map((point) => `${x(point.timestamp)},${y(memoryPercent(point))}`).join(" ");
          return segment.length === 1 ? (
            <circle key={`m-${index}`} cx={x(segment[0].timestamp)} cy={y(memoryPercent(segment[0]))} r="2" className="fill-violet-500" />
          ) : (
            <polyline key={`m-${index}`} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className="text-violet-500 dark:text-violet-400" points={points} />
          );
        })}
      </svg>
      <span aria-hidden="true" className="pointer-events-none absolute left-1 top-0 rounded bg-white/80 px-1 font-mono text-[9px] leading-4 text-zinc-400 dark:bg-zinc-950/80 dark:text-zinc-500">100%</span>
      <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-1 rounded bg-white/80 px-1 font-mono text-[9px] leading-4 text-zinc-400 dark:bg-zinc-950/80 dark:text-zinc-500">0</span>
      {cursorInRange && (
        <div
          aria-live="polite"
          className={`pointer-events-none absolute top-1 z-20 whitespace-nowrap rounded-md border border-zinc-200 bg-white/95 px-2 py-1 font-mono text-[10px] leading-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/95 ${flipLabel ? "-translate-x-full" : ""}`}
          style={{ left: `calc(${cursorFraction * 100}% + ${flipLabel ? "-6px" : "6px"})` }}
        >
          <span className="text-zinc-500 dark:text-zinc-400">{formatDuration(hover - buildStart)}</span>
          {selected ? (
            <>
              <span className="mx-1.5 text-zinc-300 dark:text-zinc-600">·</span>
              <span className="font-medium text-cyan-700 dark:text-cyan-300">{percent(selected.utilization)}</span>
              <span className="mx-1.5 text-zinc-300 dark:text-zinc-600">·</span>
              <span className="font-medium text-violet-700 dark:text-violet-300">{gib(selected.memoryUsedBytes)}</span>
            </>
          ) : (
            <span className="ml-1.5 text-zinc-400">no sample</span>
          )}
        </div>
      )}
    </TimelineHoverArea>
  );
}

function DeviceRow({
  device,
  axisStart,
  axisEnd,
  intervalMs,
  buildStart,
}: {
  device: GpuDeviceSummary;
  axisStart: number;
  axisEnd: number;
  intervalMs: number;
  buildStart: number;
}) {
  const capacity = device.samples.find((sample) => sample.memoryTotalBytes)?.memoryTotalBytes ?? null;
  const hasMig = device.samples.some((sample) => sample.status === "unsupported_mig");
  return (
    <div className={`grid ${PANEL_GRID} items-center gap-4 border-t border-zinc-200/70 py-2.5 dark:border-zinc-800/70`}>
      <div className="min-w-0 pl-7">
        <p className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200" title={device.deviceId}>
          GPU {device.index}
          <span className="ml-1.5 font-normal text-zinc-500 dark:text-zinc-400">{device.name}</span>
        </p>
        <div className="mt-1.5 grid grid-cols-3 gap-3">
          <Stat label="Mean util" value={percent(device.meanUtilization, 1)} hint="Mean of utilization samples in this interval; not time-weighted" />
          <Stat label="Peak mem" value={capacity ? `${gib(device.peakMemoryBytes)} / ${gib(capacity, 0)}` : gib(device.peakMemoryBytes)} hint="Highest used memory sample and device capacity" />
          <Stat label="Coverage" value={`${Math.round(device.coverage * 100)}%`} hint={`${device.samples.length} samples · share of ${intervalMs / 1000}s intervals with a utilization reading`} />
        </div>
        {hasMig && (
          <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400">MIG metrics unavailable; parent GPU memory is not attributed to this job.</p>
        )}
      </div>
      <GpuSampleChart samples={device.samples} start={axisStart} end={axisEnd} intervalMs={intervalMs} buildStart={buildStart} />
    </div>
  );
}

export function JobGpuTimeline(props: Props) {
  const { axis, onAxisChange } = props;
  const start = Date.parse(props.startTime);
  const end = Math.max(start + 1, Date.parse(props.endTime));
  const params = new URLSearchParams({
    organization: props.organization,
    pipeline: props.pipeline,
    buildNumber: props.buildNumber,
    jobId: props.jobId,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  });
  const { data, error, isLoading, mutate } = useSWR<JobGpuResponse>(`/api/builds/gpu?${params}`, fetchGpu, { refreshInterval: 15_000 });
  const intervalMs = data?.intervalMs ?? 1000;
  const devices = useMemo(() => summarizeGpuSamples(data?.samples ?? [], start, end, intervalMs), [data, start, end, intervalMs]);
  const axisStart = axis === "selection" ? start : props.timelineStart;
  const axisEnd = axis === "selection" ? end : props.timelineEnd;
  const hover = useTimelineHoverTime();

  return (
    <section
      aria-label={`GPU activity during ${props.label}`}
      className="border-b border-zinc-200/70 bg-cyan-50/40 shadow-[inset_3px_0_0_0_theme(colors.cyan.400)] dark:border-zinc-800/70 dark:bg-cyan-950/15 dark:shadow-[inset_3px_0_0_0_theme(colors.cyan.600)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-3 pb-2 pl-7">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h5 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">GPU activity</h5>
            <span className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400" title={props.label}>{props.label}</span>
            <span className="font-mono text-[10px] text-zinc-400">{formatDuration(end - start)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-cyan-500" /> utilization</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-violet-500" /> used memory, % of capacity</span>
            <span className="hidden sm:inline">1 s samples · devices are shared by tests that overlap in time</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl label="GPU chart time axis" value={axis} options={AXIS_OPTIONS} onChange={onAxisChange} />
          {props.onClose && (
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Close GPU activity"
              className="dashboard-control flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
      </div>

      {isLoading && <p className="px-5 pb-3 pl-7 text-xs text-zinc-500">Loading GPU samples…</p>}
      {error && (
        <p className="px-5 pb-3 pl-7 text-xs text-red-600 dark:text-red-400">
          GPU samples could not be loaded.{" "}
          <button type="button" onClick={() => mutate()} className="font-medium underline">Retry</button>
        </p>
      )}
      {data && !error && devices.length === 0 && (
        <p className="px-5 pb-3 pl-7 text-xs text-zinc-500">No GPU samples in this interval. That does not mean the GPUs were idle: the interval may be shorter than the sampling period, or samples may not have arrived yet.</p>
      )}
      {data?.truncated && (
        <p className="px-5 pb-2 pl-7 text-xs text-amber-700 dark:text-amber-400">Partial data: this interval exceeds the sample limit. Select a shorter command or test for full detail.</p>
      )}

      {devices.length > 0 && (
        <div className="px-5">
          <div className={`grid ${PANEL_GRID} gap-4 pb-1`}>
            <div className="pl-7 text-[10px] text-zinc-400">
              {hover !== null ? `Cursor at ${formatDuration(hover - props.timelineStart)}` : "Hover a chart to read a sample"}
            </div>
            <div className="relative h-4 font-mono text-[10px] text-zinc-400">
              {TICKS.map((tick) => (
                <span key={tick} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${tick * 100}%` }}>
                  {formatDuration(axisStart - props.timelineStart + (axisEnd - axisStart) * tick)}
                </span>
              ))}
            </div>
          </div>
          {devices.map((device) => (
            <DeviceRow key={device.deviceId} device={device} axisStart={axisStart} axisEnd={axisEnd} intervalMs={intervalMs} buildStart={props.timelineStart} />
          ))}
        </div>
      )}
    </section>
  );
}
