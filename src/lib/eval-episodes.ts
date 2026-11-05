/**
 * Pure episode-planning logic for eval regression alerts.
 *
 * Determines which alert episodes to open, update, and resolve based on
 * the current comparison results and the existing open episodes.  Extracted
 * from the cron route so the decision that pages humans is testable.
 */

import { parseEvalKey, type DeltaItem } from "./compare";

export interface OpenEpisode {
  alert_id: number;
  model: string;
  task: string;
  n_shot: number;
  metric: string;
  filter: string;
}

export interface EpisodePlan {
  /** Regression deltas to upsert (open or update existing episodes). */
  toUpsert: DeltaItem[];
  /** Alert IDs to resolve (compared, no longer regressing). */
  toResolve: number[];
  /** Alert IDs that stay open (still regressing or not covered). */
  unchanged: number[];
}

export function evalAlertKey(fields: {
  model: string;
  task: string;
  nShot: number;
  metric: string;
  filter: string;
}): string {
  return `${fields.model}|${fields.task}|${fields.nShot}|${fields.metric}|${fields.filter}`;
}

/**
 * Plan which episodes to open, resolve, or leave alone.
 *
 * Rules:
 * - Regressing deltas → upsert (open new or update existing episode).
 * - Compared + clean (in allDeltas but not regressing) → resolve if open.
 * - Not covered (open episode whose key is not in allDeltas) → leave alone.
 *   Coverage gaps are normal — nightlies run a subset of the baseline.
 * - Malformed keys (parseEvalKey returns null) → skipped, never upserted
 *   or used for resolving.
 */
export function planEpisodes(
  openAlerts: OpenEpisode[],
  allDeltas: DeltaItem[],
  regressions: DeltaItem[],
): EpisodePlan {
  const comparedKeys = new Set<string>();
  for (const d of allDeltas) {
    const parsed = parseEvalKey(d);
    if (parsed) comparedKeys.add(evalAlertKey(parsed));
  }

  const regressionKeys = new Set<string>();
  const toUpsert: DeltaItem[] = [];
  for (const r of regressions) {
    const parsed = parseEvalKey(r);
    if (!parsed) continue;
    regressionKeys.add(evalAlertKey(parsed));
    toUpsert.push(r);
  }

  const toResolve: number[] = [];
  const unchanged: number[] = [];

  for (const a of openAlerts) {
    const key = `${a.model}|${a.task}|${a.n_shot}|${a.metric}|${a.filter}`;
    if (comparedKeys.has(key) && !regressionKeys.has(key)) {
      toResolve.push(a.alert_id);
    } else {
      unchanged.push(a.alert_id);
    }
  }

  return { toUpsert, toResolve, unchanged };
}

/**
 * Determine whether the Slack message needs updating.
 *
 * Compares against the *last notified* state rather than the current
 * day-row, so a new Pacific day with no change stays silent (no daily
 * all-clear spam) and an unchanged regression is not re-pinged.
 *
 * Returns true when:
 * - Status changed (pass → regression, regression → pass, etc.)
 * - Same status but the regression set changed (escalation, partial
 *   recovery, different model regressing).
 */
export function shouldNotify(
  currentStatus: string,
  currentRegressionKeys: Set<string>,
  lastNotifiedStatus: string | null,
  lastNotifiedKeys: string[] | null,
): boolean {
  if (lastNotifiedStatus === null) {
    // Never notified before — only notify on regression, not on a healthy
    // system (no daily all-clear on day 1).
    return currentStatus === "regression";
  }
  if (currentStatus !== lastNotifiedStatus) return true;
  if (currentStatus !== "regression") return false;
  // Same status = regression — notify if the set of regressing keys changed.
  const prevSet = new Set(lastNotifiedKeys ?? []);
  if (currentRegressionKeys.size !== prevSet.size) return true;
  for (const k of currentRegressionKeys) {
    if (!prevSet.has(k)) return true;
  }
  return false;
}
