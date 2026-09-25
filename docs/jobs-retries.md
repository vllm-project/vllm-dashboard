# Job retries

Open **Jobs → Retry Ranking** to compare retry counts by job. The view
shares the Jobs page's pipeline, branch, and time-range controls, including
hourly presets and custom dates. Search matches job names and hardware vendors;
the optional and soft-fail filters recalculate the displayed counts. Jobs rank
by descending retry count, with sorting by name or total attempts also available.
Select a job row to see its attempt history; name buttons also support keyboard
navigation. Only jobs with at least one retry in the selected period are shown.
Summary counts and pagination describe individual jobs across the whole selection.
A period with no retries shows **No retries in this period**.

Retry counts use amber bars and values. Empty summary counts are green. Bar lengths
compare counts with the most-retried job in the current selection.

The **CI** selection includes its AMD mirrors. Choose **AMD CI** for the separate
AMD pipeline, or **All Pipelines** to combine them. Searching **AMD** also finds
jobs whose vendor is rendered as an icon and native device-prefixed labels such
as `mi325_1: Basic Correctness`.
Vendor logos follow explicit `:amd:` / `:nvidia:` markers; native AMD device
prefixes and historical `AMD:` prefixes also display the AMD logo. Unmarked
job names do not imply a GPU vendor.

The attempt-history chart uses amber for retries and green for original
attempts, independently of pass/fail outcome. Hover an attempt for its outcome,
start time, and commit; attempts with a Buildkite URL open the job when clicked.
The history retains the ranking's time range, pipeline, branch, and data source.
Load failures show an error and a **Try again** action rather than an empty history.

## Counting

A retry is an additional Buildkite job attempt, regardless of its outcome.
An original failed job contributes zero retries. An original attempt followed
by a failed retry and a successful retry contributes **two retries** and
**three total attempts**. The retry ordinals `0, 1, 2` are not added together.
Parallel shards and separate builds are not inferred to be retries.

The query uses explicit retry metadata and deduplicates attempts by Buildkite
job ID. Buildkite documents the retry ordinal and predecessor fields in its
[OpenTelemetry job attributes](https://buildkite.com/docs/pipelines/integrations/observability/opentelemetry).
Retries without recorded retry metadata cannot be inferred reliably.

The time range selects **attempt start times**, so a retry is counted even when
its original attempt is outside the range. Date-only end dates include that
entire UTC day; timestamp end bounds are exact and exclusive. Clearing the
time range requests all available history.

The OpenTelemetry source only contains completed job spans reported by Buildkite.
The warehouse can also contain attempts that have started and are still running.
Counts reflect the selected source's coverage and ingestion delay; they do not
include scheduled attempts that never started. Each exact job name has its own
ranking row, including distinct AMD and NVIDIA variants. Ranking does not depend
on test-area mappings or GitHub metadata.

## API

`GET /api/jobs/retries?pipeline=CI&branch=main&window=14d`

The response contains `source` and a flat `retryRanking` list. Each job has `name`,
`retries`, `total_runs`, and `has_soft_fail`. Counts are numbers; `total_runs`
includes original and retry attempts. Jobs default to descending retry count,
with job name breaking ties. The API retains
observed zero-retry jobs; the ranking view filters them out.

Use `startDate` and `endDate` for custom ranges; explicit dates take precedence
over `window`. Empty `pipeline=` and `branch=` select all pipelines and branches;
omitting those parameters defaults to `CI` and `main`. `source=otel` or
`source=databricks` overrides the configured source, as in the other CI APIs.
The endpoint shares concurrent requests and caches results for one minute.

`GET /api/jobs/retries/runs` accepts the same filters plus a required exact
`jobName`. It returns `source` and chronological `runs`, including original
attempts and retries. Each run provides `job_id`, `is_retry`, `state`,
`started_at`, `finished_at`, `duration_secs`, `commit_sha`, `build_number`,
`build_created_at`, and `web_url`. Retry classification and time bounds share
the ranking's query logic so drilldown counts reconcile with the selected row.

## Local verification

Run `npm test`, `npm run lint`, and `npm run build`. The retry tests cover range
validation, job ranking, filters, request coalescing, cache isolation, and recovery
after a query error.

An optional SQL fixture test executes both aggregates in a local PostgreSQL
engine, with no database credentials. It checks multiple retries, successful
retries, failed originals, duplicate records, parallel shards, and time bounds.
Install its test engine outside the checkout and enable it explicitly:

```bash
npm install --prefix /tmp/vllm-retry-sql --no-audit --no-fund @electric-sql/pglite
RETRY_TEST_PGLITE_MODULE=/tmp/vllm-retry-sql/node_modules/@electric-sql/pglite/dist/index.js npm test
```

The warehouse fixture adapts table names and parameter markers to PostgreSQL;
it does not validate a live Databricks deployment or production data coverage.
