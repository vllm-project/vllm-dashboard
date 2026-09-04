# Fast CI failure alerts

## What it detects

A required job in the `CI` Buildkite pipeline on the `main` branch that
finishes in a hard failure state (`failed`, `failing`, `broken`,
`timed_out`) within 30 seconds. These fast failures almost always mean the
merge queue is broken for everyone (bad base image, missing secret, setup
step failing), so they page immediately. Soft-failed, non-script, and
unnamed jobs are excluded. Fast failure events have no resolution
lifecycle: each is a one-way observation.

## Where the code lives

- `alerting/fast_ci.py` — the slice: `FastFailureEvent` record, the
  preserved Databricks SQL predicate, `DatabricksFastCISource`, the Slack
  renderer, and `FastCIScanHandler`.
- `alerting/runtime.py` — claims and completes the `fast_ci_scan` scheduled
  command; `alerting/postgres.py` is the production store,
  `alerting/memory.py` the in-memory test double.
- Deployment: `deploy/aws/systemd/alerting-fast-ci.timer` runs
  `run-worker fast-ci` every 15 minutes (`America/Los_Angeles`) on the EC2
  alerting worker.

## Configuration

- `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID` — the
  source warehouse query (secrets).
- `SLACK_BOT_TOKEN` — delivery; `SLACK_CHANNEL_ID` overrides the default
  channel (`C0ABTNM9L5U`).
- Control plane: the S3 `control/fast_ci.mode` object, applied by
  `alerting/control.py` to `alerting-fast-ci.timer`. `shadow` (the default)
  persists rendered messages without delivering; `live` delivers;
  `disabled` stops the timer.
- Scan bounds: 30-second duration ceiling (`MAX_DURATION_SECONDS`), a
  15-minute safety overlap behind the durable cursor, and a 30-minute
  initial lookback on first run — constants in `fast_ci.py`.

## What it posts to Slack

One message per batch of up to 8 new failures
("*Fast CI job failure alert* — N jobs failed in 30s or less"), listing job
link, duration, build, branch, commit, PR, and author. Batches are
content-addressed (`fast-ci:<sha256 of job IDs>`), so retries never
duplicate. A pending batch older than 30 minutes is superseded and folded
into a single "*Fast CI recovery summary*" so a Slack outage does not flood
the channel later.

## Dashboard history

`/alerts?tab=fast-ci` ("Fast failures (<30s)") shows the last 7 days of
events grouped by build and commit, including how far each event's Slack
notification got. Backed by `src/app/api/alerts/fast-ci/route.ts`.

## Tables

Reads: Databricks `vllm_data_warehouse.buildkite.build_job` /
`build` / `pipeline` (via the SQL Statements API);
`alerting_fast_ci_imported_deduplication_keys`.
Writes: `alerting_fast_failure_events`, `alerting_fast_failure_notifications`,
`alerting_fast_ci_scan_cursors`, `alerting_notification_outbox`,
`alerting_automation_executions`.
