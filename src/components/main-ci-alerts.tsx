import { JobName } from "@/components/job-name";
import { type MainCiJobAlert } from "@/lib/alerts-main-ci";
import { commitUrl, formatAlertDateTime } from "@/lib/alerts-shared";

const STATUS_CLASSES = {
  open: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  resolved:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
} as const;

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

function AlertCard({ alert }: { alert: MainCiJobAlert }) {
  return (
    <article className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-zinc-200 px-4 py-3 sm:px-5 dark:border-zinc-800">
        <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          <JobName name={alert.jobName} />
        </span>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CLASSES[alert.status]}`}
        >
          {alert.status === "open" ? "Open" : "Resolved"}
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {alert.failureCount} failed {alert.failureCount === 1 ? "run" : "runs"}
        </span>
        <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
          {alert.status === "open" ? "last failed" : "resolved"}{" "}
          {formatAlertDateTime(
            alert.resolvedAt ?? alert.lastFailure.finishedAt,
          )}
        </span>
      </div>
      <div className="space-y-1 px-4 py-3 text-xs sm:px-5">
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
    </article>
  );
}

export function MainCIAlerts({ alerts }: { alerts: MainCiJobAlert[] }) {
  if (alerts.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-zinc-300 text-sm text-zinc-400 dark:border-zinc-700">
        No Main CI job alerts are active or resolved in this window.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {alerts.map((alert) => (
        <AlertCard key={alert.alertId} alert={alert} />
      ))}
    </div>
  );
}
