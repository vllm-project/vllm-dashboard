import { useState } from "react";
import { NotificationBadge } from "@/components/alert-notification-badge";
import { AlertPagination } from "@/components/alert-pagination";
import { JobName } from "@/components/job-name";
import {
  CAUSE_LABELS,
  LIFECYCLE_LABELS,
  type FullCiComparisonView,
  type FullCiFailureCondition,
  type FullCiJobOutcome,
  type FullCiLifecycle,
  type FullCiRun,
  type PullRequestRef,
} from "@/lib/alerts-full-ci";
import {
  commitUrl,
  formatAlertDateTime,
  pullRequestUrl,
} from "@/lib/alerts-shared";

const LIFECYCLE_CLASSES: Record<FullCiLifecycle, string> = {
  new: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  recurring:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  fixed:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
};

/** An absent job is never a passing job, so it is named rather than blank. */
function outcomeLabel(outcome: FullCiJobOutcome | null): string {
  if (outcome === null) return "did not run";
  return outcome.softFailed ? `${outcome.state} (soft failed)` : outcome.state;
}

/** A failed run is the reason the card exists, so it is marked, not narrated. */
function RunState({ state }: { state: string }) {
  const failed = state.toLowerCase() === "failed";
  if (!failed) {
    return <span className="text-zinc-500 dark:text-zinc-400">{state}</span>;
  }
  // An inline-flex wrapper would take its own baseline and lift the whole
  // phrase off the line it sits in, so the icon is an inline box aligned to
  // the surrounding text instead.
  return (
    <span className="font-medium text-red-600 dark:text-red-400">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="mr-1 inline h-3 w-3 align-[-0.1em]"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
      >
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
      {state}
    </span>
  );
}

/**
 * What a run's commit actually changed. A scheduled run's Buildkite message
 * says only "Full CI run - nightly", so the pull request the analyzer resolved
 * for the head commit is the description worth showing; where no pull request
 * was recorded, a message ending in the "(#12345)" it merged is the next best
 * source, and the bare message is the fallback.
 */
function commitDescription(run: FullCiRun): {
  subject: string;
  pr: PullRequestRef | null;
} {
  if (run.commitPullRequest !== null) {
    return { subject: run.commitPullRequest.title, pr: run.commitPullRequest };
  }

  const subject = run.message.split("\n", 1)[0];
  const match = subject.match(/^(.*?)\s*\(#(\d+)\)\s*$/);
  if (match === null) return { subject, pr: null };

  const number = Number(match[2]);
  const url = pullRequestUrl(match[2]);
  if (url === null) return { subject: match[1], pr: null };
  return { subject: match[1], pr: { number, url, title: match[1] } };
}

function PullRequestLink({
  label,
  pr,
}: {
  label: string;
  pr: PullRequestRef | null;
}) {
  if (pr === null) return null;
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className="text-blue-600 hover:underline dark:text-blue-400"
      >
        #{pr.number}
      </a>
      <span className="text-zinc-500 dark:text-zinc-400">{pr.title}</span>
    </span>
  );
}

/** One side of the comparison: which build ran, when, and on what commit. */
function RunSummary({ label, run }: { label: string; run: FullCiRun }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <a
        href={run.buildUrl}
        target="_blank"
        rel="noreferrer"
        className="text-blue-600 hover:underline dark:text-blue-400"
      >
        build {run.buildNumber}
      </a>
      <a
        href={commitUrl(run.commitSha)}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-blue-600 hover:underline dark:text-blue-400"
      >
        {run.commitSha.slice(0, 7)}
      </a>
      <span className="text-zinc-500 dark:text-zinc-400">
        <RunState state={run.state} /> · {formatAlertDateTime(run.scheduledAt)}
      </span>
    </span>
  );
}

/** The two build numbers a condition's outcomes are read against. */
interface ComparedBuilds {
  previousBuildNumber: number;
  currentBuildNumber: number;
}

function ConditionRow({
  condition,
  builds,
}: {
  condition: FullCiFailureCondition;
  builds: ComparedBuilds;
}) {
  return (
    <li className="px-4 py-2.5 text-sm sm:px-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 truncate font-medium text-zinc-900 dark:text-zinc-100">
          <JobName name={condition.jobName} />
        </span>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${LIFECYCLE_CLASSES[condition.lifecycle]}`}
        >
          {LIFECYCLE_LABELS[condition.lifecycle]}
        </span>
        <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
          {CAUSE_LABELS[condition.cause]}
        </span>
      </div>

      {condition.summary && (
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
          {condition.summary}
        </p>
      )}

      <div className="mt-1 flex flex-col gap-y-0.5 text-xs">
        <span className="text-zinc-500 dark:text-zinc-400">
          build {builds.previousBuildNumber}:{" "}
          {outcomeLabel(condition.previousOutcome)} · build{" "}
          {builds.currentBuildNumber}: {outcomeLabel(condition.currentOutcome)}
        </span>
        <PullRequestLink label="Culprit PR" pr={condition.culpritPr} />
        <PullRequestLink label="Fixing PR" pr={condition.fixingPr} />
      </div>
    </li>
  );
}

function ConditionSection({
  title,
  emptyMessage,
  conditions,
  builds,
}: {
  title: string;
  emptyMessage: string;
  conditions: FullCiFailureCondition[];
  builds: ComparedBuilds;
}) {
  return (
    <section>
      <h3 className="border-b border-zinc-100 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-zinc-600 sm:px-5 dark:border-zinc-800/60 dark:text-zinc-300">
        {title}
      </h3>
      {conditions.length === 0 ? (
        <p className="px-4 py-2.5 text-xs text-zinc-400 sm:px-5 dark:text-zinc-500">
          {emptyMessage}
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
          {conditions.map((condition) => (
            <ConditionRow
              key={condition.jobName}
              condition={condition}
              builds={builds}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The split a responder reads first: how many conditions are new, how many
 * carried over, and how many this comparison saw pass again, against the
 * baseline build they are all measured from. Zero counts are left out rather
 * than shown as noise.
 */
function ConditionSummary({
  comparison,
}: {
  comparison: FullCiComparisonView;
}) {
  const counts = [
    {
      lifecycle: "new" as FullCiLifecycle,
      count: comparison.ongoing.filter((c) => c.lifecycle === "new").length,
    },
    {
      lifecycle: "recurring" as FullCiLifecycle,
      count: comparison.ongoing.filter((c) => c.lifecycle === "recurring")
        .length,
    },
    { lifecycle: "fixed" as FullCiLifecycle, count: comparison.fixed.length },
  ].filter((entry) => entry.count > 0);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {counts.length === 0 ? (
        <span className="text-zinc-500 dark:text-zinc-400">
          No failure conditions
        </span>
      ) : (
        counts.map(({ lifecycle, count }) => (
          <span
            key={lifecycle}
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${LIFECYCLE_CLASSES[lifecycle]}`}
          >
            {count} {LIFECYCLE_LABELS[lifecycle].toLowerCase()}
            {lifecycle === "fixed" ? "" : count === 1 ? " failure" : " failures"}
          </span>
        ))
      )}
    </div>
  );
}

function ComparisonCard({ comparison }: { comparison: FullCiComparisonView }) {
  const commit = commitDescription(comparison.currentRun);
  const builds: ComparedBuilds = {
    previousBuildNumber: comparison.previousRun.buildNumber,
    currentBuildNumber: comparison.currentRun.buildNumber,
  };

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 sm:px-5 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="flex flex-wrap items-baseline gap-x-2 text-base font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
            <a
              href={comparison.currentRun.buildUrl}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              build {comparison.currentRun.buildNumber}
            </a>
            <a
              href={commitUrl(comparison.currentRun.commitSha)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              {comparison.currentRun.commitSha.slice(0, 7)}
            </a>
            {commit.pr !== null && (
              <a
                href={commit.pr.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                #{commit.pr.number}
              </a>
            )}
          </h2>
          {comparison.isLatest && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
              Latest comparison
            </span>
          )}
          <NotificationBadge
            state={comparison.notificationState}
            className="ml-auto"
          />
        </div>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          <RunState state={comparison.currentRun.state} /> ·{" "}
          {formatAlertDateTime(comparison.currentRun.scheduledAt)} · analyzed{" "}
          {formatAlertDateTime(comparison.analyzedAt)}
        </p>
        <p className="mt-1 w-full truncate text-xs text-zinc-500 dark:text-zinc-400">
          {commit.subject}
        </p>
        <ConditionSummary comparison={comparison} />
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
          <RunSummary label="Baseline" run={comparison.previousRun} />
        </div>
      </div>

      <ConditionSection
        title={comparison.isLatest ? "Ongoing" : "Ongoing at this comparison"}
        emptyMessage="No new or recurring failure conditions."
        conditions={comparison.ongoing}
        builds={builds}
      />
      <ConditionSection
        title="Fixed in this comparison"
        emptyMessage="No failure conditions were observed passing again."
        conditions={comparison.fixed}
        builds={builds}
      />
    </div>
  );
}

/**
 * Full CI Failure Conditions, newest comparison first, with what is still
 * broken separated from what this comparison observed passing again. Every
 * condition is shown against the two runs it was classified from; the
 * analyzer's raw report, cache, and memory checkpoints are never rendered.
 */
const PAGE_SIZE = 10;

export function FullCIAlerts({
  comparisons,
  emptyMessage = "No Full CI comparisons have been analyzed yet.",
}: {
  comparisons: FullCiComparisonView[];
  emptyMessage?: string;
}) {
  const [page, setPage] = useState(0);

  if (comparisons.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-zinc-300 text-sm text-zinc-400 dark:border-zinc-700">
        {emptyMessage}
      </div>
    );
  }

  const pageCount = Math.ceil(comparisons.length / PAGE_SIZE);
  const currentPage = Math.min(page, pageCount - 1);
  const pageComparisons = comparisons.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );

  return (
    <div className="space-y-4">
      {pageComparisons.map((comparison) => (
        <ComparisonCard
          key={comparison.currentRun.buildkiteBuildId}
          comparison={comparison}
        />
      ))}
      <AlertPagination
        currentPage={currentPage}
        pageCount={pageCount}
        total={comparisons.length}
        unit={{ one: "comparison", many: "comparisons" }}
        onPageChange={setPage}
      />
    </div>
  );
}
