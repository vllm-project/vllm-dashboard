/** Wire contract for ci.gpu.samples spans emitted by the in-container CI helper. */
export interface JobGpuSample {
  timestamp: number;
  deviceId: string;
  index: number;
  name: string;
  utilization: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  status: string | null;
}

export interface JobGpuResponse {
  samples: JobGpuSample[];
  truncated: boolean;
  intervalMs: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

/** Invalid/unsupported metrics remain unknown, including the entire MIG parent. */
export function parseGpuEvents(events: unknown, start: number, end: number): JobGpuSample[] {
  if (!Array.isArray(events)) return [];
  const samples: JobGpuSample[] = [];
  for (const value of events) {
    const event = object(value);
    if (event?.name !== "ci.gpu.sample") continue;
    const attributes = object(event.attributes);
    if (!attributes || typeof attributes["gpu.uuid"] !== "string") continue;
    const ns = number(event.timeUnixNano, Number.MAX_VALUE);
    const timestamp = ns === null ? NaN : ns / 1_000_000;
    const index = number(attributes["gpu.index"], 1024);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= end || index === null) continue;
    const status = typeof attributes["gpu.status"] === "string" ? attributes["gpu.status"] : null;
    const unsupported = status === "unsupported_mig";
    const total = unsupported ? null : number(attributes["gpu.memory.total"]);
    samples.push({
      timestamp,
      deviceId: attributes["gpu.uuid"].slice(0, 128),
      index,
      name: typeof attributes["gpu.name"] === "string" ? attributes["gpu.name"].slice(0, 128) : "GPU",
      utilization: unsupported ? null : number(attributes["gpu.utilization"], 100),
      memoryUsedBytes: unsupported ? null : number(attributes["gpu.memory.used"], total ?? undefined),
      memoryTotalBytes: total && total > 0 ? total : null,
      status,
    });
  }
  return samples;
}

export interface GpuDeviceSummary {
  deviceId: string;
  index: number;
  name: string;
  samples: JobGpuSample[];
  meanUtilization: number | null;
  peakMemoryBytes: number | null;
  coverage: number;
}

/** Sample means, not time-weighted claims about unobserved work between polls. */
export function summarizeGpuSamples(samples: JobGpuSample[], start: number, end: number, intervalMs: number): GpuDeviceSummary[] {
  const devices = new Map<string, Map<number, JobGpuSample>>();
  for (const sample of samples) {
    if (sample.timestamp < start || sample.timestamp >= end) continue;
    const points = devices.get(sample.deviceId) ?? new Map<number, JobGpuSample>();
    points.set(sample.timestamp, sample);
    devices.set(sample.deviceId, points);
  }
  return [...devices].map(([deviceId, points]) => {
    const sorted = [...points.values()].sort((a, b) => a.timestamp - b.timestamp);
    const utilization = sorted.flatMap((p) => p.utilization === null ? [] : [p.utilization]);
    const memory = sorted.flatMap((p) => p.memoryUsedBytes === null ? [] : [p.memoryUsedBytes]);
    // Count occupied sampling buckets, so duplicate/closely spaced observations
    // cannot conceal missing intervals. This is sampling coverage, not GPU busy time.
    const covered = new Set(sorted.filter((p) => p.utilization !== null).map((p) => Math.floor((p.timestamp - start) / intervalMs))).size;
    return {
      deviceId, index: sorted[0].index, name: sorted[0].name, samples: sorted,
      meanUtilization: utilization.length ? utilization.reduce((a, b) => a + b, 0) / utilization.length : null,
      peakMemoryBytes: memory.length ? Math.max(...memory) : null,
      coverage: Math.min(1, covered / Math.max(1, Math.ceil((end - start) / intervalMs))),
    };
  }).sort((a, b) => a.index - b.index || a.deviceId.localeCompare(b.deviceId));
}

/** The agent API uses the same missing-data and coverage rules as the charts. */
export function compactGpuSummary(samples: JobGpuSample[], start: number, end: number, intervalMs: number) {
  return summarizeGpuSamples(samples, start, end, intervalMs).map(device => ({
    deviceId: device.deviceId, index: device.index, name: device.name,
    sampleCount: device.samples.length,
    utilizationSampleCount: device.samples.filter(sample => sample.utilization !== null).length,
    meanUtilizationPercent: device.meanUtilization,
    peakMemoryBytes: device.peakMemoryBytes,
    utilizationCoverage: device.coverage,
    firstSampleAt: new Date(device.samples[0].timestamp).toISOString(),
    lastSampleAt: new Date(device.samples[device.samples.length - 1].timestamp).toISOString(),
  }));
}

/** Never connect across missing readings or collection/upload gaps. */
export function gpuSegments(samples: JobGpuSample[], metric: "utilization" | "memoryUsedBytes", intervalMs: number): JobGpuSample[][] {
  const segments: JobGpuSample[][] = [];
  let current: JobGpuSample[] = [];
  for (const point of samples) {
    if (point[metric] === null || (current.length && point.timestamp - current[current.length - 1].timestamp > intervalMs * 2.5)) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (point[metric] !== null) current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}
