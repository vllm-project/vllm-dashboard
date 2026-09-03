import { useState } from "react";
import { NotificationBadge } from "@/components/alert-notification-badge";
import { AlertPagination } from "@/components/alert-pagination";
import { JobName } from "@/components/job-name";
import {
  type FastFailureEventView,
  type FastFailureGroup,
  type FastFailureJobGroup,
} from "@/lib/alerts-fast-ci";
import {
  commitUrl,
  formatAlertDateTime,
  pullRequestUrl,
} from "@/lib/alerts-shared";

function EventRow({ event }: { event: FastFailureEventView }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-5">
      <a
        href={event.jobUrl}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 truncate text-blue-600 hover:underline dark:text-blue-400"
      >
        <JobName name={event.jobName} />
      </a>
      <span className="shrink-0 text-xs font-medium text-red-600 dark:text-red-400">
        {event.state}
      </span>
      {event.softFailed && (
        <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
          soft failed
        </span>
      )}
      <span className="shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
        {event.durationSeconds}s
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {formatAlertDateTime(event.finishedAt)}
        </span>
        <NotificationBadge state={event.notificationState} />
      </span>
    </li>
  );
}

/**
 * One row per job. A job that failed repeatedly shows the latest attempt with
 * a "×N" badge and the worst Slack state across attempts; the individual
 * attempts stay available behind a disclosure.
 */
function JobGroupRow({ jobGroup }: { jobGroup: FastFailureJobGroup }) {
  const latest = jobGroup.events[0];

  if (jobGroup.count === 1) {
    return <EventRow event={latest} />;
  }

  return (
    <li>
      <details className="group/details">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-5 [&::-webkit-details-marker]:hidden">
          <span
            aria-hidden="true"
            className="shrink-0 text-xs text-zinc-400 transition-transform group-open/details:rotate-90 dark:text-zinc-500"
          >
            ›
          </span>
          <a
            href={latest.jobUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="min-w-0 truncate text-blue-600 hover:underline dark:text-blue-400"
          >
            <JobName name={jobGroup.jobName} />
          </a>
          <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 text-xs font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            ×{jobGroup.count}
          </span>
          <span className="shrink-0 text-xs font-medium text-red-600 dark:text-red-400">
            {latest.state}
          </span>
          {latest.softFailed && (
            <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
              soft failed
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-3">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {formatAlertDateTime(jobGroup.lastFinishedAt)}
            </span>
            <NotificationBadge state={jobGroup.notificationState} />
          </span>
        </summary>
        <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800/60 dark:border-zinc-800/60">
          {jobGroup.events.map((event) => (
            <EventRow key={event.buildkiteJobId} event={event} />
          ))}
        </ul>
      </details>
    </li>
  );
}

/** Past this many distinct jobs, the rest of a build stays collapsed. */
const VISIBLE_JOB_GROUPS = 10;

function GroupCard({ group }: { group: FastFailureGroup }) {
  const prUrl = pullRequestUrl(group.prNumber);
  const [showAllJobs, setShowAllJobs] = useState(false);

  const jobGroups = showAllJobs
    ? group.jobGroups
    : group.jobGroups.slice(0, VISIBLE_JOB_GROUPS);

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-zinc-200 px-4 py-3 sm:px-5 dark:border-zinc-800">
        <a
          href={commitUrl(group.commitSha)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-base font-semibold tracking-tight text-blue-600 hover:underline dark:text-blue-400"
        >
          {group.commitSha.slice(0, 7)}
        </a>
        <a
          href={group.buildUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Buildkite build
        </a>
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            PR #{group.prNumber}
          </a>
        )}
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {group.pipeline} · {group.branch} · {group.author}
        </span>
        <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
          {group.events.length} fast{" "}
          {group.events.length === 1 ? "failure" : "failures"} ·{" "}
          {formatAlertDateTime(group.latestFinishedAt)}
        </span>
        <p className="w-full truncate text-xs text-zinc-500 dark:text-zinc-400">
          {group.message}
        </p>
      </div>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {jobGroups.map((jobGroup) => (
          <JobGroupRow key={jobGroup.key} jobGroup={jobGroup} />
        ))}
      </ul>
      {group.jobGroups.length > VISIBLE_JOB_GROUPS && (
        <div className="border-t border-zinc-100 px-4 py-2 sm:px-5 dark:border-zinc-800/60">
          <button
            type="button"
            onClick={() => setShowAllJobs((value) => !value)}
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            {showAllJobs
              ? "Show fewer jobs"
              : `Show all ${group.jobGroups.length} jobs`}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Fast Failure Events are immutable observations, so this view reports them and
 * their Slack notification state only. It deliberately exposes no resolution,
 * acknowledgement, or suppression controls.
 *
 * A busy week can produce hundreds of groups, so the list is paginated rather
 * than rendered to the end.
 */
const PAGE_SIZE = 10;

export function FastCIAlerts({
  groups,
  showSoftFailed = false,
}: {
  groups: FastFailureGroup[];
  showSoftFailed?: boolean;
}) {
  const [page, setPage] = useState(0);

  if (groups.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-zinc-300 text-sm text-zinc-400 dark:border-zinc-700">
        {showSoftFailed
          ? "No Fast CI failures were recorded in this window."
          : "No hard Fast CI failures were recorded in this window; soft failures are hidden."}
      </div>
    );
  }

  const pageCount = Math.ceil(groups.length / PAGE_SIZE);
  const currentPage = Math.min(page, pageCount - 1);
  const pageGroups = groups.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );

  return (
    <div className="space-y-3">
      {pageGroups.map((group) => (
        <GroupCard key={group.key} group={group} />
      ))}
      <AlertPagination
        currentPage={currentPage}
        pageCount={pageCount}
        total={groups.length}
        unit={{ one: "group", many: "groups" }}
        onPageChange={setPage}
      />
    </div>
  );
}
