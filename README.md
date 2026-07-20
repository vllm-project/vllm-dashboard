# vLLM CI Dashboard

A Next.js dashboard for observing vLLM's Buildkite CI: build status, job runtimes, queue depth, agent capacity, infrastructure cost, and performance benchmark trends.

## Pages

- **Builds** — pass/fail rates, durations, and per-job breakdowns for recent pipeline builds.
- **Jobs** — latest job failures and per-job historical run times.
- **Queue** — live agent queue depth, waiting builds, and Slack alerts when queues back up.
- **Cost** — compute hours and dollar cost per queue, derived from AWS on-demand pricing.
- **Performance** — benchmark trends ingested into the warehouse.
- **Compare** — release-oriented baseline/candidate image deltas across performance and evaluation metrics.

## Architecture

- **Frontend / API**: Next.js (App Router) on Vercel.
- **Warehouse**: Databricks SQL Warehouse — historical CI data is queried via the SQL Statements API.
- **Operational store**: Postgres (Supabase) — short-term agent and queue-depth samples written by cron jobs.
- **Sources polled**:
  - Buildkite Agent Metrics API (queue depth, agent counts) — every minute
  - Databricks warehouse (build/job history) — every 5 minutes
  - Queue alerting → Slack — every 15 minutes
- Cron schedules live in `vercel.json`.

## Local development

```bash
cp .env.local.example .env.local
# fill in your own credentials
npm install
npm run migrate:gpu-rollups
npm run dev
```

Open http://localhost:3000.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID` | Databricks SQL Warehouse access |
| `DATABASE_URL` | Postgres connection string for agent/queue samples |
| `BUILDKITE_AGENT_TOKEN` | Buildkite agent registration token (for the Agent Metrics API) |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` | Slack bot for queue-depth alerts (`chat:write`, `reactions:write`) |
| `CRON_SECRET` | Optional shared secret required by Vercel cron handlers |

The dashboard assumes a warehouse schema with tables under `vllm_data_warehouse.buildkite.*` (builds, jobs, agent query rules) and `vllm_data_warehouse.default.vllm_perf_data_ingest` for benchmarks. Adapt the queries in `src/app/api/**/route.ts` if your schema differs.

GPU telemetry is written to raw `gpu_snapshots` rows and an incremental
`gpu_history_5m` rollup used by the 24-hour through 30-day dashboard views.
Run `npm run migrate:gpu-rollups` once before deploying a version that reads
the rollup. The migration is idempotent and backfills existing raw snapshots;
schema creation is intentionally kept out of user-facing request handlers.

## Deployment

Deployed on Vercel. The cron jobs in `vercel.json` require Vercel Cron to be enabled on the project.

## License

No license is currently declared — treat as all-rights-reserved unless a `LICENSE` file is added.
