-- Operational hardening & GitHub webhook ingestion:
--   1. `triage_runs`: structured run telemetry and non-fatal warnings so
--      rejected maintainer files, partial relevance judgements, and ingest
--      warnings aren't lost to systemd stdout discard and surface in Pipeline Health.
--   2. `triage_scores.unowned_reason`: router-computed explanation persisted on
--      unowned P0/P1 items so the dashboard reads it directly without duplicating
--      router rules.
--   3. `triage_webhook_queue`: idempotent queue populated by `/api/triage/webhook`
--      and drained by `triage-ingest` for low-latency event-driven ingestion.

CREATE TABLE IF NOT EXISTS triage_runs (
    id          bigserial PRIMARY KEY,
    consumer    text NOT NULL,
    started_at  timestamptz NOT NULL,
    finished_at timestamptz NOT NULL DEFAULT now(),
    status      text NOT NULL CHECK (status IN ('ok', 'warning', 'error')),
    summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
    warnings    jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS triage_runs_consumer_idx
    ON triage_runs (consumer, finished_at DESC);

ALTER TABLE triage_scores
    ADD COLUMN IF NOT EXISTS unowned_reason jsonb;

CREATE TABLE IF NOT EXISTS triage_webhook_queue (
    repo        text NOT NULL,
    number      integer NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('issue', 'pr')),
    event       text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    attempts    integer NOT NULL DEFAULT 0,
    PRIMARY KEY (repo, number)
);

CREATE INDEX IF NOT EXISTS triage_webhook_queue_received_idx
    ON triage_webhook_queue (received_at ASC);

ALTER TABLE triage_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_webhook_queue ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE triage_runs, triage_webhook_queue FROM %I',
                api_role
            );
        END IF;
    END LOOP;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'triage_extractor') THEN
        GRANT INSERT ON triage_runs TO triage_extractor;
        GRANT USAGE ON SEQUENCE triage_runs_id_seq TO triage_extractor;
        DROP POLICY IF EXISTS triage_extractor_runs_insert ON triage_runs;
        CREATE POLICY triage_extractor_runs_insert ON triage_runs
            FOR INSERT TO triage_extractor WITH CHECK (true);
    END IF;
END
$$;
