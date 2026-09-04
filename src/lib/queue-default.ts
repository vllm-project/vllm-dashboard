import { effectiveWaiting } from "./queue-plugins";

// Queue shown when no summary data is available to pick a busier one.
export const DEFAULT_QUEUE = "gpu_1_queue";

export const DEFAULT_QUEUE_RANGE_HOURS = 24;

export interface QueueSummaryRow {
  queue: string;
  agents_total: number;
  jobs_scheduled: number;
  jobs_waiting: number;
}

/**
 * Pick the queue to show when the URL names none: the one with the most
 * waiting jobs, then the most agents, then DEFAULT_QUEUE when the summary
 * is empty.
 */
export function pickDefaultQueue(latest: readonly QueueSummaryRow[]): string {
  let best: QueueSummaryRow | null = null;
  for (const row of latest) {
    if (!best) {
      best = row;
      continue;
    }
    const waiting = effectiveWaiting(row.queue, row.jobs_scheduled, row.jobs_waiting);
    const bestWaiting = effectiveWaiting(best.queue, best.jobs_scheduled, best.jobs_waiting);
    if (
      waiting > bestWaiting ||
      (waiting === bestWaiting && row.agents_total > best.agents_total)
    ) {
      best = row;
    }
  }
  return best?.queue ?? DEFAULT_QUEUE;
}

/**
 * Parse the `range` URL param into one of the allowed hour windows.
 * Returns null when the param is missing or not a known option.
 */
export function parseQueueRangeParam(
  value: string | null,
  allowedHours: readonly number[],
): number | null {
  if (value === null) return null;
  const hours = Number(value);
  return allowedHours.includes(hours) ? hours : null;
}
