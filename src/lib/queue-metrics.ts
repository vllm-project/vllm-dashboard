export const QUEUE_METRICS_MAX_AGE_MS = 20 * 60 * 1000;

export function queueBucketMinutes(hours: number): number {
  return hours <= 6 ? 5 : hours <= 24 ? 15 : hours <= 168 ? 60 : 360;
}

export function isQueueMetricFresh(polledAt: string, now: number): boolean {
  const age = now - Date.parse(polledAt);
  return Number.isFinite(age) && age <= QUEUE_METRICS_MAX_AGE_MS && age >= -60_000;
}
