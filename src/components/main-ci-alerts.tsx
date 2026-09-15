import { useMemo, useState, type ReactNode } from "react";
import { JobName, jobNameText } from "@/components/job-name";
import { SegmentedControl } from "@/components/segmented-control";
import {
  isAmdJobName,
  isOptionalJobName,
  isSoftFailJobName,
  type MainCiAnalysisClassification,
  type MainCiAlertUpdate,
  type MainCiJobAlert,
  type MainCiJobAnalysis,
  type MainCiOutcomeRef,
  type MainCiSuspectedFixPr,
} from "@/lib/alerts-main-ci";
import {
  commitUrl,
  formatAlertDateTime,
  formatRelativeTime,
} from "@/lib/alerts-shared";

/**
 * One failure reason's colour, used consistently for the dot beside the reason
 * filter, the severity rail on the left edge of a row, and the badge in the row.
 */
interface ClassificationStyle {
  dot: string;
  rail: string;
  badge: string;
}

const CLASSIFICATION_STYLES: Record<
  MainCiAnalysisClassification,
  ClassificationStyle
> = {
  infra: {
    dot: "bg-amber-500",
    rail: "border-l-amber-400 dark:border-l-amber-500",
    badge:
      "bg-amber-50 text-amber-800 ring-amber-200/80 dark:bg-amber-900/30 dark:text-amber-200 dark:ring-amber-800/60",
  },
  flaky: {
    dot: "bg-violet-500",
    rail: "border-l-violet-400 dark:border-l-violet-500",
    badge:
      "bg-violet-50 text-violet-800 ring-violet-200/80 dark:bg-violet-900/30 dark:text-violet-200 dark:ring-violet-800/60",
  },
  code: {
    dot: "bg-rose-500",
    rail: "border-l-rose-500 dark:border-l-rose-500",
    badge:
      "bg-rose-50 text-rose-800 ring-rose-200/80 dark:bg-rose-900/30 dark:text-rose-200 dark:ring-rose-800/60",
  },
  test: {
    dot: "bg-sky-500",
    rail: "border-l-sky-400 dark:border-l-sky-500",
    badge:
      "bg-sky-50 text-sky-800 ring-sky-200/80 dark:bg-sky-900/30 dark:text-sky-200 dark:ring-sky-800/60",
  },
  unknown: {
    dot: "bg-zinc-400",
    rail: "border-l-zinc-400 dark:border-l-zinc-500",
    badge:
      "bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700",
  },
};

const UNANALYZED_DOT = "bg-zinc-300 dark:bg-zinc-600";
const UNANALYZED_RAIL = "border-l-zinc-300 dark:border-l-zinc-700";
const RESOLVED_RAIL = "border-l-emerald-300 dark:border-l-emerald-800";

type StatusFilter = "open" | "resolved" | "all";
/** A classification, or the pseudo-value for alerts with no analysis yet. */
type ReasonFilter = MainCiAnalysisClassification | "unanalyzed";

const STATUS_FILTERS: readonly { value: StatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

/** The reasons a responder can narrow the list to, in the order they appear. */
const REASON_FILTERS: readonly { value: ReasonFilter; label: string }[] = [
  { value: "infra", label: "Infra" },
  { value: "flaky", label: "Flaky" },
  { value: "code", label: "Code" },
  { value: "test", label: "Test" },
  { value: "unknown", label: "Unknown" },
  { value: "unanalyzed", label: "Not analyzed yet" },
];

function isReasonFilter(value: string): value is ReasonFilter {
  return REASON_FILTERS.some((reason) => reason.value === value);
}

export type SortKey = "job" | "failures" | "opened" | "lastFailed";
export type SortDirection = "asc" | "desc";
export interface AlertSort {
  key: SortKey;
  direction: SortDirection;
}

/**
 * The sortable columns. Each opens in the direction a responder most often
 * wants first: names alphabetically, everything else with the biggest or most
 * recent value on top.
 */
const SORT_COLUMNS: readonly {
  key: SortKey;
  label: string;
  defaultDirection: SortDirection;
}[] = [
  { key: "job", label: "Job", defaultDirection: "asc" },
  { key: "failures", label: "Failures", defaultDirection: "desc" },
  { key: "opened", label: "Opened", defaultDirection: "desc" },
  { key: "lastFailed", label: "Last failed", defaultDirection: "desc" },
];

function sortColumn(key: SortKey) {
  return SORT_COLUMNS.find((column) => column.key === key) ?? SORT_COLUMNS[0];
}

function compareJobNames(a: MainCiJobAlert, b: MainCiJobAlert): number {
  return jobNameText(a.jobName).localeCompare(
    jobNameText(b.jobName),
    undefined,
    { sensitivity: "base", numeric: true },
  );
}

function compareBy(key: SortKey, a: MainCiJobAlert, b: MainCiJobAlert): number {
  switch (key) {
    case "job":
      return compareJobNames(a, b);
    case "failures":
      return a.failureCount - b.failureCount;
    case "opened":
      return Date.parse(a.openedAt) - Date.parse(b.openedAt);
    case "lastFailed":
      return (
        Date.parse(a.lastFailure.finishedAt) -
        Date.parse(b.lastFailure.finishedAt)
      );
  }
}

/**
 * Orders alerts by one column. A null sort keeps the lifecycle order the list
 * arrives in: open alerts first, most recent activity first. Ties fall back to
 * the job name so the order is stable between renders.
 */
export function sortMainCiAlerts(
  alerts: readonly MainCiJobAlert[],
  sort: AlertSort | null,
): MainCiJobAlert[] {
  if (sort === null) return [...alerts];
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...alerts].sort(
    (a, b) => sign * compareBy(sort.key, a, b) || compareJobNames(a, b),
  );
}

/** Clicking the active column flips it; clicking another opens it in its default direction. */
export function nextSort(current: AlertSort | null, key: SortKey): AlertSort {
  if (current?.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: sortColumn(key).defaultDirection };
}

function SortHeader({
  columnKey,
  sort,
  align = "left",
  onSort,
}: {
  columnKey: SortKey;
  sort: AlertSort | null;
  align?: "left" | "right";
  onSort: (key: SortKey) => void;
}) {
  const column = sortColumn(columnKey);
  const active = sort?.key === columnKey;
  const direction = active ? sort.direction : null;
  return (
    <button
      type="button"
      onClick={() => onSort(columnKey)}
      aria-label={`Sort by ${column.label.toLowerCase()}${
        direction ? `, currently ${direction === "asc" ? "ascending" : "descending"}` : ""
      }`}
      className={`dashboard-control group/sort inline-flex items-center gap-1 rounded text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase ${
        align === "right" ? "justify-self-end" : "justify-self-start"
      } ${
        active
          ? "text-zinc-900 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      }`}
    >
      {column.label}
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className={`h-3 w-3 transition-transform duration-150 motion-reduce:transition-none ${
          active ? "" : "opacity-0 group-hover/sort:opacity-60"
        } ${direction === "asc" ? "rotate-180" : ""}`}
      >
        <path
          d="M4 6l4 4 4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** The same sort as the header row, for screens where the header is hidden. */
function SortSelect({
  sort,
  onChange,
}: {
  sort: AlertSort | null;
  onChange: (sort: AlertSort | null) => void;
}) {
  const DIRECTION_LABELS: Record<SortKey, Record<SortDirection, string>> = {
    job: { asc: "Job A→Z", desc: "Job Z→A" },
    failures: { desc: "Most failures", asc: "Fewest failures" },
    opened: { desc: "Newest opened", asc: "Oldest opened" },
    lastFailed: { desc: "Latest failure", asc: "Earliest failure" },
  };
  return (
    <label className="relative inline-flex items-center sm:hidden">
      <span className="sr-only">Sort alerts</span>
      <select
        value={sort ? `${sort.key}:${sort.direction}` : ""}
        onChange={(event) => {
          const [key, direction] = event.target.value.split(":");
          onChange(
            SORT_COLUMNS.some((column) => column.key === key) &&
              (direction === "asc" || direction === "desc")
              ? { key: key as SortKey, direction }
              : null,
          );
        }}
        className="dashboard-control h-8 cursor-pointer appearance-none rounded-md border border-zinc-200 bg-white pr-7 pl-2.5 text-xs font-medium text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100 dark:focus:border-zinc-600"
      >
        <option value="">Default order</option>
        {SORT_COLUMNS.map((column) => (
          <optgroup key={column.key} label={column.label}>
            {(["desc", "asc"] as const).map((direction) => (
              <option
                key={direction}
                value={`${column.key}:${direction}`}
              >
                {DIRECTION_LABELS[column.key][direction]}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-zinc-400"
      >
        <path
          d="M4 6l4 4 4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </label>
  );
}

/**
 * One grid template shared by the header row and every alert row so the
 * columns line up as a table. Narrow screens keep the chevron, name, reason,
 * failure count and action, and drop the two time columns.
 */
const ROW_GRID =
  "grid grid-cols-[1rem_minmax(0,1fr)_2.5rem_auto] items-center gap-x-3 sm:grid-cols-[1rem_minmax(10rem,1fr)_7.5rem_minmax(12rem,1fr)_4.5rem_6.5rem_6.5rem_4.5rem]";

const LINK_CLASSES = "text-blue-600 hover:underline dark:text-blue-400";

function railFor(alert: MainCiJobAlert): string {
  if (alert.status === "resolved") return RESOLVED_RAIL;
  if (alert.analysis === null) return UNANALYZED_RAIL;
  return CLASSIFICATION_STYLES[alert.analysis.classification].rail;
}

function ReasonSelect({
  value,
  counts,
  onChange,
}: {
  value: ReasonFilter | null;
  counts: Record<ReasonFilter, number>;
  onChange: (value: ReasonFilter | null) => void;
}) {
  const dot =
    value === null
      ? null
      : value === "unanalyzed"
        ? UNANALYZED_DOT
        : CLASSIFICATION_STYLES[value].dot;
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">Failure reason</span>
      {dot && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute left-2.5 h-2 w-2 rounded-full ${dot}`}
        />
      )}
      <select
        value={value ?? ""}
        onChange={(event) =>
          onChange(
            isReasonFilter(event.target.value) ? event.target.value : null,
          )
        }
        className={`dashboard-control h-8 cursor-pointer appearance-none rounded-md border bg-white pr-7 text-xs focus:border-zinc-400 dark:bg-zinc-950 dark:focus:border-zinc-600 ${
          value === null
            ? "border-zinc-200 pl-2.5 font-medium text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
            : "border-zinc-400 pl-6 font-semibold text-zinc-950 dark:border-zinc-600 dark:text-zinc-50"
        }`}
      >
        <option value="">All reasons</option>
        {REASON_FILTERS.map((reason) => (
          <option key={reason.value} value={reason.value}>
            {reason.label} ({counts[reason.value]})
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-zinc-400"
      >
        <path
          d="M4 6l4 4 4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </label>
  );
}

function ReasonBadge({ analysis }: { analysis: MainCiJobAnalysis }) {
  const style = CLASSIFICATION_STYLES[analysis.classification];
  return (
    <>
      <span
        className={`inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${style.badge}`}
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`}
        />
        {analysis.classification}
      </span>
      {analysis.stale && (
        <span
          className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
          title="A newer failure was observed after this analysis"
        >
          stale
        </span>
      )}
    </>
  );
}

function currentFixPrs(alert: MainCiJobAlert): MainCiSuspectedFixPr[] {
  const updateFixPrs = alert.updates
    .filter((update) => !update.stale)
    .flatMap((update) => update.fixPrs);
  const fixPrs =
    updateFixPrs.length > 0
      ? updateFixPrs
      : alert.analysis && !alert.analysis.stale
        ? alert.analysis.suspectedFixPrs
        : [];
  return [...new Map(fixPrs.map((pr) => [pr.url, pr])).values()];
}

function SolutionSummary({ alert }: { alert: MainCiJobAlert }) {
  const update =
    alert.updates.find((candidate) => !candidate.stale) ?? alert.updates[0];
  const analysis = alert.analysis?.stale ? null : alert.analysis;
  const message = update?.message ?? analysis?.recommendedAction ?? null;
  const fixPrs = currentFixPrs(alert);
  const fallbackFixPrs =
    fixPrs.length === 0 && update?.stale ? update.fixPrs : fixPrs;
  const uniqueFixPrs = [
    ...new Map(fallbackFixPrs.map((pr) => [pr.url, pr])).values(),
  ];

  if (message === null && uniqueFixPrs.length === 0) {
    return (
      <span className="hidden text-xs text-zinc-400 sm:block dark:text-zinc-500">
        No solution posted
      </span>
    );
  }

  return (
    <span className="hidden min-w-0 sm:block">
      {message && (
        <span
          className="block truncate text-xs text-zinc-600 dark:text-zinc-300"
          title={message}
        >
          {update?.stale && (
            <span className="font-medium text-amber-700 dark:text-amber-300">
              Older: {" "}
            </span>
          )}
          {message}
        </span>
      )}
      {uniqueFixPrs.length > 0 && (
        <span className="mt-0.5 flex min-w-0 gap-2 text-[11px]">
          {uniqueFixPrs.slice(0, 2).map((pr) => (
            <a
              key={pr.url}
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              title={pr.title || pr.url}
              onClick={(event) => event.stopPropagation()}
              className={`truncate font-medium ${LINK_CLASSES}`}
            >
              {pr.number !== null ? `PR #${pr.number}` : pr.title || "Fix"}
            </a>
          ))}
          {uniqueFixPrs.length > 2 && (
            <span className="shrink-0 text-zinc-400 dark:text-zinc-500">
              +{uniqueFixPrs.length - 2}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** Failure counts read on a ramp: one is a blip, several is a pattern. */
function failureCountClasses(count: number): string {
  if (count >= 5) return "text-red-600 dark:text-red-400";
  if (count >= 2) return "text-zinc-900 dark:text-zinc-100";
  return "text-zinc-500 dark:text-zinc-400";
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h4 className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
      {children}
    </h4>
  );
}

function TimelineItem({
  label,
  at,
  tone,
  outcome,
  note,
}: {
  label: string;
  at: string;
  tone: "failed" | "passed" | "manual";
  outcome?: MainCiOutcomeRef;
  note?: string;
}) {
  const dotClasses = {
    failed: "bg-red-400 dark:bg-red-500",
    passed: "bg-emerald-500",
    manual: "bg-zinc-400 dark:bg-zinc-500",
  }[tone];
  return (
    <li className="flex gap-2.5 text-xs">
      <span
        aria-hidden="true"
        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dotClasses}`}
      />
      <div className="min-w-0">
        <p className="font-medium text-zinc-800 dark:text-zinc-200">
          {label}
          <span className="font-normal text-zinc-400 dark:text-zinc-500">
            {" "}
            · {formatAlertDateTime(at)}
          </span>
        </p>
        {outcome && (
          <p className="mt-0.5 flex gap-2.5">
            <a
              href={outcome.buildUrl}
              target="_blank"
              rel="noreferrer"
              className={LINK_CLASSES}
            >
              build {outcome.buildNumber}
            </a>
            <a
              href={outcome.jobUrl}
              target="_blank"
              rel="noreferrer"
              className={LINK_CLASSES}
            >
              job
            </a>
          </p>
        )}
        {note && (
          <p className="mt-0.5 text-zinc-500 dark:text-zinc-400">{note}</p>
        )}
      </div>
    </li>
  );
}

function Timeline({ alert }: { alert: MainCiJobAlert }) {
  const manual = alert.resolutionKind === "manual";
  return (
    <div>
      <SectionLabel>Timeline</SectionLabel>
      <ol className="mt-2.5 space-y-2.5">
        <TimelineItem
          label="First failure"
          at={alert.firstFailure.finishedAt}
          outcome={alert.firstFailure}
          tone="failed"
        />
        {alert.lastFailure.buildkiteJobId !==
          alert.firstFailure.buildkiteJobId && (
          <TimelineItem
            label="Latest failure"
            at={alert.lastFailure.finishedAt}
            outcome={alert.lastFailure}
            tone="failed"
          />
        )}
        {alert.resolution && !manual && (
          <TimelineItem
            label="Passed again"
            at={alert.resolution.finishedAt}
            outcome={alert.resolution}
            tone="passed"
          />
        )}
        {alert.status === "resolved" && manual && (
          <TimelineItem
            label="Resolved manually"
            at={alert.resolvedAt ?? alert.lastFailure.finishedAt}
            tone="manual"
            note="Closed by hand; no passing run was observed."
          />
        )}
      </ol>
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        Last failing commit{" "}
        <a
          href={commitUrl(alert.lastFailure.commitSha)}
          target="_blank"
          rel="noreferrer"
          className={`font-mono ${LINK_CLASSES}`}
        >
          {alert.lastFailure.commitSha.slice(0, 7)}
        </a>
      </p>
    </div>
  );
}

function LinkList({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
        {label}
      </dt>
      <dd className="mt-1">
        <ul className="space-y-1">{children}</ul>
      </dd>
    </div>
  );
}

function AnalysisPanel({ analysis }: { analysis: MainCiJobAnalysis | null }) {
  if (analysis === null) {
    return (
      <div>
        <SectionLabel>Analysis</SectionLabel>
        <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
          No analysis yet.
        </p>
      </div>
    );
  }
  const hasLinks =
    analysis.evidenceUrls.length > 0 || analysis.suspectedFixPrs.length > 0;
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <SectionLabel>Analysis</SectionLabel>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
          {analysis.modelVersion} · analyzed{" "}
          {formatAlertDateTime(analysis.analyzedAt)}
        </span>
      </div>
      {analysis.stale && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-200">
          Analysis stale — a newer failure was observed after this analysis.
        </p>
      )}
      <p className="text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-200">
        {analysis.summary}
      </p>
      <div className="rounded-md border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
          Recommended action
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-200">
          {analysis.recommendedAction}
        </p>
      </div>
      {hasLinks && (
        <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          {analysis.evidenceUrls.length > 0 && (
            <LinkList label="Evidence">
              {analysis.evidenceUrls.map((url) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    title={url}
                    className={`block truncate ${LINK_CLASSES}`}
                  >
                    {url.replace(/^https?:\/\//, "")}
                  </a>
                </li>
              ))}
            </LinkList>
          )}
          {analysis.suspectedFixPrs.length > 0 && (
            <LinkList label="Suspected fix PRs">
              {analysis.suspectedFixPrs.map((pr) => (
                <li key={pr.url}>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`block truncate ${LINK_CLASSES}`}
                  >
                    {pr.number !== null
                      ? `PR #${pr.number}${pr.title ? ` — ${pr.title}` : ""}`
                      : pr.url}
                  </a>
                </li>
              ))}
            </LinkList>
          )}
        </dl>
      )}
    </div>
  );
}

const UPDATE_KIND_LABELS: Record<MainCiAlertUpdate["kind"], string> = {
  note: "Note",
  diagnosis: "Diagnosis",
  fix_opened: "Fix opened",
  monitoring: "Monitoring",
};

function UpdatesPanel({ updates }: { updates: MainCiAlertUpdate[] }) {
  if (updates.length === 0) return null;

  return (
    <div className="min-w-0 space-y-3">
      <SectionLabel>Responder updates</SectionLabel>
      <ol className="space-y-2">
        {updates.map((update) => (
          <li
            key={update.updateId}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  {update.author}
                </span>
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 ring-1 ring-blue-200/80 ring-inset dark:bg-blue-900/30 dark:text-blue-200 dark:ring-blue-800/60">
                  {UPDATE_KIND_LABELS[update.kind]}
                </span>
                {update.stale && (
                  <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    Older failure
                  </span>
                )}
              </div>
              <time
                dateTime={update.createdAt}
                className="text-[11px] text-zinc-400 dark:text-zinc-500"
              >
                {formatAlertDateTime(update.createdAt)}
              </time>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-200">
              {update.message}
            </p>
            {update.fixPrs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {update.fixPrs.map((pr) => (
                  <a
                    key={pr.url}
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`rounded-md border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-700 ${LINK_CLASSES}`}
                  >
                    {pr.number !== null
                      ? `PR #${pr.number}${pr.title ? ` — ${pr.title}` : ""}`
                      : pr.title || pr.url}
                  </a>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function MainCiAlertRow({
  alert,
  onResolve,
  now = new Date(),
}: {
  alert: MainCiJobAlert;
  onResolve?: (alertId: string) => Promise<void>;
  now?: Date;
}) {
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(false);

  const resolve = async () => {
    if (!onResolve || resolving) return;
    setResolving(true);
    setResolveError(false);
    try {
      await onResolve(alert.alertId);
    } catch {
      setResolveError(true);
      setResolving(false);
    }
  };

  const resolved = alert.status === "resolved";
  const runsLabel = `${alert.failureCount} failed ${
    alert.failureCount === 1 ? "run" : "runs"
  }`;
  const fixPrCount = new Set(
    alert.updates.flatMap((update) => update.fixPrs.map((pr) => pr.url)),
  ).size;
  return (
    <details className={`group border-l-[3px] ${railFor(alert)}`}>
      <summary
        className={`${ROW_GRID} cursor-pointer list-none px-3 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/60 [&::-webkit-details-marker]:hidden`}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="row-span-2 h-3.5 w-3.5 text-zinc-400 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none sm:row-span-1"
        >
          <path
            d="M6 3l5 5-5 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-2">
          <span
            className={`min-w-0 truncate text-sm font-medium ${
              resolved
                ? "text-zinc-600 dark:text-zinc-400"
                : "text-zinc-900 dark:text-zinc-100"
            }`}
          >
            <JobName name={alert.jobName} />
          </span>
          {resolved && (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
              title={
                alert.resolvedAt
                  ? `resolved ${formatAlertDateTime(alert.resolvedAt)}`
                  : undefined
              }
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3">
                <path
                  d="M3 8.5l3 3 7-7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {alert.resolutionKind === "manual"
                ? "Resolved manually"
                : "Resolved"}
            </span>
          )}
          {fixPrCount > 0 && (
            <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 ring-1 ring-blue-200/80 ring-inset dark:bg-blue-900/30 dark:text-blue-200 dark:ring-blue-800/60">
              {fixPrCount} fix {fixPrCount === 1 ? "PR" : "PRs"}
            </span>
          )}
        </span>
        <span className="col-start-2 row-start-2 flex min-w-0 items-center gap-1.5 sm:col-start-3 sm:row-start-1">
          {alert.analysis ? (
            <ReasonBadge analysis={alert.analysis} />
          ) : (
            <span
              className="text-xs text-zinc-400 dark:text-zinc-500"
              title="Not analyzed yet"
            >
              —
            </span>
          )}
        </span>
        <SolutionSummary alert={alert} />
        <span
          className={`col-start-3 row-start-1 text-right text-xs font-medium tabular-nums sm:col-start-5 ${failureCountClasses(alert.failureCount)}`}
          title={runsLabel}
          aria-label={runsLabel}
        >
          {alert.failureCount}
        </span>
        <time
          dateTime={alert.openedAt}
          title={`opened ${formatAlertDateTime(alert.openedAt)}`}
          className="hidden text-right text-xs tabular-nums text-zinc-500 sm:block dark:text-zinc-400"
        >
          {formatRelativeTime(alert.openedAt, now)}
        </time>
        <time
          dateTime={alert.lastFailure.finishedAt}
          title={`last failed ${formatAlertDateTime(alert.lastFailure.finishedAt)}`}
          className="hidden text-right text-xs tabular-nums text-zinc-500 sm:block dark:text-zinc-400"
        >
          {formatRelativeTime(alert.lastFailure.finishedAt, now)}
        </time>
        <span className="col-start-4 row-start-1 flex justify-end sm:col-start-8">
          {!resolved && onResolve && (
            <button
              type="button"
              disabled={resolving}
              onClick={(event) => {
                // Keep the row from toggling open when resolving.
                event.preventDefault();
                void resolve();
              }}
              className="dashboard-control h-6 rounded-md border border-zinc-200 px-2 text-[11px] font-medium whitespace-nowrap text-zinc-500 hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
            >
              {resolving ? "Resolving…" : "Resolve"}
            </button>
          )}
        </span>
      </summary>
      <div className="border-t border-zinc-100 bg-zinc-50/70 px-4 py-4 sm:px-5 dark:border-zinc-800/70 dark:bg-zinc-900/30">
        {resolveError && (
          <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300">
            Could not resolve this alert. Try again.
          </p>
        )}
        <div className="space-y-6">
          <UpdatesPanel updates={alert.updates} />
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_15rem]">
            <AnalysisPanel analysis={alert.analysis} />
            <Timeline alert={alert} />
          </div>
        </div>
      </div>
    </details>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-zinc-300 text-sm text-zinc-400 dark:border-zinc-700">
      {children}
    </div>
  );
}

export interface MainCiAlertGroup {
  key: string;
  fixPr: MainCiSuspectedFixPr | null;
  alerts: MainCiJobAlert[];
}

/**
 * Assign each alert to one current fix PR so one repair spanning many jobs is
 * visible as one workstream. An alert with several linked PRs uses the first
 * current responder link as its primary group and still shows every link in
 * its Solution cell and expanded history.
 */
export function groupMainCiAlertsByFixPr(
  alerts: readonly MainCiJobAlert[],
): MainCiAlertGroup[] {
  const fixGroups = new Map<string, MainCiAlertGroup>();
  const ungrouped: MainCiAlertGroup = {
    key: "unlinked",
    fixPr: null,
    alerts: [],
  };

  for (const alert of alerts) {
    const fixPr = currentFixPrs(alert)[0] ?? null;
    if (fixPr === null) {
      ungrouped.alerts.push(alert);
      continue;
    }
    const group = fixGroups.get(fixPr.url);
    if (group) {
      group.alerts.push(alert);
    } else {
      fixGroups.set(fixPr.url, {
        key: fixPr.url,
        fixPr,
        alerts: [alert],
      });
    }
  }

  const groups = [...fixGroups.values()];
  if (ungrouped.alerts.length > 0) groups.push(ungrouped);
  return groups;
}

function MainCiAlertGroupTable({
  group,
  sort,
  onSort,
  onResolve,
  now,
}: {
  group: MainCiAlertGroup;
  sort: AlertSort | null;
  onSort: (key: SortKey) => void;
  onResolve?: (alertId: string) => Promise<void>;
  now: Date;
}) {
  const jobLabel = `${group.alerts.length} ${
    group.alerts.length === 1 ? "job" : "jobs"
  }`;
  const groupLabel = group.fixPr
    ? group.fixPr.number !== null
      ? `Fix PR #${group.fixPr.number}`
      : group.fixPr.title || "Linked fix PR"
    : "No current fix PR linked";

  return (
    <section aria-label={`${groupLabel}, ${jobLabel}`} className="space-y-1.5">
      <div className="flex min-h-7 flex-wrap items-baseline gap-x-2 px-1">
        {group.fixPr ? (
          <a
            href={group.fixPr.url}
            target="_blank"
            rel="noreferrer"
            className={`text-sm font-semibold ${LINK_CLASSES}`}
          >
            {groupLabel}
          </a>
        ) : (
          <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
            {groupLabel}
          </h2>
        )}
        {group.fixPr?.title && (
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
            {group.fixPr.title}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {jobLabel}
        </span>
      </div>
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div
          role="group"
          aria-label={`Sort alerts in ${groupLabel}`}
          className={`${ROW_GRID} hidden border-b border-zinc-200 border-l-[3px] border-l-transparent bg-zinc-50/80 px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase sm:grid dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400`}
        >
          <span />
          <SortHeader columnKey="job" sort={sort} onSort={onSort} />
          <span>Reason</span>
          <span>Solution</span>
          <SortHeader
            columnKey="failures"
            sort={sort}
            align="right"
            onSort={onSort}
          />
          <SortHeader
            columnKey="opened"
            sort={sort}
            align="right"
            onSort={onSort}
          />
          <SortHeader
            columnKey="lastFailed"
            sort={sort}
            align="right"
            onSort={onSort}
          />
          <span />
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {group.alerts.map((alert) => (
            <MainCiAlertRow
              key={alert.alertId}
              alert={alert}
              onResolve={onResolve}
              now={now}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

export function MainCIAlerts({
  alerts,
  onResolve,
  hideSoftFail = false,
  hideOptional = false,
  hideAmd = false,
}: {
  alerts: MainCiJobAlert[];
  onResolve?: (alertId: string) => Promise<void>;
  hideSoftFail?: boolean;
  hideOptional?: boolean;
  hideAmd?: boolean;
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AlertSort | null>(null);
  const toggleSort = (key: SortKey) => setSort(nextSort(sort, key));
  // One clock per render keeps every relative time in the list consistent.
  const now = new Date();

  const openCount = useMemo(
    () => alerts.filter((alert) => alert.status === "open").length,
    [alerts],
  );
  const statusOptions = STATUS_FILTERS.map((item) => ({
    ...item,
    count:
      item.value === "open"
        ? openCount
        : item.value === "resolved"
          ? alerts.length - openCount
          : alerts.length,
  }));
  const hasAnalysis = useMemo(
    () => alerts.some((alert) => alert.analysis !== null),
    [alerts],
  );

  // Status and the job-category hides narrow the list first; the reason
  // dropdown then reports counts within that narrower list.
  const inScope = useMemo(
    () =>
      alerts.filter((alert) => {
        if (statusFilter !== "all" && alert.status !== statusFilter) {
          return false;
        }
        if (hideSoftFail && isSoftFailJobName(alert.jobName)) return false;
        if (hideOptional && isOptionalJobName(alert.jobName)) return false;
        if (hideAmd && isAmdJobName(alert.jobName)) return false;
        return true;
      }),
    [alerts, statusFilter, hideSoftFail, hideOptional, hideAmd],
  );

  const reasonCounts = useMemo(() => {
    const counts: Record<ReasonFilter, number> = {
      infra: 0,
      flaky: 0,
      code: 0,
      test: 0,
      unknown: 0,
      unanalyzed: 0,
    };
    for (const alert of inScope) {
      counts[alert.analysis?.classification ?? "unanalyzed"] += 1;
    }
    return counts;
  }, [inScope]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = inScope.filter((alert) => {
      if (needle && !alert.jobName.toLowerCase().includes(needle)) return false;
      if (reasonFilter === "unanalyzed") return alert.analysis === null;
      if (reasonFilter !== null) {
        return alert.analysis?.classification === reasonFilter;
      }
      return true;
    });
    return sortMainCiAlerts(matching, sort);
  }, [inScope, reasonFilter, query, sort]);
  const groups = useMemo(() => groupMainCiAlertsByFixPr(visible), [visible]);

  if (alerts.length === 0) {
    return (
      <EmptyState>
        No Main CI job alerts are active or resolved in this window.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SegmentedControl
          label="Alert status"
          value={statusFilter}
          options={statusOptions}
          onChange={setStatusFilter}
        />
        {hasAnalysis && (
          <ReasonSelect
            value={reasonFilter}
            counts={reasonCounts}
            onChange={setReasonFilter}
          />
        )}
        <SortSelect sort={sort} onChange={setSort} />
        <label className="relative ml-auto block">
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
          >
            <circle
              cx="7"
              cy="7"
              r="4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M10.5 10.5L14 14"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by job name"
            aria-label="Filter by job name"
            className="dashboard-control h-8 w-52 rounded-md border border-zinc-200 bg-white pr-2.5 pl-8 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-zinc-600"
          />
        </label>
      </div>

      {visible.length === 0 ? (
        <EmptyState>No Main CI job alerts match these filters.</EmptyState>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <MainCiAlertGroupTable
              key={group.key}
              group={group}
              sort={sort}
              onSort={toggleSort}
              onResolve={onResolve}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}
