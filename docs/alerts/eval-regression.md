# Eval regression alerts

## What it detects

A sigma-based regression in lm_eval or BFCL accuracy metrics between the
latest **nightly** image (candidate) and the latest **release** image
(baseline).  Each metric is keyed by `model | task | n_shot | metric_name
| filter`.

The baseline is dynamic — resolved from Databricks by picking the newest
release image that has eval data (`classifyImage` → `groupImagesByKind`).

### Evidence rules

- `total === 0` (no metrics compared at all) → **skipped**: no alerts
  opened, resolved, or notified.
- Coverage gaps (`missingCandidate > 0`) are normal — nightlies run a
  subset of the baseline matrix.  They are reported in the summary but do
  not suppress evidence.  Resolve decisions are **per-key**: only keys
  this run actually compared can resolve; uncovered keys stay open.
- Errors (Databricks unreachable, no release image) → **error** snapshot
  recorded with zeroed summary.  No alerts opened or resolved.

## Where the code lives

- `src/lib/eval-regression.ts` — core logic.  `classifyDeltas()` is a
  pure function (tested); `runRegressionCheck()` orchestrates a single
  Databricks load, baseline resolution, comparison, and threshold check.
- `src/lib/eval-episodes.ts` — pure `planEpisodes()` decides which alerts
  to open, resolve, or leave alone.  `shouldNotify()` compares current
  state against the last notification to prevent daily all-clear spam and
  detect same-day escalation (new regressions, partial recovery).
- `src/lib/eval-baseline.ts` — dynamic baseline resolution.  All functions
  accept a pre-loaded row set so the cron path avoids redundant scans.
- `src/app/api/cron/eval-regression/route.ts` — cron endpoint: auth →
  regression check → short-circuit if same (baseline, candidate) as last
  snapshot → persist snapshot → plan episodes → upsert/resolve in a
  transaction → Slack notification on state change.
- `src/app/api/eval/baseline/route.ts` — `GET /api/eval/baseline` returns
  the resolved baseline image and metadata (no full metrics payload).
- `src/app/api/alerts/eval/route.ts` — reads alerts and snapshots for the
  UI.
- `src/components/eval-alerts.tsx` — alert list with open/resolved
  sections and recent-checks history.
- `src/components/eval-regression-banner.tsx` — status banner on the Eval
  page showing pass/regression/skipped/error/stale states.
- `src/lib/eval-regression.test.ts` — unit tests for `classifyDeltas`.
- `src/lib/eval-episodes.test.ts` — unit tests for `planEpisodes` and
  `shouldNotify`.
- Schedule: Vercel cron in `vercel.json` hits `/api/cron/eval-regression`
  every 6 hours (`0 */6 * * *`).

## Configuration

- `SLACK_BOT_TOKEN` — the bot token for posting.
- `SLACK_EVAL_ALERT_CHANNEL` — preferred channel; falls back to
  `SLACK_CI_INFRA_ALERT_CHANNEL`, then `SLACK_CHANNEL_ID`.
- `CRON_SECRET` — when set, the route requires `Authorization: Bearer`.
- `DASHBOARD_BASE_URL` — base URL for compare links (defaults to
  `https://ci.vllm.ai`).

Sigma threshold is passed as a parameter (default 2σ) and is not stored in
a thresholds table.

## What it posts to Slack

Notification is driven by `shouldNotify()`, which compares against the
**last notified state** (stored in `alerting_eval_last_notified`, not the
day-row), so:

- A healthy system produces no daily all-clear (unlike a day-row diff
  that would fire on every new Pacific day).
- Same-day escalation (new regressions, partial recovery, different model)
  triggers an update because the regression key set changed.
- An unchanged regression is not re-pinged.

When notifying, the route either creates a new Slack message or edits the
current day's message in place (keyed by `alerting_eval_alert_summary.id`),
then adds a thread reply for the channel notification.

- **Regression**: `:rotating_light:` header listing up to 15 regressed
  metrics with baseline → candidate values, delta, and sigma.  Coverage
  gaps are noted ("N baseline metrics not covered by this nightly").
- **Pass**: `:white_check_mark:` header with total metrics checked, plus
  a ✅ reaction on the day message.
- **Error/skipped**: no Slack activity.

## Duplicate-pair short-circuit

When the `(baseline, candidate)` pair matches the last non-error snapshot,
the cron run returns early without writing a new snapshot, running episode
logic, or posting to Slack.  This avoids redundant work when eval data
changes at most daily but the cron fires every 6h.

The cron heartbeat (`last_checked_at` on `alerting_eval_last_notified`)
is always bumped — including on short-circuit — so the banner can
distinguish "cron alive, data unchanged" from "cron stopped firing".
Staleness is tested against the heartbeat, not against the snapshot age.

## Integration with perf-eval (Buildkite)

A thin `compare_via_api.py` in the perf-eval repo calls `/api/eval/baseline`
to discover the baseline image, then `/api/compare` to get the comparison.
It prints a formatted table to the Buildkite log and exits:

- `0` — all metrics passed
- `1` — regression detected (fails the Buildkite step)
- `2` — API unreachable (warning only, does not fail)

## Tables

All tables use the `alerting_` prefix (migration `0030`).

- `alerting_eval_regression_alerts` — one row per open or resolved alert
  episode.  Unique constraint on `(model, task, n_shot, metric, filter)
  WHERE status = 'open'` ensures one open episode per eval key.  Stores
  `unit` so old episodes keep the formatting they were reported with.
- `alerting_eval_regression_snapshots` — one row per new `(baseline,
  candidate)` pair (including skipped and error).  Duplicate pairs are
  short-circuited.  `error` snapshots carry a zeroed summary with an
  `error` field.  Retained for 30 days (see retention cron).
- `alerting_eval_alert_summary` — one row per Pacific day: Slack message
  ts, status, and `regression_keys` (for escalation detection within the
  same day message).
- `alerting_eval_last_notified` — single row carrying notification state
  across Pacific days (status + regression key set) and cron heartbeat
  (`last_checked_at`).  Prevents spurious daily all-clear messages.
  Notification state is only updated on successful Slack delivery — a
  failed post leaves it unchanged so the next run retries.

## Dashboard views

- `/alerts` → "Eval regressions" tab shows open/resolved alerts and recent
  check history.
- `/eval` → `<EvalRegressionBanner />` shows current pass/regression/
  skipped/error/stale status.  Staleness threshold: 13 hours (two cron
  cadences plus margin).
