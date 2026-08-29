# vLLM CI Dashboard

A Next.js dashboard for observing vLLM's Buildkite CI: build status, job runtimes, queue depth, agent capacity, infrastructure cost, and performance benchmark trends.

## Pages

- **Builds** — pass/fail rates, durations, and per-job breakdowns for recent pipeline builds.
- **Jobs** — latest job failures and per-job historical run times.
- **Alerts** — Fast CI observations, analyzed Full CI comparisons, and exact
  main-branch job failures that remain open until the same job passes again.
- **Tests** — Test Engine reliability, execution counts, and duration history.
- **Queue** — live agent queue depth, waiting builds, and Slack alerts when queues back up.
- **Cost** — compute hours and dollar cost per queue, derived from AWS on-demand pricing.
- **Performance** — benchmark trends ingested into the warehouse.
- **Compare** — release-oriented baseline/candidate image deltas across performance and evaluation metrics.

## Architecture

- **Frontend / API**: Next.js (App Router) on Vercel.
- **Warehouse**: Databricks SQL Warehouse — historical CI data is queried via the SQL Statements API.
- **Operational store**: Postgres (Supabase) — short-term agent and queue-depth samples written by cron jobs.
- **Sources polled**:
  - Buildkite GraphQL API (queue depth, running jobs, connected agents, and current wait distribution) — every 5 minutes
  - Buildkite REST API (main-branch failed-job lifecycle) — every 5 minutes
  - Databricks warehouse (build/job history) — on dashboard requests with short-lived caching
  - Queue alerting → Slack — every 15 minutes
- **Alert production**: The separately deployed Python worker lives in
  [`alerting/`](./alerting). Main CI lifecycle records intentionally contain
  no automated diagnosis; curated analysis continues in Slack.
- **Schema migrations**: All Postgres table definitions and migration execution
  live in the Python [`migrations/`](./migrations) module. Runtime request
  handlers never create or alter tables.
- Cron schedules live in `vercel.json`.

The Queue page uses Buildkite's cluster-queue counts directly. Because the
public queue metrics schema stops at p95, p99 is calculated from the current
`SCHEDULED` command jobs as `now - runnableAt` using nearest-rank percentiles;
the same five-minute snapshot feeds the historical chart.

## Local development

```bash
cp .env.local.example .env.local
# fill in your own credentials
npm install
DATABASE_URL=postgres://... npm run migrate
# Review the printed target and pending files, then apply them explicitly:
DATABASE_URL=postgres://... npm run migrate -- \
  --apply --confirm-target db.example.supabase.co:5432/postgres
npm run dev
```

Open http://localhost:3000.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID` | Databricks SQL Warehouse access |
| `DATABASE_URL` | Postgres connection string for queue and GPU samples |
| `BUILDKITE_API_TOKEN` | Buildkite personal API token; needs `read_suites` for Test Engine, GraphQL API access and `write_builds` for queue promotion, and notification-service scopes only when running the OTel setup script |
| `BUILDKITE_ORGANIZATION`, `BUILDKITE_TEST_SUITE` | Test Engine organization and suite slug (defaults: `vllm`, `ci-1`) |
| `BUILDKITE_QUEUE_OPERATOR_TOKEN` | Required to enable queue-job promotion; authorized operators enter it for the current browser tab |
| `OTEL_INGEST_TOKEN` | Shared Bearer token used by Buildkite's OTel notification service |
| `OTEL_MAX_REQUEST_BYTES` | Optional OTLP request limit; defaults to 4 MiB |
| `OTEL_ENDPOINT` | Buildkite notification-service base URL; defaults operationally to `https://ci.vllm.ai/api/otel` |
| `OTEL_BUILDKITE_OIDC_AUDIENCE`, `OTEL_BUILDKITE_OIDC_ORGANIZATION`, `OTEL_BUILDKITE_OIDC_PIPELINE`, `OTEL_BUILDKITE_OIDC_BRANCH`, `OTEL_BUILDKITE_OIDC_TREATMENT_BRANCH` | Optional restrictions for short-lived Buildkite job tokens; defaults to the production vLLM main pipeline plus API-triggered `khluu/otel` treatment builds |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` | Slack bot for queue-depth alerts (`chat:write`, `reactions:write`) |
| `CRON_SECRET` | Optional shared secret required by Vercel cron handlers |

The dashboard assumes a warehouse schema with tables under `vllm_data_warehouse.buildkite.*` (builds, jobs, agent query rules) and `vllm_data_warehouse.default.vllm_perf_data_ingest` for benchmarks. Adapt the queries in `src/app/api/**/route.ts` if your schema differs.

GPU telemetry is written to raw `gpu_snapshots` rows and an incremental
`gpu_history_5m` rollup used by the 24-hour through 30-day dashboard views.
Run the migration plan and explicit apply command documented in
[`migrations/`](./migrations) before deploying a version that reads new schema.
The migration is idempotent and backfills existing GPU snapshots into the
rollup; schema creation is intentionally kept out of request handlers.

## OpenTelemetry trace ingestion

The dashboard includes an authenticated OTLP/HTTP protobuf receiver at
`/api/otel/v1/traces`. It stores normalized spans in the operational Postgres
database so dashboard features can enrich the canonical Databricks build and
job history without introducing another dashboard.

1. Generate a dedicated random `OTEL_INGEST_TOKEN` with
   `openssl rand -hex 32` and add it to the Vercel project. Do not reuse a
   Buildkite or database credential.
2. Plan and explicitly apply [`migrations/`](./migrations) against the production
   `DATABASE_URL`.
3. Deploy the dashboard and verify the authenticated
   `GET /api/otel/health` endpoint.
4. Create or reconcile Buildkite's OpenTelemetry notification service:

   ```bash
   BUILDKITE_API_TOKEN=... \
   OTEL_INGEST_TOKEN=... \
   OTEL_ENDPOINT=https://ci.vllm.ai/api/otel \
   npm run configure:buildkite-otel
   ```

   `OTEL_ENDPOINT` is the base endpoint. Buildkite appends `/v1/traces`.
   The API token needs `read_notification_services` and
   `write_notification_services`, and its owner needs organization admin or
   Manage Notification Services access.

5. Verify delivery without exposing span data publicly:

   ```bash
   curl -H "Authorization: Bearer $OTEL_INGEST_TOKEN" \
     https://ci.vllm.ai/api/otel/health
   ```

The Vercel receiver accepts OTLP/HTTP protobuf with optional gzip compression;
it is not a gRPC collector. Buildkite agent v3.100 and newer propagates its
trace context to job processes, and the vLLM helper continues `TRACEPARENT`
when it is present. The agent's own span exporter is OTLP/gRPC-only, so adding
agent-internal checkout, hook, plugin, and artifact spans would still require a
standard OpenTelemetry Collector in front of this HTTP endpoint.

Detailed job timing does not distribute `OTEL_INGEST_TOKEN` to test code. An
opted-in trusted main-branch job requests a five-minute Buildkite OIDC token for
the dashboard audience when it uploads a batch. The receiver verifies the
Buildkite signature and requires the token's organization, pipeline, branch,
build number, and globally unique job ID to match every span. The receiver
accepts normal `main` jobs and API-triggered `khluu/otel` treatment jobs;
pull-request jobs and AMD mirrors are excluded from the initial pilot.

The vLLM CI helper creates a span for each generated YAML command. When the
command invokes pytest, its lightweight pytest plugin sends one child span per
test node ID. The build timeline groups those spans as job → command → test;
telemetry errors are warnings and never change the test command's exit status.

## Deployment

Deployed on Vercel. The cron jobs in `vercel.json` require Vercel Cron to be enabled on the project.

## License

No license is currently declared — treat as all-rights-reserved unless a `LICENSE` file is added.
