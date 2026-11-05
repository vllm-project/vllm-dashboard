-- Eval regression alert episodes.
--
-- Each row tracks one regression episode for a (model, task, n_shot, metric,
-- filter) combination — matching the evalKey in compare.ts.  An episode opens
-- when a nightly result regresses beyond the sigma threshold relative to the
-- baseline, and resolves when a later check positively shows recovery.
-- Missing data (no candidate rows, partial failures) never opens or resolves
-- an episode.

CREATE TABLE IF NOT EXISTS alerting_eval_regression_alerts (
    alert_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model               text NOT NULL,
    task                text NOT NULL,
    n_shot              integer NOT NULL,
    metric              text NOT NULL,
    filter              text NOT NULL,
    higher_is_better    boolean NOT NULL DEFAULT true,
    unit                text NOT NULL DEFAULT 'score',
    status              text NOT NULL CHECK (status IN ('open', 'resolved')),
    baseline_image      text NOT NULL,
    baseline_value      double precision NOT NULL,
    candidate_image     text NOT NULL,
    candidate_value     double precision NOT NULL,
    delta               double precision NOT NULL,
    delta_pct           double precision,
    significance        double precision,
    opened_at           timestamptz NOT NULL DEFAULT now(),
    resolved_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (status = 'open' AND resolved_at IS NULL)
        OR
        (status = 'resolved' AND resolved_at IS NOT NULL)
    )
);

-- Only one open alert per (model, task, n_shot, metric, filter).
CREATE UNIQUE INDEX IF NOT EXISTS alerting_eval_regression_alerts_open_idx
    ON alerting_eval_regression_alerts (model, task, n_shot, metric, filter)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS alerting_eval_regression_alerts_history_idx
    ON alerting_eval_regression_alerts (
        status, COALESCE(resolved_at, opened_at) DESC
    );

-- Snapshot of each cron comparison run for history and debugging.
-- status includes 'skipped' for runs where data was absent, so the banner
-- can distinguish "healthy" from "cron stopped running".
CREATE TABLE IF NOT EXISTS alerting_eval_regression_snapshots (
    snapshot_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    baseline_image      text NOT NULL DEFAULT 'unknown',
    candidate_image     text NOT NULL DEFAULT 'unknown',
    status              text NOT NULL CHECK (status IN ('pass', 'regression', 'skipped', 'error')),
    summary             jsonb NOT NULL,
    compare_url         text,
    checked_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alerting_eval_regression_snapshots_checked_idx
    ON alerting_eval_regression_snapshots (checked_at DESC);

-- Daily Slack message tracking (one consolidated message per Pacific day,
-- updated in place like queue alerts).
CREATE TABLE IF NOT EXISTS alerting_eval_alert_summary (
    id              text PRIMARY KEY,
    message_ts      text NOT NULL,
    status          text,
    regression_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Carries the last notification state across Pacific days so a new day
-- does not fire a spurious all-clear, and a cron heartbeat so the banner
-- can distinguish "cron alive, data unchanged" from "cron stopped".
CREATE TABLE IF NOT EXISTS alerting_eval_last_notified (
    id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    status          text,
    regression_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
    last_checked_at timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.alerting_eval_last_notified ENABLE ROW LEVEL SECURITY;

-- Row-level security.
ALTER TABLE public.alerting_eval_regression_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_eval_regression_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_eval_alert_summary ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
    protected_tables constant text :=
        'public.alerting_eval_regression_alerts, '
        'public.alerting_eval_regression_snapshots, '
        'public.alerting_eval_alert_summary, '
        'public.alerting_eval_last_notified';
    seq_names constant text[] := ARRAY[
        'public.alerting_eval_regression_alerts_alert_id_seq',
        'public.alerting_eval_regression_snapshots_snapshot_id_seq'
    ];
    seq_name text;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I',
                protected_tables,
                api_role
            );
            FOREACH seq_name IN ARRAY seq_names
            LOOP
                EXECUTE format(
                    'REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM %I',
                    seq_name,
                    api_role
                );
            END LOOP;
        END IF;
    END LOOP;
END;
$$;
