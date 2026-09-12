"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { TimelineHoverArea, useTimelineHoverTime } from "@/components/timeline-cursor";
import { gpuSegments, summarizeGpuSamples, type JobGpuResponse, type JobGpuSample } from "@/lib/job-gpu";

interface Props {
  organization: string;
  pipeline: string;
  buildNumber: string;
  jobId: string;
  label: string;
  startTime: string;
  endTime: string;
  timelineStart: number;
  timelineEnd: number;
}

function gib(bytes: number | null): string {
  return bytes === null ? "unavailable" : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

async function fetchGpu(url: string): Promise<JobGpuResponse> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to load GPU samples");
  return response.json();
}

export function GpuSampleChart({ samples, start, end, intervalMs }: {
  samples: JobGpuSample[]; start: number; end: number; intervalMs: number;
}) {
  const hover = useTimelineHoverTime();
  const x = (time: number) => (time - start) / Math.max(1, end - start) * 1000;
  const percent = (point: JobGpuSample, metric: "utilization" | "memoryUsedBytes") => metric === "utilization"
    ? point.utilization : point.memoryTotalBytes && point.memoryUsedBytes !== null
      ? 100 * point.memoryUsedBytes / point.memoryTotalBytes : null;
  const nearest = hover === null ? null : samples.reduce<JobGpuSample | null>((best, point) =>
    !best || Math.abs(point.timestamp - hover) < Math.abs(best.timestamp - hover) ? point : best, null);
  const selected = nearest && hover !== null && Math.abs(nearest.timestamp - hover) <= intervalMs * 1.5 ? nearest : null;
  return (
    <div className="relative">
      <TimelineHoverArea start={start} end={end}>
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img"
          aria-label="GPU utilization and used memory as percent of device capacity; gaps mean missing samples"
          className="h-24 w-full overflow-hidden">
          {[0, 25, 50, 75, 100].map((value) => <line key={value} x1="0" x2="1000" y1={100 - value} y2={100 - value} stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" strokeWidth="0.6" />)}
          {(["utilization", "memoryUsedBytes"] as const).map((metric) => gpuSegments(
            samples.map((point) => metric === "memoryUsedBytes" && !point.memoryTotalBytes ? { ...point, memoryUsedBytes: null } : point), metric, intervalMs,
          ).map((segment, index) => (
            <g key={`${metric}-${index}`} className={metric === "utilization" ? "text-cyan-600 dark:text-cyan-400" : "text-violet-600 dark:text-violet-400"}>
              {segment.length === 1 ? <circle cx={x(segment[0].timestamp)} cy={99 - (percent(segment[0], metric) ?? 0) * 0.98} r="2" fill="currentColor" /> :
                <polyline fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" points={segment.map((point) => `${x(point.timestamp)},${99 - (percent(point, metric) ?? 0) * 0.98}`).join(" ")} />}
            </g>
          )))}
        </svg>
      </TimelineHoverArea>
      <div className="min-h-5 font-mono text-[10px] text-zinc-500" aria-live="polite">
        {hover !== null ? selected ? `${new Date(selected.timestamp).toISOString().slice(11, 23)} UTC · GPU ${selected.utilization === null ? "unavailable" : `${selected.utilization}%`} · memory ${gib(selected.memoryUsedBytes)} / ${gib(selected.memoryTotalBytes)}` : "No sample at this time" : "Hover to inspect samples · vertical scale 0–100%"}
      </div>
    </div>
  );
}

export function JobGpuTimeline(props: Props) {
  const [focused, setFocused] = useState(false);
  const start = Date.parse(props.startTime);
  const end = Math.max(start + 1, Date.parse(props.endTime));
  const params = new URLSearchParams({
    organization: props.organization, pipeline: props.pipeline, buildNumber: props.buildNumber,
    jobId: props.jobId, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
  });
  const { data, error, isLoading, mutate } = useSWR<JobGpuResponse>(`/api/builds/gpu?${params}`, fetchGpu, { refreshInterval: 15_000 });
  const devices = useMemo(() => summarizeGpuSamples(data?.samples ?? [], start, end, data?.intervalMs ?? 1000), [data, start, end]);
  const axisStart = focused ? start : props.timelineStart;
  const axisEnd = focused ? end : props.timelineEnd;
  return (
    <section aria-label={`GPU samples during ${props.label}`} className="col-span-2 border-y border-cyan-200 bg-white py-3 dark:border-cyan-900 dark:bg-zinc-950">
      <div className="mb-2 flex items-start justify-between gap-4 text-xs">
        <div className="min-w-0">
          <p className="truncate font-medium" title={props.label}>GPU activity during {props.label}</p>
          <p className="mt-1 text-[11px] text-zinc-500">1s sampling · device activity during this interval, shared by overlapping tests. Short tests may fall between samples.</p>
        </div>
        <button type="button" aria-pressed={focused} onClick={() => setFocused(!focused)} className="shrink-0 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">
          {focused ? "Align with build" : "Zoom to interval"}
        </button>
      </div>
      {isLoading && <p className="py-3 text-xs text-zinc-500">Loading GPU samples…</p>}
      {error && <button type="button" onClick={() => mutate()} className="py-3 text-xs text-red-600">GPU samples could not be loaded. Retry</button>}
      {data && !error && devices.length === 0 && <p className="py-3 text-xs text-zinc-500">No GPU samples in this interval. This does not mean the GPUs were idle.</p>}
      {data?.truncated && <p className="mb-2 text-xs text-amber-700">Partial data: this interval exceeds the sample limit. Select a shorter command or test to inspect its full detail.</p>}
      {devices.length > 0 && <div className="grid grid-cols-[minmax(22rem,34rem)_minmax(28rem,1fr)] gap-4 text-[10px] text-zinc-500">
        <div><span className="text-cyan-600 dark:text-cyan-400">━ GPU utilization</span> · <span className="text-violet-600 dark:text-violet-400">━ used memory / capacity</span></div>
        <div className="relative h-5 font-mono">{[0, 0.25, 0.5, 0.75, 1].map((tick) => <span key={tick} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${tick * 100}%` }}>{((axisStart - props.timelineStart + (axisEnd - axisStart) * tick) / 1000).toFixed(1)}s</span>)}</div>
      </div>}
      {devices.map((device) => <div key={device.deviceId} className="grid grid-cols-[minmax(22rem,34rem)_minmax(28rem,1fr)] items-center gap-4 border-t border-zinc-100 py-2 dark:border-zinc-900">
        <div className="text-xs">
          <p className="font-medium" title={device.deviceId}>GPU {device.index} · {device.name}</p>
          <p className="mt-1 font-mono text-[11px]">Sample mean {device.meanUtilization === null ? "unavailable" : `${device.meanUtilization.toFixed(1)}%`} · peak memory {gib(device.peakMemoryBytes)}</p>
          <p className="mt-1 text-[10px] text-zinc-500">{device.samples.length} samples · {Math.round(device.coverage * 100)}% of 1s intervals have utilization readings</p>
          {device.samples.some((sample) => sample.status === "unsupported_mig") && <p className="mt-1 text-[11px] text-amber-700">MIG metrics unavailable; parent GPU memory is not attributed to this job.</p>}
        </div>
        <GpuSampleChart samples={device.samples} start={axisStart} end={axisEnd} intervalMs={data?.intervalMs ?? 1000} />
      </div>)}
    </section>
  );
}
