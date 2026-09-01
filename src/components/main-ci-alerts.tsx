import { useMemo, useState } from "react";
import { JobName } from "@/components/job-name";
import {
  type MainCiAnalysisClassification,
  type MainCiJobAlert,
  type MainCiJobAnalysis,
} from "@/lib/alerts-main-ci";
import { commitUrl, formatAlertDateTime } from "@/lib/alerts-shared";

const STATUS_CLASSES = {
  open: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  resolved:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
} as const;

const CLASSIFICATION_CLASSES: Record<MainCiAnalysisClassification, string> = {
  infra:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  flaky:
    "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  code: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  test: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  unknown: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const CLASSIFICATION_FILTERS: readonly MainCiAnalysisClassification[] = [
  "infra",
  "flaky",
  "code",
  "test",
  "unknown",
];

type StatusFilter = "open" | "resolved" | "all";
/** A classification, or the pseudo-value for alerts with no analysis yet. */
type ClassificationFilter = MainCiAnalysisClassification | "unanalyzed";

const STATUS_FILTERS: readonly { value: StatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`dashboard-control rounded-full border px-3 py-1.5 text-xs font-semibold ${
        active
          ? "border-zinc-950 bg-zinc-950 text-zinc-50 dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-950"
          : "border-zinc-300 text-zinc-500 hover:text-zinc-950 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-50"
      }`}
    >
      {label}
    </button>
  );
}

function ClassificationBadge({ analysis }: { analysis: MainCiJobAnalysis }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${CLASSIFICATION_CLASSES[analysis.classification]}`}
      title={`${analysis.confidence} confidence`}
    >
      {analysis.classification}
      <span className="font-normal opacity-70">· {analysis.confidence}</span>
      {analysis.stale && (
        <span className="font-normal opacity-70">· stale</span>
      )}
    </span>
  );
}

function BuildLink({
  label,
  buildNumber,
  buildUrl,
  jobUrl,
}: {
  label: string;
  buildNumber: number;
  buildUrl: string;
  jobUrl: string;
}) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <a
        href={buildUrl}
        target="_blank"
        rel="noreferrer"
        className="text-blue-600 hover:underline dark:text-blue-400"
      >
        build {buildNumber}
      </a>
      <a
        href={jobUrl}
        target="_blank"
        rel="noreferrer"
        className="text-blue-600 hover:underline dark:text-blue-400"
      >
        job
      </a>
    </span>
  );
}

function AnalysisPanel({ analysis }: { analysis: MainCiJobAnalysis | null }) {
  if (analysis === null) {
    return (
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        No analysis yet.
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-800/60 dark:bg-zinc-900/40">
      {analysis.stale && (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
          Analysis stale — a newer failure was observed after this analysis.
        </p>
      )}
      <p className="text-xs text-zinc-700 dark:text-zinc-300">
        {analysis.summary}
      </p>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          Recommended:
        </span>{" "}
        {analysis.recommendedAction}
      </p>
      {analysis.evidenceUrls.length > 0 && (
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Evidence:
          </span>
          {analysis.evidenceUrls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {url.replace(/^https?:\/\//, "")}
            </a>
          ))}
        </p>
      )}
      {analysis.suspectedFixPrs.length > 0 && (
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Suspected fix PRs:
          </span>
          {analysis.suspectedFixPrs.map((pr) => (
            <a
              key={pr.url}
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {pr.number !== null
                ? `PR #${pr.number}${pr.title ? ` — ${pr.title}` : ""}`
                : pr.url}
            </a>
          ))}
        </p>
      )}
      <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
        {analysis.modelVersion} · analyzed{" "}
        {formatAlertDateTime(analysis.analyzedAt)}
      </p>
    </div>
  );
}

export function MainCiAlertRow({ alert }: { alert: MainCiJobAlert }) {
  return (
    <details className="group overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5 [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="text-xs text-zinc-400 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        >
          ▸
        </span>
        <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          <JobName name={alert.jobName} />
        </span>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CLASSES[alert.status]}`}
        >
          {alert.status === "open" ? "Open" : "Resolved"}
        </span>
        {alert.analysis && <ClassificationBadge analysis={alert.analysis} />}
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {alert.failureCount} failed {alert.failureCount === 1 ? "run" : "runs"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-x-3 text-xs text-zinc-500 dark:text-zinc-400">
          <span>opened {formatAlertDateTime(alert.openedAt)}</span>
          <span>
            {alert.status === "open" ? "last failed" : "resolved"}{" "}
            {formatAlertDateTime(
              alert.resolvedAt ?? alert.lastFailure.finishedAt,
            )}
          </span>
        </span>
      </summary>
      <div className="space-y-2 border-t border-zinc-200 px-4 py-3 text-xs sm:px-5 dark:border-zinc-800">
        <div className="space-y-1">
          <BuildLink
            label="First failure"
            buildNumber={alert.firstFailure.buildNumber}
            buildUrl={alert.firstFailure.buildUrl}
            jobUrl={alert.firstFailure.jobUrl}
          />
          {alert.lastFailure.buildkiteJobId !==
            alert.firstFailure.buildkiteJobId && (
            <BuildLink
              label="Latest failure"
              buildNumber={alert.lastFailure.buildNumber}
              buildUrl={alert.lastFailure.buildUrl}
              jobUrl={alert.lastFailure.jobUrl}
            />
          )}
          {alert.resolution && (
            <BuildLink
              label="Passed again"
              buildNumber={alert.resolution.buildNumber}
              buildUrl={alert.resolution.buildUrl}
              jobUrl={alert.resolution.jobUrl}
            />
          )}
          <a
            href={commitUrl(alert.lastFailure.commitSha)}
            target="_blank"
            rel="noreferrer"
            className="inline-block font-mono text-blue-600 hover:underline dark:text-blue-400"
          >
            {alert.lastFailure.commitSha.slice(0, 7)}
          </a>
        </div>
        <AnalysisPanel analysis={alert.analysis} />
      </div>
    </details>
  );
}

export function MainCIAlerts({ alerts }: { alerts: MainCiJobAlert[] }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [classificationFilter, setClassificationFilter] =
    useState<ClassificationFilter | null>(null);
  const [query, setQuery] = useState("");

  const openCount = useMemo(
    () => alerts.filter((alert) => alert.status === "open").length,
    [alerts],
  );
  const resolvedCount = alerts.length - openCount;
  const statusCounts: Record<StatusFilter, number> = {
    open: openCount,
    resolved: resolvedCount,
    all: alerts.length,
  };
  const hasAnalysis = useMemo(
    () => alerts.some((alert) => alert.analysis !== null),
    [alerts],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return alerts.filter((alert) => {
      if (statusFilter !== "all" && alert.status !== statusFilter) return false;
      if (needle && !alert.jobName.toLowerCase().includes(needle)) return false;
      if (classificationFilter === "unanalyzed") return alert.analysis === null;
      if (classificationFilter !== null) {
        return alert.analysis?.classification === classificationFilter;
      }
      return true;
    });
  }, [alerts, statusFilter, classificationFilter, query]);

  if (alerts.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-zinc-300 text-sm text-zinc-400 dark:border-zinc-700">
        No Main CI job alerts are active or resolved in this window.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Alert status"
          className="flex flex-wrap items-center gap-2"
        >
          {STATUS_FILTERS.map((item) => (
            <FilterChip
              key={item.value}
              active={statusFilter === item.value}
              label={`${item.label} ${statusCounts[item.value]}`}
              onClick={() => setStatusFilter(item.value)}
            />
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by job name"
          aria-label="Filter by job name"
          className="dashboard-control min-w-40 rounded-full border border-zinc-300 bg-transparent px-3 py-1.5 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
        {hasAnalysis && (
          <div
            role="group"
            aria-label="Failure classification"
            className="flex flex-wrap items-center gap-2"
          >
            {CLASSIFICATION_FILTERS.map((value) => (
              <FilterChip
                key={value}
                active={classificationFilter === value}
                label={value}
                onClick={() =>
                  setClassificationFilter(
                    classificationFilter === value ? null : value,
                  )
                }
              />
            ))}
            <FilterChip
              active={classificationFilter === "unanalyzed"}
              label="unanalyzed"
              onClick={() =>
                setClassificationFilter(
                  classificationFilter === "unanalyzed" ? null : "unanalyzed",
                )
              }
            />
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-zinc-300 text-sm text-zinc-400 dark:border-zinc-700">
          No Main CI job alerts match these filters.
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((alert) => (
            <MainCiAlertRow key={alert.alertId} alert={alert} />
          ))}
        </div>
      )}
    </div>
  );
}
