import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set");
}

const sql = postgres(url, { ssl: "require", max: 1, prepare: false });
const startedAt = Date.now();

try {
  await sql`
    CREATE TABLE IF NOT EXISTS otel_spans (
      trace_id                   TEXT NOT NULL,
      span_id                    TEXT NOT NULL,
      parent_span_id             TEXT,
      trace_state                TEXT,
      trace_flags                INTEGER NOT NULL DEFAULT 0,
      span_name                  TEXT NOT NULL,
      span_kind                  SMALLINT NOT NULL DEFAULT 0,
      start_time                 TIMESTAMPTZ NOT NULL,
      end_time                   TIMESTAMPTZ NOT NULL,
      duration_ms                DOUBLE PRECISION NOT NULL,
      status_code                SMALLINT NOT NULL DEFAULT 0,
      status_message             TEXT,
      service_name               TEXT,
      scope_name                 TEXT,
      scope_version              TEXT,
      resource_schema_url        TEXT,
      scope_schema_url           TEXT,
      organization_slug          TEXT,
      pipeline_slug              TEXT,
      build_id                   TEXT,
      build_number               BIGINT,
      build_state                TEXT,
      step_id                    TEXT,
      step_key                   TEXT,
      job_id                     TEXT,
      job_label                  TEXT,
      job_state                  TEXT,
      agent_id                   TEXT,
      agent_name                 TEXT,
      agent_queue                TEXT,
      resource_attributes        JSONB NOT NULL DEFAULT '{}',
      span_attributes            JSONB NOT NULL DEFAULT '{}',
      span_events                JSONB NOT NULL DEFAULT '[]',
      span_links                 JSONB NOT NULL DEFAULT '[]',
      dropped_attributes_count   INTEGER NOT NULL DEFAULT 0,
      dropped_events_count       INTEGER NOT NULL DEFAULT 0,
      dropped_links_count        INTEGER NOT NULL DEFAULT 0,
      received_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (trace_id, span_id)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_otel_spans_received
    ON otel_spans (received_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_otel_spans_build
    ON otel_spans (organization_slug, pipeline_slug, build_number, start_time)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_otel_spans_build_id
    ON otel_spans (build_id, start_time)
    WHERE build_id IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_otel_spans_job
    ON otel_spans (job_id, start_time)
    WHERE job_id IS NOT NULL
  `;

  const [stats] = await sql`
    SELECT COUNT(*)::bigint AS spans, MAX(received_at) AS latest_received_at
    FROM otel_spans
  `;
  console.log(
    `OTel migration complete: ${stats.spans} spans in ${Date.now() - startedAt}ms ` +
      `(latest ${stats.latest_received_at?.toISOString() ?? "none"})`,
  );
} finally {
  await sql.end();
}
