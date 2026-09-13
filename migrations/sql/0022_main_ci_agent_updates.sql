-- Authenticated responders add append-only notes beside the deterministic
-- alert lifecycle and the worker-owned analysis row. Tying each update to the
-- exact failure job lets the dashboard mark it stale when a later failure is
-- observed. idempotency_key makes network retries safe without allowing one
-- request to overwrite another responder's history.
CREATE TABLE IF NOT EXISTS alerting_main_ci_job_updates (
    update_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    alert_id        bigint NOT NULL
        REFERENCES alerting_main_ci_job_alerts (alert_id) ON DELETE CASCADE,
    failure_job_id  text NOT NULL
        CHECK (length(btrim(failure_job_id)) BETWEEN 1 AND 128),
    kind            text NOT NULL
        CHECK (kind IN ('note', 'diagnosis', 'fix_opened', 'monitoring')),
    message         text NOT NULL
        CHECK (length(btrim(message)) BETWEEN 1 AND 4000),
    -- Each entry is {"url": text, "number": int|null, "title": text}.
    fix_prs         jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (
            CASE WHEN jsonb_typeof(fix_prs) = 'array' THEN
                jsonb_array_length(fix_prs) <= 10
                AND (kind <> 'fix_opened' OR jsonb_array_length(fix_prs) > 0)
            ELSE false END
        ),
    author          text NOT NULL
        CHECK (length(btrim(author)) BETWEEN 1 AND 80),
    idempotency_key text NOT NULL UNIQUE
        CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_main_ci_job_updates_alert_created
    ON alerting_main_ci_job_updates (alert_id, created_at DESC, update_id DESC);

ALTER TABLE public.alerting_main_ci_job_updates ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
    protected_tables constant text :=
        'public.alerting_main_ci_job_updates';
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I',
                protected_tables,
                api_role
            );
        END IF;
    END LOOP;
END;
$$;
