import {
  formatAlertDateTime,
  formatRelativeTime,
  fmtMetricValue,
  fmtMetricDelta,
  evalDeltaColor,
} from "@/lib/alerts-shared";
import { inferUnit } from "@/lib/compare";
import type {
  EvalRegressionAlert,
  EvalRegressionSnapshot,
} from "@/lib/eval-alert-types";

function StatusBadge({ status }: { status: "open" | "resolved" }) {
  return status === "open" ? (
    <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/60 dark:text-red-300">
      Open
    </span>
  ) : (
    <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      Resolved
    </span>
  );
}

function CheckStatusBadge({
  status,
}: {
  status: EvalRegressionSnapshot["status"];
}) {
  switch (status) {
    case "pass":
      return (
        <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
          Pass
        </span>
      );
    case "skipped":
      return (
        <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
          Skipped
        </span>
      );
    case "error":
      return (
        <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
          Error
        </span>
      );
    case "regression":
      return (
        <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/60 dark:text-red-300">
          Regression
        </span>
      );
  }
}

function AlertRow({ alert }: { alert: EvalRegressionAlert }) {
  const unit = alert.unit ?? inferUnit(alert.baseline_value, alert.candidate_value);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            {alert.task}
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {alert.metric} · {alert.n_shot}-shot
          </span>
          <StatusBadge status={alert.status} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="font-mono">{alert.model}</span>
          <span>
            {fmtMetricValue(alert.baseline_value, unit)} → {fmtMetricValue(alert.candidate_value, unit)}{" "}
            <span className={evalDeltaColor(alert.delta, alert.higher_is_better)}>
              ({fmtMetricDelta(alert.delta, unit)}
              {alert.significance !== null &&
                `, ${alert.significance.toFixed(1)}σ`}
              )
            </span>
          </span>
        </div>
      </div>
      <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
        Opened {formatAlertDateTime(alert.opened_at)}
        {alert.resolved_at &&
          ` · Resolved ${formatAlertDateTime(alert.resolved_at)}`}
      </span>
    </li>
  );
}

function SnapshotRow({ snapshot }: { snapshot: EvalRegressionSnapshot }) {
  const s = snapshot.summary;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm sm:px-5">
      <CheckStatusBadge status={snapshot.status} />
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        {snapshot.status === "error"
          ? "Check failed"
          : snapshot.status === "skipped"
            ? "No candidate data"
            : `${s.total} metrics · ${s.regressed} regressed · ${s.improved} improved`}
      </span>
      <span className="ml-auto shrink-0 font-mono text-xs text-zinc-400">
        {formatRelativeTime(snapshot.checked_at)}
      </span>
      {snapshot.compare_url && snapshot.status !== "skipped" && (
        <a
          href={snapshot.compare_url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          View
        </a>
      )}
    </li>
  );
}

export function EvalAlerts({
  alerts,
  snapshots,
}: {
  alerts: EvalRegressionAlert[];
  snapshots: EvalRegressionSnapshot[];
}) {
  const openAlerts = alerts.filter((a) => a.status === "open");
  const resolvedAlerts = alerts.filter((a) => a.status === "resolved");

  return (
    <div className="space-y-4">
      {snapshots.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-4 py-3 sm:px-5 dark:border-zinc-800">
            <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              Recent checks
            </h3>
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {snapshots.map((snap) => (
              <SnapshotRow key={snap.snapshot_id} snapshot={snap} />
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 px-4 py-3 sm:px-5 dark:border-zinc-800">
          <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Open regressions ({openAlerts.length})
          </h3>
        </div>
        {openAlerts.length === 0 ? (
          <p className="px-4 py-5 text-sm text-zinc-500 sm:px-5 dark:text-zinc-400">
            No open eval regressions.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {openAlerts.map((alert) => (
              <AlertRow key={alert.alert_id} alert={alert} />
            ))}
          </ul>
        )}
      </div>

      {resolvedAlerts.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-4 py-3 sm:px-5 dark:border-zinc-800">
            <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              Recently resolved ({resolvedAlerts.length})
            </h3>
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {resolvedAlerts.map((alert) => (
              <AlertRow key={alert.alert_id} alert={alert} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
