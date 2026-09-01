# Alert Production

This bounded context produces durable vLLM CI alert history for Full CI
comparisons, Fast CI fast-failure signals, and exact Main CI job failure
episodes. It processes scheduled
reconciliation commands idempotently against Postgres as the system of record
and delivers Slack notifications through a transactional outbox. The dashboard
application in this repository reads its records but does not own ingestion.

## Design

The package uses vertical domain slices rather than layer-only folders:

- `commands.py` defines the scheduled-command value object shared by all
  slices.
- `fast_ci.py`, `full_ci.py`, and `main_ci.py` keep each signal's domain records,
  reconciliation behavior, source port, and source adapter together.
- `runtime.py` exposes the small application interface:
  `process_command` and `dispatch_due_notifications`.
- `ports.py` defines infrastructure seams used by the runtime.
- `postgres.py` and `memory.py` are production and test adapters at those
  seams.

This keeps behavior local while allowing external systems to be replaced in
tests. Domain language is recorded in [`CONTEXT.md`](./CONTEXT.md), and the
repository-level relationship with the dashboard is recorded in
[`CONTEXT-MAP.md`](../CONTEXT-MAP.md).

## Layout

- `commands.py` — the command model; a command is a reconciliation
  wake-up from a scheduler tick, identified by a deterministic idempotency key
  (`command_type` + UTC target time). Commands carry no credentials, logs,
  model output, or Slack payloads.
- `ports.py` — protocols between the runtime and infrastructure
  (execution store, notification outbox, Slack, clock), plus the record types.
- `runtime.py` — `AlertingRuntime`: `process_command` (claim → handler
  → complete, with lease-based mutual exclusion and retry-after-failure) and
  `dispatch_due_notifications` (lease due outbox rows, deliver, record state).
- `fast_ci.py` — the Fast CI Databricks query adapter, scan handler,
  preserved Slack renderer, and event records. A scan reads from the durable
  cursor with a 15-minute safety overlap and commits new job IDs, notification
  batches, cursor advancement, and execution completion atomically.
- `full_ci.py` — the Buildkite query adapter, Full CI run and
  job-outcome records, and chronological reconciliation handler. Analyzer
  invocation remains outside this ingest-only slice.
- `main_ci.py` — the two-minute Buildkite main-branch poller and exact-job
  lifecycle. It ignores soft/non-command/non-terminal jobs, protects newer
  outcomes from older builds finishing late, and resolves only on a positive
  pass. Retried executions are fetched alongside originals (`include_retried_jobs`),
  retried-out executions that lack a step key inherit it from the same-named
  job in the build, and a pass that fell behind the scan window still
  resolves when its build is fetched. An hourly backstop sweep
  (`main_ci_backstop`) re-checks every open alert against the build where it
  last failed, so a retry pass missed by the windowed poller resolves within
  an hour. It writes raw lifecycle and Buildkite evidence only; Sherlock's
  diagnosis remains in Slack.
- `analyzer.py` — the Full CI analyzer compatibility adapter. It materializes
  the working files the bundled analyzer instructions expect (summary, full
  build data, previous-failure cache, agent memory hydrated from the latest
  referenced S3 checkpoint), invokes the analyzer runner non-interactively,
  validates its outputs, uploads a new immutable versioned checkpoint, and
  commits the classifications, PR attribution, rendered report, checkpoint
  reference, and Slack notification intent in one Postgres transaction per
  comparison. A fixed classification is persisted only for a positively
  observed pass, and fixing-PR attribution only for a verified merged revert.
  Any failure leaves the previous baseline authoritative and finalizes no
  outbox row.
- `kimi.py` — the analyzer runner backed by the Kimi chat-completions API. It
  runs the bundled analyzer instructions as the system message and drives an
  OpenAI-compatible tool-calling loop whose file tools are sandboxed to the
  materialized working directory; the shell tool only executes `curl`, so
  credentials stay in the server-side environment.
- `migration.py` — the read-only-by-default one-time cutover importer for the
  legacy Full CI cache, last-reported build state, analyzer memory, and Fast CI
  SQLite deduplication keys.
- `control.py` — applies durable per-path `shadow`, `live`, or `disabled`
  controls from S3 to the three systemd timers. Missing controls default to
  `shadow`.
- `cutover.py` — exports persisted shadow payloads for comparison and archives
  pending live payloads as non-deliverable shadow records during rollback.
- `postgres.py` — production execution, outbox, Fast CI, Full CI, and Main CI
  stores.
  `PostgresAlertStore.commit_scan` performs the event inserts, batch inserts,
  cursor update, and execution completion in one Postgres transaction;
  `commit_reconciliation` atomically stores ordered Full CI runs, outcomes,
  comparisons, and execution completion; `commit_main_ci_scan` atomically
  advances exact job state, opens/updates/resolves alert episodes, advances the
  cursor, and completes execution. Runtime factories wire the production
  Databricks and Buildkite clients.
- `slack.py` — configured incoming-webhook and bot-token delivery. It resolves
  logical webhook destinations without storing webhook secrets in Postgres,
  adds stable delivery metadata for duplicate diagnosis, classifies Slack
  responses, and exposes rate-limit retry timing.
- `memory.py` — in-memory adapters used by tests; they document the
  semantics the Postgres adapters must provide.
- `../migrations/` — repository-wide Python migration module. Alert Production
  owns its table definitions there; dashboard request handlers only read or
  write data and never mutate schema.

## One-time legacy import

Copy the four legacy state sources to the cutover host after fencing the old
automations. Preview the import first; this reads local files only:

```bash
uv run --extra aws --extra postgres vllm-alerting-import \
  --failure-cache /path/to/.logs/failed_tests_cache.json \
  --reported-builds /path/to/.logs/last_reported_builds.txt \
  --analyzer-memory /path/to/vllm-ci-failure-analyzer \
  --fast-ci-state /path/to/state.sqlite3
```

Set `DATABASE_URL`, `BUILDKITE_TOKEN`, and `ANALYZER_CHECKPOINT_BUCKET`, then
repeat with `--apply --confirm-target HOST:PORT/DATABASE`. The importer fetches
the Full CI build named by the failure cache and verifies its commit while
preserving the last-reported build list independently. This handles a legacy
run that updated analyzer state but failed Slack delivery before updating the
reported-build file. It uploads analyzer memory as the initial immutable S3
checkpoint and commits all Postgres references and successfully alerted Fast
CI job IDs in one transaction. Temporary SQLite reservations remain eligible
for the new scanner. A failed Postgres commit can leave an unreferenced S3
object; it does not change the authoritative baseline. Re-running the same
import is idempotent, while different Full CI baseline data is rejected.

## Shadow mode and cutover

Every notification intent records its alert path and whether it was rendered
in `shadow` or `live` mode. Dispatch leasing selects only live records for the
runtime's own path, so a Fast CI cutover cannot release Full CI output and a
later mode change cannot release historical shadow output.

Use [`deploy/aws/cutover-wizard.sh`](../deploy/aws/cutover-wizard.sh) for both
cutover and rollback. It keeps control metadata under the checkpoint bucket,
requires confirmation before each external change, fences the old path before
enabling the new path, and preserves Postgres and S3 baselines on rollback.

## Extension points (later tickets)

- `FastCIScanHandler` registers as `fast_ci_scan`,
  `FullCIReconciliationHandler` registers as `full_ci_reconcile`, and
  `FullCIAnalysisHandler` registers as `full_ci_analyze`, while
  `MainCIReconciliationHandler` registers as `main_ci_reconcile`,
  `MainCIBackstopHandler` registers as `main_ci_backstop`, and
  `MainCIAnalysisHandler` registers as `main_ci_analyze`. Workers expose them
  as the `fast-ci`, `full-ci`, `full-ci-analyze`, `main-ci`,
  `main-ci-backstop`, and
  `main-ci-analyze` consumers so the
  long-running LLM analysis never blocks ingest. The Main CI analysis consumer
  writes only the `alerting_main_ci_job_analysis` sidecar table; the
  deterministic alert lifecycle stays owned by `main_ci_reconcile`.
- The Postgres adapters must mark an execution complete in the same
  transaction that commits the handler's durable effects, and lease outbox
  rows with `FOR UPDATE SKIP LOCKED`. Connect with prepared statements
  disabled (psycopg `prepare_threshold=None`) if pointed at the Supavisor
  transaction pooler, and keep pools small — the dashboard's pool is capped
  at 3 connections.
- Dispatcher retries use bounded exponential backoff with jitter. Slack
  `Retry-After` values override that delay, while permanent configuration and
  payload errors move notification intents to dead-letter state.

## Development

```bash
cd alerting
uv sync --extra dev
uv run pytest
uv run mypy __init__.py analyzer.py commands.py control.py cutover.py fast_ci.py full_ci.py kimi.py main_ci.py main_ci_analysis.py memory.py migration.py ports.py postgres.py retention.py runtime.py slack.py worker.py tests
uv run ruff check .
```
