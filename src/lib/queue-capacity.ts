import { effectiveWaiting } from "./queue-plugins";

export type AmdHardwareFamily = "MI250" | "MI300" | "MI355" | "AMD CPU";
export type CudaHardwareFamily =
  | "GPU"
  | "A100"
  | "H100"
  | "H200"
  | "B200"
  | "B300"
  | "GB300"
  | "GH200"
  | "L4"
  | "DGX Spark";
export type QueueFamily =
  | AmdHardwareFamily
  | CudaHardwareFamily
  | "Other ROCm"
  | "Other";
export type QueueGroup = "all" | "cuda" | "rocm";

export interface QueueMetric {
  queue: string;
  agents_total: number;
  agents_busy: number;
  jobs_running: number;
  jobs_scheduled: number;
  jobs_waiting: number;
  p95_wait_secs?: number | null;
  polled_at?: string;
  time_bucket?: string;
}

export interface CapacityAllocation {
  id: string;
  queue: string;
  family: AmdHardwareFamily;
  maxInFlight: number;
  gpusPerJob: number | null;
  gpuCount: number | null;
  nodeEquivalent: number | null;
}

function allocation(
  queue: string,
  family: AmdHardwareFamily,
  maxInFlight: number,
  gpusPerJob: number | null,
  gpuCount: number | null = gpusPerJob === null
    ? null
    : maxInFlight * gpusPerJob,
): CapacityAllocation {
  return {
    id: queue,
    queue,
    family,
    maxInFlight,
    gpusPerJob,
    gpuCount,
    nodeEquivalent:
      family === "AMD CPU"
        ? maxInFlight / 8
        : gpuCount === null
          ? null
          : gpuCount / 8,
  };
}

// User-supplied allocation table. GPU node equivalents assume eight GPUs;
// CPU host equivalents use the table's eight jobs per host.
export const QUEUE_CAPACITY: readonly CapacityAllocation[] = [
  allocation("amd_mi250_1", "MI250", 78, 1),
  allocation("amd_mi250_2", "MI250", 24, 2),
  allocation("amd_mi250_4", "MI250", 16, 4),
  allocation("amd_mi250_8", "MI250", 2, 8),
  allocation("amd-cpu", "AMD CPU", 30, null),
  allocation("amd_mi300_1", "MI300", 227, 1),
  allocation("amd_mi300_2", "MI300", 32, 2),
  allocation("amd_mi300_4", "MI300", 17, 4),
  allocation("amd_mi300_8", "MI300", 2, 8),
  allocation("mi300_perf_eval", "MI300", 1, 8),
  allocation("amd_mi355_1", "MI355", 80, 1),
  allocation("amd_mi355_2", "MI355", 24, 2),
  allocation("amd_mi355_4", "MI355", 42, 4),
  allocation("amd_mi355_8", "MI355", 3, 8),
  allocation("amd_mi355_dpx", "MI355", 240, null, 120),
  allocation("mi355_perf_eval", "MI355", 3, 8),
];

export interface QueueCapacity {
  family: AmdHardwareFamily;
  maxInFlight: number;
  gpusPerJob: number | null;
  gpuCount: number | null;
  nodeEquivalent: number | null;
  allocations: readonly CapacityAllocation[];
}

export function canonicalQueue(queue: string): string {
  if (queue === "amd_cpu") return "amd-cpu";
  if (/^mi(?:250|300|355)_[1248]$/.test(queue)) return `amd_${queue}`;
  return queue;
}

/** Look up supplied allocations; unknown limits remain unknown. */
export function getQueueCapacity(queue: string): QueueCapacity | null {
  const canonical = canonicalQueue(queue);
  const allocations = QUEUE_CAPACITY.filter(
    (row) => row.queue === canonical,
  );
  if (allocations.length === 0) return null;
  return {
    family: allocations[0].family,
    maxInFlight: allocations.reduce((sum, row) => sum + row.maxInFlight, 0),
    gpusPerJob: allocations[0].gpusPerJob,
    gpuCount: allocations.every((row) => row.gpuCount !== null)
      ? allocations.reduce((sum, row) => sum + row.gpuCount!, 0)
      : null,
    nodeEquivalent: allocations.every((row) => row.nodeEquivalent !== null)
      ? allocations.reduce((sum, row) => sum + row.nodeEquivalent!, 0)
      : null,
    allocations,
  };
}

export function isAmdQueue(queue: string): boolean {
  return /^(?:amd[-_]|mi\d+(?:_|$)|router_rocm(?:_|$))/i.test(queue);
}

// Match known CUDA queues explicitly; vendor names alone do not imply GPUs.
const CUDA_QUEUE_FAMILIES = new Map<string, CudaHardwareFamily>([
  ["gpu1", "GPU"],
  ["gpu4", "GPU"],
  ["gpu8", "GPU"],
  ["gpu_1_queue", "GPU"],
  ["gpu_4_queue", "GPU"],
  ["gpu_8_queue", "GPU"],
  ["a100", "A100"],
  ["a100_queue", "A100"],
  ["moc-a100", "A100"],
  ["redhat-a100-wdc", "A100"],
  ["h100", "H100"],
  ["mithril-h100-pool", "H100"],
  ["redhat-h100-frankfurt", "H100"],
  ["redhat-h100-wdc", "H100"],
  ["h200", "H200"],
  ["h200_18gb", "H200"],
  ["h200_35gb", "H200"],
  ["b200", "B200"],
  ["b200-k8s", "B200"],
  ["b300-8", "B300"],
  ["gb300-slurm", "GB300"],
  ["gh200", "GH200"],
  ["gh200_queue", "GH200"],
  ["l4", "L4"],
  ["l4-k8s", "L4"],
  ["redhat-l4", "L4"],
  ["redhat-l4-gcp", "L4"],
  ["dgx-spark", "DGX Spark"],
]);

const CUDA_VIEW_EXCLUDED_QUEUES = new Set([
  "gpu1",
  "gpu_1_queue",
  "h100",
  "moc-a100",
  "redhat-h100-frankfurt",
  "redhat-l4",
  "b300-8",
  "gb300-slurm",
  "a100",
  "a100_queue",
  "redhat-a100-wdc",
  "redhat-h100-wdc",
  "gh200",
  "gh200_queue",
]);

export function isCudaQueue(queue: string): boolean {
  const normalized = queue.toLowerCase();
  return (
    CUDA_QUEUE_FAMILIES.has(normalized) &&
    !CUDA_VIEW_EXCLUDED_QUEUES.has(normalized)
  );
}

export const CUDA_FAMILIES: readonly CudaHardwareFamily[] = [
  ...new Set(
    [...CUDA_QUEUE_FAMILIES]
      .filter(([queue]) => isCudaQueue(queue))
      .map(([, family]) => family),
  ),
];

export const QUEUE_FAMILIES: readonly QueueFamily[] = [
  ...new Set<QueueFamily>([
    ...CUDA_QUEUE_FAMILIES.values(),
    ...QUEUE_CAPACITY.map((row) => row.family),
    "Other ROCm",
    "Other",
  ]),
];

const ROCM_VIEW_EXCLUDED_QUEUES = new Set([
  "amd_gfx950",
  "amd_mi250_8",
  "amd_mi325_1",
  "amd_mi325_2",
  "amd_mi325_4",
  "amd_mi325_8",
  "amd_mi350_ainic",
  "amd_mi355_vime_rl",
  "amd_shadow",
  "amd-cpu",
  "amd-cpu-medium",
  "amd-cpu-small",
  "amd-zen5-cpu",
  "mi300_perf_eval",
  "mi355_perf_eval",
  "router_rocm_mi300_2",
]);

export function queueFamily(queue: string): QueueFamily {
  const capacity = getQueueCapacity(queue);
  if (capacity) return capacity.family;
  if (/^amd[-_](?:.*[-_])?cpu(?:[-_]|$)/i.test(queue)) return "AMD CPU";
  if (/^(?:amd_|router_rocm_)?mi250(?:_|$)/i.test(queue)) return "MI250";
  if (/^(?:amd_|router_rocm_)?mi300(?:_|$)/i.test(queue)) return "MI300";
  if (/^(?:amd_|router_rocm_)?mi355(?:_|$)/i.test(queue)) return "MI355";
  return (
    CUDA_QUEUE_FAMILIES.get(queue.toLowerCase()) ??
    (isAmdQueue(queue) ? "Other ROCm" : "Other")
  );
}

export function filterQueues<T extends { queue: string }>(
  rows: readonly T[],
  group: QueueGroup = "all",
  family: QueueFamily | "all" = "all",
): T[] {
  return rows.filter(
    (row) =>
      (group === "all" ||
        (group === "cuda"
          ? isCudaQueue(row.queue)
          : isAmdQueue(row.queue) &&
            !ROCM_VIEW_EXCLUDED_QUEUES.has(canonicalQueue(row.queue)))) &&
      (family === "all" || queueFamily(row.queue) === family),
  );
}

export interface QueueTrafficSummary {
  queueCount: number;
  running: number;
  waiting: number;
  jobLimitUtilization: number | null;
  knownQueueCount: number;
  unknownQueueCount: number;
  unknownQueues: string[];
  maxInFlight: number;
  knownRunning: number;
  nearLimitQueueCount: number;
  waitingQueueCount: number;
}

function percent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

export function getQueueWaitP95(row: QueueMetric): number | null {
  const value = row.p95_wait_secs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function uniqueQueueReadings<T extends QueueMetric>(
  rows: readonly T[],
): T[] {
  const readings = new Map<string, T>();
  for (const row of rows) {
    const key = canonicalQueue(row.queue);
    const previous = readings.get(key);
    const timestamp = Date.parse(row.polled_at ?? row.time_bucket ?? "") || 0;
    const previousTimestamp = previous
      ? Date.parse(previous.polled_at ?? previous.time_bucket ?? "") || 0
      : 0;
    if (
      !previous ||
      timestamp > previousTimestamp ||
      (timestamp === previousTimestamp && row.queue === key)
    ) {
      readings.set(key, row);
    }
  }
  return [...readings.values()];
}

/** Summarize one reading per queue; all utilization values are percentages. */
export function summarizeQueues(
  rows: readonly QueueMetric[],
): QueueTrafficSummary {
  let running = 0;
  let waiting = 0;
  let maxInFlight = 0;
  let knownRunning = 0;
  let knownQueueCount = 0;
  let nearLimitQueueCount = 0;
  let waitingQueueCount = 0;
  const unknownQueues: string[] = [];
  const readings = uniqueQueueReadings(rows);

  for (const row of readings) {
    running += row.jobs_running;
    const queueWaiting = effectiveWaiting(
      row.queue,
      row.jobs_scheduled,
      row.jobs_waiting,
    );
    waiting += queueWaiting;
    if (queueWaiting > 0) waitingQueueCount += 1;
    const capacity = getQueueCapacity(row.queue);
    if (!capacity) {
      unknownQueues.push(row.queue);
      continue;
    }
    knownQueueCount += 1;
    maxInFlight += capacity.maxInFlight;
    knownRunning += row.jobs_running;
    if (row.jobs_running / capacity.maxInFlight >= 0.9)
      nearLimitQueueCount += 1;
  }

  return {
    queueCount: readings.length,
    running,
    waiting,
    jobLimitUtilization: percent(knownRunning, maxInFlight),
    knownQueueCount,
    unknownQueueCount: unknownQueues.length,
    unknownQueues,
    maxInFlight,
    knownRunning,
    nearLimitQueueCount,
    waitingQueueCount,
  };
}

export interface TrafficHistoryPoint {
  time: number;
  running: number | null;
  waiting: number | null;
  maxInFlight: number | null;
  limitUtilization: number | null;
}

function historyBucketMs(hours: number): number {
  const minutes = hours <= 6 ? 5 : hours <= 24 ? 15 : hours <= 168 ? 60 : 360;
  return minutes * 60_000;
}

/** Leave incomplete polling buckets empty instead of implying idle capacity. */
export function buildTrafficHistory(
  rows: readonly (QueueMetric & { time_bucket: string })[],
  hours: number,
  expectedQueues: readonly string[],
): TrafficHistoryPoint[] {
  const expected = new Set(expectedQueues.map(canonicalQueue));
  if (expected.size === 0) return [];
  const bucketMs = historyBucketMs(hours);
  const buckets = new Map<number, QueueMetric[]>();
  for (const row of rows) {
    if (!expected.has(canonicalQueue(row.queue))) continue;
    const timestamp = Date.parse(row.time_bucket);
    if (!Number.isFinite(timestamp)) continue;
    const time = Math.floor(timestamp / bucketMs) * bucketMs;
    const bucket = buckets.get(time) ?? [];
    bucket.push(row);
    buckets.set(time, bucket);
  }
  const times = [...buckets.keys()].sort((a, b) => a - b);
  if (times.length === 0) return [];

  const result: TrafficHistoryPoint[] = [];
  for (let time = times[0]; time <= times[times.length - 1]; time += bucketMs) {
    const readings = uniqueQueueReadings(buckets.get(time) ?? []);
    const summary =
      readings.length === expected.size ? summarizeQueues(readings) : null;
    result.push({
      time,
      running: summary?.running ?? null,
      waiting: summary?.waiting ?? null,
      maxInFlight:
        summary && summary.maxInFlight > 0 ? summary.maxInFlight : null,
      limitUtilization: summary?.jobLimitUtilization ?? null,
    });
  }
  return result;
}

export interface QueueActivitySample {
  time: number;
  utilization: number | null;
  waiting: number | null;
  running: number | null;
  waitP95: number | null;
}

export interface QueueActivityRow {
  queue: string;
  samples: QueueActivitySample[];
  averageRunning: number | null;
  /** Mean of this queue's reported bucket P95 values, not an overall percentile. */
  averageWaitP95: number | null;
  peakWaitP95: number | null;
  waitObservedBuckets: number;
  waitCoveragePercent: number;
  averageUtilization: number | null;
  nearLimitPercent: number | null;
  coveragePercent: number;
  observedBuckets: number;
  expectedBuckets: number;
}

/** Summarize each queue's observations, leaving unobserved buckets empty. */
export function buildQueueActivity(
  rows: readonly (QueueMetric & { time_bucket: string })[],
  hours: number,
  expectedQueues: readonly string[],
  now?: number,
): QueueActivityRow[] {
  const queues = [...new Set(expectedQueues.map(canonicalQueue))];
  if (queues.length === 0 || !Number.isFinite(hours) || hours <= 0) return [];

  const expected = new Set(queues);
  const bucketMs = historyBucketMs(hours);
  const buckets = new Map<number, QueueMetric[]>();
  let latestTime: number | undefined;
  for (const row of rows) {
    if (!expected.has(canonicalQueue(row.queue))) continue;
    const timestamp = Date.parse(row.time_bucket);
    if (!Number.isFinite(timestamp)) continue;
    const time = Math.floor(timestamp / bucketMs) * bucketMs;
    const bucket = buckets.get(time) ?? [];
    bucket.push(row);
    buckets.set(time, bucket);
    latestTime = latestTime === undefined ? time : Math.max(latestTime, time);
  }

  const end =
    now === undefined ? latestTime : Math.floor(now / bucketMs) * bucketMs;
  const expectedBuckets =
    end === undefined ? 0 : Math.ceil((hours * 3_600_000) / bucketMs);
  const readings = new Map<number, Map<string, QueueMetric>>();
  for (const [time, bucket] of buckets) {
    readings.set(
      time,
      new Map(
        uniqueQueueReadings(bucket).map((row) => [
          canonicalQueue(row.queue),
          row,
        ]),
      ),
    );
  }

  return queues.map((queue) => {
    const capacity = getQueueCapacity(queue);
    const samples: QueueActivitySample[] = [];
    let observedBuckets = 0;
    let runningTotal = 0;
    let utilizationTotal = 0;
    let nearLimitBuckets = 0;
    let waitTotal = 0;
    let peakWaitP95: number | null = null;
    let waitObservedBuckets = 0;
    let waitCoveredBuckets = 0;
    for (let index = 0; index < expectedBuckets; index += 1) {
      const time = end! - (expectedBuckets - index - 1) * bucketMs;
      const row = readings.get(time)?.get(queue);
      const utilization =
        row && capacity
          ? percent(row.jobs_running, capacity.maxInFlight)
          : null;
      const waiting = row
        ? effectiveWaiting(queue, row.jobs_scheduled, row.jobs_waiting)
        : null;
      // Historical counts may round to zero while the bucket retains a P95.
      const waitP95 = row ? getQueueWaitP95(row) : null;
      if (row) {
        observedBuckets += 1;
        runningTotal += row.jobs_running;
      }
      if (utilization !== null) {
        utilizationTotal += utilization;
        if (utilization >= 90) nearLimitBuckets += 1;
      }
      if (waitP95 !== null) {
        waitTotal += waitP95;
        peakWaitP95 = Math.max(peakWaitP95 ?? 0, waitP95);
        waitObservedBuckets += 1;
      }
      if (waitP95 !== null || waiting === 0) waitCoveredBuckets += 1;
      samples.push({
        time,
        utilization,
        waiting,
        running: row?.jobs_running ?? null,
        waitP95,
      });
    }
    return {
      queue,
      samples,
      averageRunning: observedBuckets > 0 ? runningTotal / observedBuckets : null,
      averageWaitP95:
        waitObservedBuckets > 0 ? waitTotal / waitObservedBuckets : null,
      peakWaitP95,
      waitObservedBuckets,
      waitCoveragePercent: percent(waitCoveredBuckets, expectedBuckets) ?? 0,
      averageUtilization:
        capacity && observedBuckets > 0
          ? utilizationTotal / observedBuckets
          : null,
      nearLimitPercent: capacity
        ? percent(nearLimitBuckets, observedBuckets)
        : null,
      coveragePercent: percent(observedBuckets, expectedBuckets) ?? 0,
      observedBuckets,
      expectedBuckets,
    };
  });
}
