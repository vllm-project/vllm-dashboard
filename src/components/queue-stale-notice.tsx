"use client";

import { staleQueueDataAge } from "@/lib/queue-freshness";

/** Warns when the queue data on the page is from an old poll (or none). */
export function QueueStaleNotice({
  lastPolledAt,
}: {
  lastPolledAt: string | null | undefined;
}) {
  const stale = staleQueueDataAge(lastPolledAt);
  if (!stale) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <strong>Queue data is stale:</strong> {stale.label}
      {lastPolledAt && ` (${new Date(lastPolledAt).toLocaleString()})`}. The
      numbers below are from that poll. The{" "}
      <code>/api/cron/poll-metrics</code> job, which polls Buildkite every 5
      minutes, is probably failing; check its runs in Vercel.
    </div>
  );
}
