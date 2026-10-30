-- CI selector health: whether the recordings ci-selector decides from are
-- whole and fresh, and whether PR builds pick them up. The Full CI collect
-- steps are soft_fail, so a broken collect never turns a build red; these
-- tables are what the worker alerts from and the /selector page reads.
ALTER TABLE alerting_notification_outbox
    DROP CONSTRAINT IF EXISTS alerting_notification_outbox_path_check;
ALTER TABLE alerting_notification_outbox
    ADD CONSTRAINT alerting_notification_outbox_path_check
    CHECK (alert_path IN ('fast_ci', 'full_ci', 'main_ci', 'infra', 'selector'));

-- One scheduled Full CI Run (`Full CI run - nightly` or `- daily`). A run is
-- settled once both collect jobs finished; the worker never refetches it.
CREATE TABLE IF NOT EXISTS alerting_selector_full_runs (
    build_number integer PRIMARY KEY,
    kind         text NOT NULL CHECK (kind IN ('nightly', 'daily')),
    created_at   timestamptz NOT NULL,
    commit_sha   text NOT NULL,
    build_state  text NOT NULL,
    settled      boolean NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alerting_selector_full_runs_created_idx
    ON alerting_selector_full_runs (created_at DESC);

-- One recording (fnrec, CUDA and ROCm kernel tables) or symbol map of one run,
-- read from the collect job's summary artifact (ci-infra#881) or its log.
CREATE TABLE IF NOT EXISTS alerting_selector_run_components (
    build_number     integer NOT NULL
        REFERENCES alerting_selector_full_runs (build_number) ON DELETE CASCADE,
    component        text NOT NULL CHECK (
        component IN ('fnrec', 'kernrec_cuda', 'kernrec_rocm', 'map_cuda', 'map_rocm')
    ),
    status           text NOT NULL CHECK (status IN ('ok', 'broken', 'off', 'pending')),
    job_state        text,
    soft_failed      boolean NOT NULL DEFAULT false,
    exit_status      integer,
    expected_jobs    integer,
    delivered_jobs   integer,
    row_count        integer,
    verdict          text,
    published        boolean NOT NULL DEFAULT false,
    published_commit text,
    source           text NOT NULL CHECK (source IN ('summary', 'log', 'artifacts', 'none')),
    PRIMARY KEY (build_number, component)
);

-- The selector decision each non-main build's bootstrap uploaded; `missing`
-- when it uploaded none (docs-only builds, a failed bootstrap).
CREATE TABLE IF NOT EXISTS alerting_selector_decisions (
    build_number    integer PRIMARY KEY,
    created_at      timestamptz NOT NULL,
    branch          text NOT NULL,
    pull_request    integer,
    outcome         text NOT NULL
        CHECK (outcome IN ('applied', 'skipped', 'fallback', 'missing')),
    reason          text,
    seconds         double precision,
    fnrec_build     integer,
    kernrec_build   integer,
    ci_infra_commit text,
    observed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alerting_selector_decisions_created_idx
    ON alerting_selector_decisions (created_at DESC);

-- One episode per (condition, subject); the partial unique index keeps at
-- most one open, and each episode sends one Slack message edited on resolve.
CREATE TABLE IF NOT EXISTS alerting_selector_alerts (
    alert_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition   text NOT NULL
        CHECK (condition IN ('run_incomplete', 'stale', 'pr_stale', 'pr_errors')),
    subject_key text NOT NULL,
    status      text NOT NULL CHECK (status IN ('open', 'resolved')),
    opened_at   timestamptz NOT NULL,
    resolved_at timestamptz,
    details     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (status = 'open' AND resolved_at IS NULL)
        OR (status = 'resolved' AND resolved_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS alerting_selector_alerts_open_idx
    ON alerting_selector_alerts (condition, subject_key)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS alerting_selector_alerts_history_idx
    ON alerting_selector_alerts (status, (COALESCE(resolved_at, opened_at)) DESC);

-- These tables are reachable only through trusted server-side connections.
ALTER TABLE public.alerting_selector_full_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_selector_run_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_selector_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_selector_alerts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
    protected_tables constant text :=
        'public.alerting_selector_full_runs, public.alerting_selector_run_components, public.alerting_selector_decisions, public.alerting_selector_alerts';
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
                'REVOKE ALL PRIVILEGES ON SEQUENCE public.alerting_selector_alerts_alert_id_seq FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END;
$$;
