# Queue wait alerts

## What it detects

A Buildkite queue whose observed P90 wait time exceeds 30 minutes while
jobs are waiting or scheduled. Wait percentiles come from the
`queue_snapshots` table (P90 is computed from currently `SCHEDULED` command
jobs as `now - runnableAt`; see the Queue page note in the top-level
README), and the waiting-job count goes through `effectiveWaiting`
(`src/lib/queue-plugins.ts`) because Buildkite's Agent Metrics
`jobs_waiting` is inaccurate for some queues.

Unlike the CI and infra alert types, queue-wait alerting is owned by the
CI Dashboard context (see `CONTEXT-MAP.md` and `src/CONTEXT.md`), not by
the `alerting/` worker: it runs inside the Next.js app on Vercel, has no
outbox, and keeps its state in `alert_summary`.

## Where the code lives

- `src/app/api/alerts/queue/route.ts` — the whole lifecycle: threshold
  check, per-queue active/resolved state, and the combined Slack message.
- `src/lib/slack.ts` — `postMessage` / `updateMessage` / `addReaction`.
- `src/lib/queue-plugins.ts` — `effectiveWaiting`.
- Schedule: Vercel cron in `vercel.json` hits `/api/alerts/queue` every 15
  minutes (`*/15 * * * *`).

## Configuration

- `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` — the bot and channel the combined
  message posts to. The route returns 500 if either is missing.
- `CRON_SECRET` — when set, the route requires `Authorization: Bearer`.
- The threshold is a code constant, `WAIT_THRESHOLD_MINUTES = 30`, in the
  route. There is no thresholds table row and no shadow/disabled control
  plane for this alert type.

## What it posts to Slack

One combined message per Pacific day (keyed by `alert_summary.id =` the
Pacific date). On each tick with a state change the route either posts the
day's message or edits it in place, then adds a thread reply so the channel
gets a notification (":rotating_light: N queues still alerting" or
"All queues resolved"). Active queues list P90 wait and waiting-job count,
worst first; resolved queues are struck through with their resolution time.
When every queue is resolved, a ✅ reaction is added to the day message.
State persists in `alert_summary.queues` as JSONB, so a Vercel redeploy or
retry never loses which queues are alerting.

## Dashboard history

There is no queue-alert history view on `/alerts`; the alert's record is
the Slack message plus the `alert_summary` row. The underlying wait-time
data is visible on the `/queue` page.

## Tables

Reads: `queue_snapshots` (latest P90/P50/P95 per queue within 15 minutes,
plus latest scheduled/waiting/agents counts).
Writes: `alert_summary` (one row per Pacific day: message ts + per-queue
alert state).
