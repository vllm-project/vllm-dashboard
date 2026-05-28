// Docker-plugin queues (AWS Elastic CI Stack, auto-scaled VMs).
// jobs_waiting from the Buildkite Agent Metrics API is inaccurate for these
// because it counts jobs waiting for VMs that haven't booted yet.
// Only jobs_scheduled reflects actual waiting jobs.
//
// Kubernetes / bare-metal queues (mithril-h100-pool, a100_queue, hardware
// queues, etc.) have persistent agents, so jobs_waiting is accurate.
// Queues where jobs_waiting under-reports because some waiting jobs show up
// only in jobs_scheduled.  Effective waiting = jobs_scheduled + jobs_waiting.
export const SCHEDULED_PLUS_WAITING_QUEUES = new Set<string>([
]);

// Kubernetes queues where jobs_waiting is not meaningful.
// Only jobs_scheduled reflects actual waiting jobs.
export const K8S_SCHEDULED_QUEUES = new Set([
  "b200-k8s",
  "mithril-h100-pool",
]);

export const DOCKER_PLUGIN_QUEUES = new Set([
  "gpu_1_queue",
  "gpu_4_queue",
  "B200",
  "H200",
  "h200_18gb",
  "cpu_queue_premerge",
  "cpu_queue_postmerge",
  "cpu_queue_premerge_us_east_1",
  "cpu_queue_postmerge_us_east_1",
  "small_cpu_queue_premerge",
  "small_cpu_queue_postmerge",
  "medium_cpu_queue_premerge",
  "arm64_cpu_queue_premerge",
  "arm64_cpu_queue_postmerge",
  "cpu_queue_release",
  "arm64_cpu_queue_release",
  "small_cpu_queue_release",
]);

/** Return the effective waiting-job count for a queue. */
export function effectiveWaiting(queue: string, jobsScheduled: number, jobsWaiting: number): number {
  if (DOCKER_PLUGIN_QUEUES.has(queue)) return jobsScheduled;
  if (K8S_SCHEDULED_QUEUES.has(queue)) return jobsScheduled;
  if (SCHEDULED_PLUS_WAITING_QUEUES.has(queue)) return jobsScheduled + jobsWaiting;
  return jobsWaiting;
}
