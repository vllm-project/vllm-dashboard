-- AI analysis is a sidecar to the Main CI alert lifecycle. The deterministic
-- reconcile slice owns alerting_main_ci_job_alerts; the probabilistic analyzer
-- only ever writes here, one row per alert, upserted on re-analysis. An
-- analysis is stale when analyzed_failure_job_id no longer matches the alert's
-- last_failure_job_id; stale rows are kept, never deleted.
--
-- Retention: Main CI alert rows are not age-pruned, so analysis rows need no
-- pruning of their own. The cascade keeps an alert's analysis from outliving
-- the alert if its row is ever deleted.
CREATE TABLE IF NOT EXISTS alerting_main_ci_job_analysis (
    alert_id                bigint PRIMARY KEY
        REFERENCES alerting_main_ci_job_alerts (alert_id) ON DELETE CASCADE,
    analyzed_failure_job_id text NOT NULL,
    classification          text NOT NULL
        CHECK (classification IN ('infra', 'flaky', 'code', 'test', 'unknown')),
    confidence              text NOT NULL
        CHECK (confidence IN ('high', 'medium', 'low')),
    summary                 text NOT NULL,
    evidence_urls           jsonb NOT NULL DEFAULT '[]'::jsonb,
    recommended_action      text NOT NULL,
    -- Each entry is {"url": text, "number": int|null, "title": text}.
    suspected_fix_prs       jsonb NOT NULL DEFAULT '[]'::jsonb,
    model_version           text NOT NULL,
    analyzed_at             timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL
);

ALTER TABLE public.alerting_main_ci_job_analysis ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
    protected_tables constant text :=
        'public.alerting_main_ci_job_analysis';
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
