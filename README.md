# vLLM CI Dashboard

A Next.js dashboard for observing vLLM's Buildkite CI: build status, job runtimes, queue depth, agent capacity, infrastructure cost, and performance benchmark trends.

## Pages

- **Builds** — pass/fail rates, durations, and per-job breakdowns for recent pipeline builds.
- **Jobs** — latest job failures and per-job historical run times.
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
npm run migrate:otel
npm run dev
```

Open http://localhost:3000.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID` | Databricks SQL Warehouse access |
| `DATABASE_URL` | Postgres connection string for agent/queue samples |
| `BUILDKITE_AGENT_TOKEN` | Buildkite agent registration token (for the Agent Metrics API) |
| `BUILDKITE_API_TOKEN` | Buildkite personal API token; needs `read_suites` for Test Engine, GraphQL API access and `write_builds` for queue promotion, and notification-service scopes only when running the OTel setup script |
| `BUILDKITE_ORGANIZATION`, `BUILDKITE_TEST_SUITE` | Test Engine organization and suite slug (defaults: `vllm`, `ci-1`) |
| `BUILDKITE_QUEUE_OPERATOR_TOKEN` | Required to enable queue-job promotion; authorized operators enter it for the current browser tab |
| `OTEL_INGEST_TOKEN` | Required Bearer token for the OTLP/HTTP trace receiver |
| `OTEL_MAX_REQUEST_BYTES` | Optional OTLP request limit; defaults to 4 MiB |
| `OTEL_ENDPOINT` | Buildkite notification-service base URL; defaults operationally to `https://ci.vllm.ai/api/otel` |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` | Slack bot for queue-depth alerts (`chat:write`, `reactions:write`) |
| `CRON_SECRET` | Optional shared secret required by Vercel cron handlers |

The dashboard assumes a warehouse schema with tables under `vllm_data_warehouse.buildkite.*` (builds, jobs, agent query rules) and `vllm_data_warehouse.default.vllm_perf_data_ingest` for benchmarks. Adapt the queries in `src/app/api/**/route.ts` if your schema differs.

GPU telemetry is written to raw `gpu_snapshots` rows and an incremental
`gpu_history_5m` rollup used by the 24-hour through 30-day dashboard views.
Run `npm run migrate:gpu-rollups` once before deploying a version that reads
the rollup. The migration is idempotent and backfills existing raw snapshots;
schema creation is intentionally kept out of user-facing request handlers.

## OpenTelemetry trace ingestion

The dashboard includes an authenticated OTLP/HTTP protobuf receiver at
`/api/otel/v1/traces`. It stores normalized spans in the operational Postgres
database so dashboard features can enrich the canonical Databricks build and
job history without introducing another dashboard.

1. Generate a dedicated random `OTEL_INGEST_TOKEN` with
   `openssl rand -hex 32` and add it to the Vercel project. Do not reuse a
   Buildkite or database credential.
2. Run `npm run migrate:otel` against the production `DATABASE_URL`.
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
it is not a gRPC collector. To add agent-side checkout, hook, plugin, command,
and artifact spans, Buildkite agent v3.101 or newer can be configured with:

```bash
BUILDKITE_TRACING_BACKEND=opentelemetry
BUILDKITE_TRACING_PROPAGATE_TRACEPARENT=true
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=https://ci.vllm.ai/api/otel
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $OTEL_INGEST_TOKEN"
OTEL_TRACES_SAMPLER=always_on
```

For older agents that only export OTLP/gRPC, put a standard OpenTelemetry
Collector in front of this HTTP endpoint or upgrade the agents first.

## Deployment

Deployed on Vercel. The cron jobs in `vercel.json` require Vercel Cron to be enabled on the project.

## License

No license is currently declared — treat as all-rights-reserved unless a `LICENSE` file is added.
