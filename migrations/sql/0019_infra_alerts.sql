-- Infra health alerting: per-subject scan state is separate from alert
-- episodes, following the Main CI state/episode split. A subject is a host
-- (unreporting), a shared (fstype, device) disk group (disk_usage), or one
-- GPU on one host (gpu_temperature), so a fleet-wide NFS volume pages once
-- no matter how many hosts mount it.
ALTER TABLE alerting_notification_outbox
    DROP CONSTRAINT IF EXISTS alerting_notification_outbox_path_check;
ALTER TABLE alerting_notification_outbox
    ADD CONSTRAINT alerting_notification_outbox_path_check
    CHECK (alert_path IN ('fast_ci', 'full_ci', 'main_ci', 'infra'));

-- Durable per-subject scan state carried between five-minute scans. An
-- episode opens only after consecutive_breaches reaches the configured
-- consecutive_scans, and a host absent from every expected source and silent
-- for seven days is retired here so the dashboard can show it.
CREATE TABLE IF NOT EXISTS alerting_infra_host_states (
    alert_type           text NOT NULL
        CHECK (alert_type IN ('unreporting', 'disk_usage', 'gpu_temperature')),
    subject_key          text NOT NULL,
    consecutive_breaches integer NOT NULL DEFAULT 0
        CHECK (consecutive_breaches >= 0),
    last_reported_at     timestamptz,
    retired_at           timestamptz,
    details              jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (alert_type, subject_key),
    CHECK (subject_key = lower(subject_key)),
    CHECK (retired_at IS NULL OR alert_type = 'unreporting')
);

-- An alert is one breach episode. Exactly two notifications exist per
-- episode (open and resolve); the partial unique index guarantees at most
-- one open episode per subject.
CREATE TABLE IF NOT EXISTS alerting_infra_alerts (
    alert_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    alert_type   text NOT NULL
        CHECK (alert_type IN ('unreporting', 'disk_usage', 'gpu_temperature')),
    subject_key  text NOT NULL,
    status       text NOT NULL CHECK (status IN ('open', 'resolved')),
    opened_at    timestamptz NOT NULL,
    resolved_at  timestamptz,
    details      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (status = 'open' AND resolved_at IS NULL)
        OR (status = 'resolved' AND resolved_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS alerting_infra_alerts_open_idx
    ON alerting_infra_alerts (alert_type, subject_key)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS alerting_infra_alerts_history_idx
    ON alerting_infra_alerts (
        status, (COALESCE(resolved_at, opened_at)) DESC
    );

-- These tables are reachable only through trusted server-side connections.
ALTER TABLE public.alerting_infra_host_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_infra_alerts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
    protected_tables constant text :=
        'public.alerting_infra_host_states, public.alerting_infra_alerts';
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I',
                protected_tables,
                api_role
            );
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON SEQUENCE public.alerting_infra_alerts_alert_id_seq FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END;
$$;
