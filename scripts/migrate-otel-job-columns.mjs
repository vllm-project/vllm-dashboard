import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const sql = postgres(url, {
  ssl: "require",
  max: 1,
  prepare: false,
  idle_timeout: 0,
  connect_timeout: 30,
});

// How far back to backfill the extracted columns. Older history is served by
// the Databricks source, so we only need the recent window the dashboard shows.
const BACKFILL_DAYS = process.env.BACKFILL_DAYS ?? "90";

// CREATE INDEX CONCURRENTLY over the full (16M+) span table is slow (tens of
// minutes per index on this instance) and must not be killed mid-build, which
// would leave an invalid index. Each runs in its own session with no statement
// timeout.
async function indexConcurrently(name, definition) {
  console.log(`building ${name}...`);
  const t = Date.now();
  // Drop any invalid leftover from a previously interrupted concurrent build.
  await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
  await sql.unsafe(definition);
  console.log(`${name} built in ${Date.now() - t}ms`);
}

const startedAt = Date.now();
try {
  await sql.unsafe("SET statement_timeout = 0");

  console.log("adding columns...");
  await sql.unsafe(`
    ALTER TABLE otel_spans
      ADD COLUMN IF NOT EXISTS job_type TEXT,
      ADD COLUMN IF NOT EXISTS job_passed TEXT,
      ADD COLUMN IF NOT EXISTS job_soft_failed TEXT,
      ADD COLUMN IF NOT EXISTS job_exit_status INTEGER,
      ADD COLUMN IF NOT EXISTS job_wait_time_ms DOUBLE PRECISION
  `);

  console.log(`backfilling job columns for buildkite.job spans (last ${BACKFILL_DAYS}d)...`);
  const res = await sql.unsafe(`
    UPDATE otel_spans
    SET
      job_type = span_attributes->>'buildkite.job.type',
      job_passed = span_attributes->>'buildkite.job.passed',
      job_soft_failed = span_attributes->>'buildkite.job.soft_failed',
      job_exit_status = CASE
        WHEN span_attributes->>'buildkite.job.exit_status' ~ '^-?\\d+$'
        THEN (span_attributes->>'buildkite.job.exit_status')::integer END,
      job_wait_time_ms = CASE
        WHEN span_attributes->>'buildkite.job.wait_time_ms' ~ '^\\d+(\\.\\d+)?$'
        THEN (span_attributes->>'buildkite.job.wait_time_ms')::double precision END
    WHERE span_name = 'buildkite.job'
      AND start_time > NOW() - INTERVAL '${BACKFILL_DAYS} days'
      AND job_type IS NULL
  `);
  console.log(`backfilled ${res.count} rows in ${Date.now() - startedAt}ms`);

  console.log("creating indexes...");
  // Job scans filtered by pipeline + time (builds/jobs/queue/cost routes).
  await indexConcurrently("idx_otel_spans_job_type_time", `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otel_spans_job_type_time
    ON otel_spans (pipeline_slug, start_time DESC)
    WHERE span_name = 'buildkite.job' AND job_type = 'script'
  `);
  // Covering index so the above scans are index-only (no heap fetch). Includes
  // every column the CI dashboard reads from a job span.
  await indexConcurrently("idx_otel_spans_job_type_cover", `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otel_spans_job_type_cover
    ON otel_spans (pipeline_slug, start_time DESC)
    INCLUDE (job_label, job_state, job_passed, job_soft_failed, agent_queue, job_wait_time_ms, duration_ms, build_number)
    WHERE span_name = 'buildkite.job' AND job_type = 'script'
  `);
  // Build spans by pipeline + time (builds route).
  await indexConcurrently("idx_otel_spans_build_pipeline_time", `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otel_spans_build_pipeline_time
    ON otel_spans (pipeline_slug, start_time DESC)
    WHERE span_name = 'buildkite.build'
  `);
  // Join key for job -> build self-join (build_id is NULL on Buildkite spans).
  await indexConcurrently("idx_otel_spans_build_pipeline_number", `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otel_spans_build_pipeline_number
    ON otel_spans (pipeline_slug, build_number)
    WHERE span_name = 'buildkite.build'
  `);
  // Queue stats/trend aggregated per agent_queue.
  await indexConcurrently("idx_otel_spans_job_queue_time", `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otel_spans_job_queue_time
    ON otel_spans (agent_queue, start_time DESC)
    WHERE span_name = 'buildkite.job' AND agent_queue IS NOT NULL
  `);

  console.log("VACUUM ANALYZE (sets visibility map so index-only scans work)...");
  await sql.unsafe("VACUUM ANALYZE otel_spans");

  console.log(`done in ${Date.now() - startedAt}ms`);
} finally {
  await sql.end();
}
