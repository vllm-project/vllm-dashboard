# Main CI job failure alerts

## What it detects

Hard terminal failures of command jobs on the `main` branch of the `CI`
pipeline, keyed by the configured Buildkite step key plus the rendered job
name (so matrix cells stay independent). One alert is one failure episode:
repeated failures refresh the open episode, and only a positively observed
pass of the same logical job in the same or a newer build resolves it.
Soft-failed, canceled, missing, or late-finishing older jobs never resolve
an episode. Episodes can also be closed by hand from the dashboard
(`resolution_kind = 'manual'`).

## Where the code lives

- `alerting/main_ci.py` — `MainCIJobObservation` / `MainCIJobAlert`
  records, `BuildkiteMainCISource`, `MainCIReconciliationHandler`
  (`main_ci_reconcile`, two-minute poller) and `MainCIBackstopHandler`
  (`main_ci_backstop`, hourly sweep of the last 48 hours plus re-checks of
  every open alert's last-failure build, so retry passes the windowed
  poller missed still resolve within an hour).
- `alerting/main_ci_analysis.py` — the `main_ci_analyze` sidecar: for each
  open alert it runs a Kimi analysis over the failing job's log and stores
  the classification in `alerting_main_ci_job_analysis`. It never
  enqueues notifications and never writes alert state.
- Deployment: `alerting-main-ci.timer` every 2 minutes,
  `alerting-main-ci-backstop.timer` hourly at :17, and
  `alerting-main-ci-analysis.timer` every 10 minutes (all UTC) on the EC2
  worker.

## Configuration

- `BUILDKITE_TOKEN` — source reads; the analysis sidecar also needs
  `GITHUB_TOKEN` and `KIMI_API_KEY`. The sidecar has dedicated knobs
  `KIMI_MAIN_CI_TIMEOUT_SECONDS` (default 1200) and
  `KIMI_MAIN_CI_REASONING_EFFORT` (default `max`), independent of the
  shared `KIMI_*` settings.
- Control plane: S3 `control/main_ci.mode` (`shadow` default / `live` /
  `disabled`) governs all three timers together. Main CI currently posts
  nothing to Slack, so the mode only enables or disables the timers.

## What it posts to Slack

Nothing. Lifecycle records deliberately carry raw Buildkite evidence only;
diagnosis stays a curated Slack concern. The dashboard is the consumer.

## Dashboard history

`/alerts?tab=main-ci` ("Failures") lists open and recently resolved
episodes with first/last failure evidence and the sidecar's analysis when
present, and offers manual resolution (POST
`src/app/api/alerts/main-ci/resolve`). Backed by
`src/app/api/alerts/main-ci/route.ts`.

## Tables

Reads: Buildkite REST API (active and finished main builds, retried jobs,
job logs for analysis); GitHub for PR context in analysis.
Writes: `alerting_main_ci_job_states` (current per-job state, guarded so an
older build finishing late cannot overwrite a newer outcome),
`alerting_main_ci_job_alerts` (episodes; partial unique index keeps at most
one open episode per job key), `alerting_main_ci_scan_cursors`,
`alerting_main_ci_job_analysis` (sidecar),
`alerting_automation_executions`.
