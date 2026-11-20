// Queue snapshots come from /api/cron/poll-metrics every 5 minutes. When that
// cron stops (as when CRON_SECRET went missing in production), the Queue page
// must say its data is stale instead of quietly showing zeros.

/** Two missed polls and a margin: older than this, the data is stale. */
export const QUEUE_STALE_AFTER_MS = 15 * 60_000;

/**
 * How long ago the last queue poll was, when that is long enough to warn
 * about, else null. No poll at all is always stale.
 */
export function staleQueueDataAge(
  lastPolledAt: string | null | undefined,
  now: number = Date.now(),
): { ms: number | null; label: string } | null {
  if (!lastPolledAt) return { ms: null, label: "no queue poll has been recorded" };
  const ms = now - new Date(lastPolledAt).getTime();
  if (!Number.isFinite(ms) || ms < QUEUE_STALE_AFTER_MS) return null;
  const mins = Math.round(ms / 60_000);
  const age =
    mins < 60
      ? `${mins}m`
      : mins < 48 * 60
        ? `${Math.floor(mins / 60)}h ${mins % 60}m`
        : `${Math.round(mins / 1440)}d`;
  return { ms, label: `the last Buildkite queue poll was ${age} ago` };
}
