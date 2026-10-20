/**
 * Read the per-queue state stored in `alert_summary.queues`. Rows written
 * with a JSON.stringify'd parameter hold a jsonb *string* rather than an
 * object, which made every later run of the day fail; accept both so those
 * rows keep working, and fall back to empty state for anything else.
 */
export function parseQueueStates<T>(stored: unknown): Record<string, T> {
  let value = stored;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, T>) };
}
