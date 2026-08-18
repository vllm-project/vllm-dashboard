"use client";

import { useState } from "react";
import useSWR from "swr";

export interface QueueJob {
  uuid: string;
  label: string | null;
  url: string;
  scheduledAt: string;
  priority: number;
}

export interface QueueJobsResponse {
  jobs: QueueJob[];
  waitingCount: number | null;
  operatorAccessRequired: boolean;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T & { error?: string };

  if (!response.ok || body.error) {
    throw new Error(body.error ?? `Request failed with status ${response.status}`);
  }

  return body;
}

function formatScheduledAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function useQueueWaitingJobs(queue: string) {
  const url = queue ? `/api/queue/jobs?queue=${encodeURIComponent(queue)}` : null;
  return useSWR<QueueJobsResponse>(url, fetchJson, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  });
}

export function QueueWaitingJobs({
  queue,
  query,
}: {
  queue: string;
  query: ReturnType<typeof useQueueWaitingJobs>;
}) {
  const [operatorToken, setOperatorToken] = useState("");
  const [showAccess, setShowAccess] = useState(false);
  const [pendingJobUuid, setPendingJobUuid] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data, error, isLoading, isValidating, mutate } = query;

  async function promote(job: QueueJob) {
    if (!operatorToken) {
      setShowAccess(true);
      setNotice("Enter the queue operator token to enable promotions.");
      return;
    }

    const name = job.label || "this job";
    if (!window.confirm(`Move ${name} to the front of ${queue}? Its priority will be calculated from the current queue.`)) {
      return;
    }

    setPendingJobUuid(job.uuid);
    setNotice(null);
    try {
      const response = await fetch("/api/queue/jobs/reprioritize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Queue-Operator-Token": operatorToken,
        },
        body: JSON.stringify({ queue, jobUuid: job.uuid }),
      });
      const body = (await response.json()) as { priority?: number; error?: string };
      if (!response.ok || body.error || body.priority === undefined) {
        if (response.status === 401) setOperatorToken("");
        throw new Error(body.error ?? "This job could not be promoted.");
      }

      setNotice(`${job.label || "Job"} moved to the front at priority ${body.priority}.`);
      await mutate();
    } catch (promotionError) {
      setNotice(promotionError instanceof Error ? promotionError.message : "This job could not be promoted.");
    } finally {
      setPendingJobUuid(null);
    }
  }

  const canPromote = Boolean(data?.operatorAccessRequired && operatorToken);
  const showTable = Boolean(data && (data.jobs.length > 0 || isValidating || error));
  const reportedWaitingCount = data?.waitingCount ?? data?.jobs.length;
  const hasReservedJobs = Boolean(data && data.waitingCount !== null && data.waitingCount > data.jobs.length);

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight">Waiting jobs</h2>
              {data && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                  {reportedWaitingCount}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {queue} · priority first, then earliest scheduled
            </p>
          </div>
          <div className="flex min-h-5 items-center text-xs" role="status" aria-live="polite">
            {isValidating && data && !error && (
              <span className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                <span
                  className="h-3 w-3 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600 motion-reduce:animate-none dark:border-blue-900 dark:border-t-blue-400"
                  aria-hidden="true"
                />
                Updating queue
              </span>
            )}
            {error && data && (
              <span className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                Refresh paused — showing saved jobs
                <button
                  type="button"
                  onClick={() => void mutate()}
                  className="font-medium underline underline-offset-2"
                >
                  Retry
                </button>
              </span>
            )}
          </div>
        </div>

        {data?.operatorAccessRequired && data.jobs.length > 0 ? (
          <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800/80">
            <button
              type="button"
              onClick={() => setShowAccess((open) => !open)}
              aria-expanded={showAccess}
              className="dashboard-control text-xs font-medium text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {operatorToken ? "Operator access enabled for this tab" : "Unlock promotion actions"}
            </button>
            {showAccess && (
              <label className="mt-2 flex max-w-md flex-col gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 sm:flex-row sm:items-center">
                <span className="shrink-0">Operator token</span>
                <input
                  type="password"
                  value={operatorToken}
                  onChange={(event) => setOperatorToken(event.target.value)}
                  autoComplete="off"
                  className="min-h-10 min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-900 shadow-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </label>
            )}
          </div>
        ) : data && !hasReservedJobs ? (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
            Promotion is disabled until BUILDKITE_QUEUE_OPERATOR_TOKEN is configured on the dashboard.
          </p>
        ) : null}

        {notice && (
          <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300" role="status">
            {notice}
          </p>
        )}
      </div>

      {isLoading && !data && (
        <div className="flex min-h-36 items-center justify-center px-5 text-sm text-zinc-500 dark:text-zinc-400">
          Loading waiting jobs…
        </div>
      )}

      {error && !data && (
        <div className="flex min-h-36 flex-col items-center justify-center gap-3 px-5 text-center text-sm text-zinc-500 dark:text-zinc-400">
          <p>Waiting jobs couldn&apos;t be loaded.</p>
          <button
            type="button"
            onClick={() => void mutate()}
            className="dashboard-control rounded-md border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            Retry
          </button>
        </div>
      )}

      {data && data.jobs.length === 0 && !isValidating && !error && (
        <div className="flex min-h-36 items-center justify-center px-5 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {hasReservedJobs
            ? `Buildkite reports ${reportedWaitingCount} waiting jobs in ${queue}, but its Agent Stack has reserved them. The public API does not expose their individual details or priority.`
            : `No command jobs are waiting in ${queue}.`}
        </div>
      )}

      {showTable && data && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-[0.08em] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="w-16 px-5 py-3 font-medium">Order</th>
                <th className="px-5 py-3 font-medium">Job</th>
                <th className="px-5 py-3 font-medium">Priority</th>
                <th className="px-5 py-3 font-medium">Scheduled</th>
                <th className="px-5 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((job, index) => {
                const isPending = pendingJobUuid === job.uuid;
                const isFirst = index === 0;
                return (
                  <tr
                    key={job.uuid}
                    className={`border-b border-zinc-100 last:border-0 dark:border-zinc-800/50 ${isFirst ? "bg-amber-50/55 dark:bg-amber-950/15" : ""}`}
                  >
                    <td className="px-5 py-3 font-mono text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                      {String(index + 1).padStart(2, "0")}
                    </td>
                    <td className="max-w-md px-5 py-3">
                      <a
                        href={job.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate font-medium text-blue-700 hover:underline dark:text-blue-400"
                        title={job.label || job.uuid}
                      >
                        {job.label || "Unnamed command job"}
                      </a>
                      <span className="mt-0.5 block font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                        {job.uuid}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 font-mono text-xs tabular-nums ${isFirst ? "bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-200" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}>
                        {job.priority}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-zinc-600 dark:text-zinc-400">
                      {formatScheduledAt(job.scheduledAt)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => void promote(job)}
                        disabled={!canPromote || isPending}
                        title={
                          !data.operatorAccessRequired
                            ? "Promotion is not configured on this dashboard"
                            : !operatorToken
                              ? "Unlock promotion actions first"
                              : undefined
                        }
                        className="dashboard-control min-h-10 rounded-md border border-amber-300 bg-amber-50 px-3 text-xs font-semibold text-amber-900 hover:border-amber-400 hover:bg-amber-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-100 disabled:text-zinc-400 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/70 dark:disabled:border-zinc-800 dark:disabled:bg-zinc-900 dark:disabled:text-zinc-600"
                      >
                        {isPending ? "Moving…" : "Move to front"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && data.jobs.length > 0 && (
        <p className="border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Buildkite breaks identical priority and scheduled-time ties by pipeline upload order; that final tie-breaker is not exposed in this view.
        </p>
      )}
    </section>
  );
}
