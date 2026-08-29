-- Current Main CI job state is separate from alert episodes. This prevents an
-- older build that finishes late from reopening or resolving a newer outcome.
CREATE TABLE IF NOT EXISTS alerting_main_ci_scan_cursors (
    cursor_name     text PRIMARY KEY CHECK (cursor_name = 'main_ci'),
    scanned_through timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerting_main_ci_job_states (
    job_key                     text PRIMARY KEY,
    job_name                    text NOT NULL,
    latest_job_id               text NOT NULL UNIQUE,
    latest_job_state            text NOT NULL
        CHECK (latest_job_state IN ('passed', 'failed', 'failing', 'broken', 'timed_out')),
    latest_finished_at          timestamptz NOT NULL,
    latest_build_id             text NOT NULL,
    latest_build_number         bigint NOT NULL,
    latest_build_url            text NOT NULL,
    latest_job_url              text NOT NULL,
    latest_commit_sha           text NOT NULL,
    updated_at                  timestamptz NOT NULL
);

-- An alert is one failure episode. Repeated failures update the open episode;
-- a positively observed pass resolves it, and a later failure opens a new one.
CREATE TABLE IF NOT EXISTS alerting_main_ci_job_alerts (
    alert_id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_key                     text NOT NULL,
    job_name                    text NOT NULL,
    status                      text NOT NULL
        CHECK (status IN ('open', 'resolved')),
    opened_at                   timestamptz NOT NULL,
    first_failure_job_id        text NOT NULL,
    first_failure_state         text NOT NULL
        CHECK (first_failure_state IN ('failed', 'failing', 'broken', 'timed_out')),
    first_failure_build_id      text NOT NULL,
    first_failure_build_number  bigint NOT NULL,
    first_failure_build_url     text NOT NULL,
    first_failure_job_url       text NOT NULL,
    first_failure_commit_sha    text NOT NULL,
    last_failed_at              timestamptz NOT NULL,
    last_failure_job_id         text NOT NULL,
    last_failure_state          text NOT NULL
        CHECK (last_failure_state IN ('failed', 'failing', 'broken', 'timed_out')),
    last_failure_build_id       text NOT NULL,
    last_failure_build_number   bigint NOT NULL,
    last_failure_build_url      text NOT NULL,
    last_failure_job_url        text NOT NULL,
    last_failure_commit_sha     text NOT NULL,
    failure_count               integer NOT NULL CHECK (failure_count > 0),
    resolved_at                 timestamptz,
    resolution_job_id           text,
    resolution_build_id         text,
    resolution_build_number     bigint,
    resolution_build_url        text,
    resolution_job_url          text,
    resolution_commit_sha       text,
    created_at                  timestamptz NOT NULL,
    updated_at                  timestamptz NOT NULL,
    CHECK (
        (status = 'open'
         AND resolved_at IS NULL
         AND resolution_job_id IS NULL
         AND resolution_build_id IS NULL
         AND resolution_build_number IS NULL
         AND resolution_build_url IS NULL
         AND resolution_job_url IS NULL
         AND resolution_commit_sha IS NULL)
        OR
        (status = 'resolved'
         AND resolved_at IS NOT NULL
         AND resolution_job_id IS NOT NULL
         AND resolution_build_id IS NOT NULL
         AND resolution_build_number IS NOT NULL
         AND resolution_build_url IS NOT NULL
         AND resolution_job_url IS NOT NULL
         AND resolution_commit_sha IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS alerting_main_ci_job_alerts_open_idx
    ON alerting_main_ci_job_alerts (job_key)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS alerting_main_ci_job_alerts_history_idx
    ON alerting_main_ci_job_alerts (
        status, (COALESCE(resolved_at, last_failed_at)) DESC
    );

-- The worker has no Main CI Slack renderer yet, but path-scoping it now keeps
-- controls and any future outbox records independent from Fast and Full CI.
ALTER TABLE alerting_notification_outbox
    DROP CONSTRAINT IF EXISTS alerting_notification_outbox_path_check;
ALTER TABLE alerting_notification_outbox
    ADD CONSTRAINT alerting_notification_outbox_path_check
    CHECK (alert_path IN ('fast_ci', 'full_ci', 'main_ci'));

ALTER TABLE public.alerting_main_ci_scan_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_main_ci_job_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_main_ci_job_alerts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
    protected_tables constant text :=
        'public.alerting_main_ci_scan_cursors, '
        'public.alerting_main_ci_job_states, '
        'public.alerting_main_ci_job_alerts';
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
