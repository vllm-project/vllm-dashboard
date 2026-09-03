# Full CI comparison alerts

## What it detects

The scheduled Full CI runs — Buildkite builds on `main` whose message is
exactly `full ci run - nightly` or `full ci run - daily` — and how each run
compares to its chronological predecessor. The ingest slice
(`alerting/full_ci.py`) records every run, its job outcomes, and the
comparison link. The analysis sidecar (`alerting/analyzer.py`) then runs a
Kimi-driven agent over each pending comparison to classify every failing
job (new / recurring / fixed; cause: infrastructure, flaky test, test,
code, unknown), attribute culprit and fixing PRs, and post the rendered
analysis report.

## Where the code lives

- `alerting/full_ci.py` — `FullCIRun` / `FullCIJobOutcome` records,
  `BuildkiteRestClient`, `BuildkiteFullCISource`,
  `FullCIReconciliationHandler` (`full_ci_reconcile`).
- `alerting/analyzer.py` — `FullCIAnalysisHandler` (`full_ci_analyze`) and
  the classification/commit logic; `alerting/kimi.py` is the runner.
- Deployment: `deploy/aws/systemd/alerting-full-ci.timer` fires at 05:00
  and 19:00 `America/Los_Angeles`; `alerting-full-ci.service` runs
  `run-worker full-ci` and then `run-worker full-ci-analyze` in one tick.

## Configuration

- `BUILDKITE_TOKEN` (source reads), `GITHUB_TOKEN` (PR attribution),
  `KIMI_API_KEY` plus optional `KIMI_BASE_URL`, `KIMI_MODEL`,
  `KIMI_TIMEOUT_SECONDS` (whole-analysis budget, default 3600),
  `KIMI_REQUEST_TIMEOUT_SECONDS` (single completion read timeout, default
  900), `KIMI_REASONING_EFFORT`. Transient request failures — read timeouts,
  connection errors, HTTP 429/5xx — are retried up to 3 times with 5s/15s
  backoff inside the whole-analysis budget before the analysis fails.
- `ALERTING_CHECKPOINT_BUCKET` — the S3 bucket for immutable analyzer
  checkpoints and the per-path control objects.
- Slack: `SLACK_BOT_TOKEN`; `SLACK_CHANNEL_ID` overrides the default
  channel (`C0ABTNM9L5U`).
- Control plane: S3 `control/full_ci.mode` (`shadow` default / `live` /
  `disabled`) applies to both the reconciler and the analyzer.

## What it posts to Slack

One message per analyzed comparison: the analyzer's report text, delivered
through the outbox with delivery ID `full-ci:<build_id>` (idempotent per
build). The reconciler itself posts nothing. Each analysis commits its
report, classifications, checkpoint reference, and the notification intent
in one Postgres transaction; a failure leaves the comparison pending for
the next tick.

## Dashboard history

Full CI comparisons and analyses are delivered to Slack only; the
dashboard's `/alerts` page does not render them (its tabs are Main CI
failures, Fast CI observations, and infra episodes).

## Tables

Reads: Buildkite REST API (builds, jobs).
Writes: `alerting_full_ci_runs`, `alerting_full_ci_job_outcomes`,
`alerting_full_ci_comparisons`, `alerting_full_ci_analyses`,
`alerting_full_ci_failure_conditions`, `alerting_analyzer_checkpoints`,
`alerting_notification_outbox`, `alerting_automation_executions`.
Legacy cutover state: `alerting_full_ci_import_baselines`.
Analyzer memory lives as immutable S3 objects referenced from
`alerting_analyzer_checkpoints`; unreferenced objects are crash debris.
