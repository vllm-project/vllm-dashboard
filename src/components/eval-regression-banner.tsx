import useSWR from "swr";
import {
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

const fetcher = <T,>(url: string): Promise<T> =>
  fetch(url).then((r) => r.json());

interface EvalAlertsResponse {
  alerts?: EvalRegressionAlert[];
  snapshots?: EvalRegressionSnapshot[];
  lastCheckedAt?: string | null;
  schemaStatus?: string;
}

// Two cron cadences (6h each) plus margin.  Tested against the cron
// heartbeat (last_checked_at), not the snapshot timestamp, so dedupe
// short-circuits don't trigger false staleness.
const STALE_THRESHOLD_MS = 13 * 60 * 60 * 1000;

function isStale(checkedAt: string | null | undefined): boolean {
  if (!checkedAt) return false;
  const age = Date.now() - new Date(checkedAt).getTime();
  return age > STALE_THRESHOLD_MS;
}


export function EvalRegressionBanner() {
  const { data } = useSWR<EvalAlertsResponse>(
    "/api/alerts/eval",
    fetcher,
    { refreshInterval: 5 * 60 * 1000 },
  );

  if (!data || data.schemaStatus === "pending") return null;

  const latestSnapshot = data.snapshots?.[0];
  const openAlerts = (data.alerts ?? []).filter((a) => a.status === "open");

  if (!latestSnapshot) return null;

  // Staleness tests the cron heartbeat, not the snapshot age.
  const stale = isStale(data.lastCheckedAt);
  const isPass = latestSnapshot.status === "pass";
  const isSkipped = latestSnapshot.status === "skipped";
  const isError = latestSnapshot.status === "error";
  const s = latestSnapshot.summary;

  const borderClass = stale || isError
    ? "border-amber-200/80 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20"
    : isPass
      ? "border-emerald-200/80 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20"
      : isSkipped
        ? "border-zinc-200/80 bg-zinc-50/50 dark:border-zinc-800/50 dark:bg-zinc-950/20"
        : "border-red-200/80 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20";

  const headingClass = stale || isError
    ? "text-amber-800 dark:text-amber-200"
    : isPass
      ? "text-emerald-800 dark:text-emerald-200"
      : isSkipped
        ? "text-zinc-600 dark:text-zinc-400"
        : "text-red-800 dark:text-red-200";

  let icon: string;
  let heading: string;
  if (stale) {
    icon = "⚠️";
    heading = "Eval regression check is stale";
  } else if (isError) {
    icon = "⚠️";
    heading = "Eval regression check failed";
  } else if (isSkipped) {
    icon = "⏭️";
    heading = "Eval check skipped — no candidate data";
  } else if (isPass) {
    icon = "✅";
    heading = "All eval checks passed";
  } else {
    icon = "🚨";
    heading = `${s.regressed} eval regression${s.regressed !== 1 ? "s" : ""} detected`;
  }

  const unit = (alert: EvalRegressionAlert) =>
    alert.unit ?? inferUnit(alert.baseline_value, alert.candidate_value);

  return (
    <div className={`rounded-xl border px-5 py-4 ${borderClass}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-lg">{icon}</span>
            <h3 className={`text-sm font-semibold ${headingClass}`}>
              {heading}
            </h3>
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {latestSnapshot.baseline_image} vs {latestSnapshot.candidate_image}
            {" · "}
            checked {formatRelativeTime(latestSnapshot.checked_at)}
            {!isSkipped && !isError && ` · ${s.total} metrics, ${s.regressed} regressed, ${s.improved} improved`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {latestSnapshot.compare_url && !isSkipped && (
            <a
              href={latestSnapshot.compare_url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              View comparison
            </a>
          )}
          <a
            href="/alerts?tab=eval"
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            View alerts
          </a>
        </div>
      </div>

      {openAlerts.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-red-200/60 pt-3 dark:border-red-900/40">
          {openAlerts.slice(0, 5).map((alert) => (
            <div
              key={alert.alert_id}
              className="flex items-center gap-3 text-xs"
            >
              <span className="text-red-500">●</span>
              <span className="font-medium text-zinc-800 dark:text-zinc-200">
                {alert.task}
              </span>
              <span className="text-zinc-500 dark:text-zinc-400">
                {alert.metric}:{" "}
                {fmtMetricValue(alert.baseline_value, unit(alert))} →{" "}
                {fmtMetricValue(alert.candidate_value, unit(alert))}{" "}
                <span className={evalDeltaColor(alert.delta, alert.higher_is_better)}>
                  ({fmtMetricDelta(alert.delta, unit(alert))}
                  {alert.significance !== null &&
                    `, ${alert.significance.toFixed(1)}σ`}
                  )
                </span>
              </span>
            </div>
          ))}
          {openAlerts.length > 5 && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              … and {openAlerts.length - 5} more
            </p>
          )}
        </div>
      )}
    </div>
  );
}
