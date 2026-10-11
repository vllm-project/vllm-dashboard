-- Quarantine records and shared-cause incidents for the CI stability pilot.
--
-- The EC2 alerting worker owns these tables and decides everything; the
-- dashboard operator endpoints (return, confirm, close) only write the record
-- and the worker and timers act on it. Tables are server-only: the Supabase API
-- roles get no access, matching the other alerting tables.

-- One row per quarantine of one host. The pause or taint is only the effect of
-- the record; closing it returns the host. Hand cordons and pauses the pilot
-- did not make are recorded as state = 'manual'. Closing overwrites state, so
-- origin keeps what the row was: the pilot's own ('auto'), a dry-run decision
-- ('dry_run', state 'would' while open) or a person's cordon ('manual').
CREATE TABLE IF NOT EXISTS alerting_quarantine_records (
    record_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Lowercased agent hostname or Kubernetes node name.
    host          text NOT NULL
        CHECK (length(btrim(host)) BETWEEN 1 AND 253),
    pool          text NOT NULL
        CHECK (length(btrim(pool)) BETWEEN 1 AND 80),
    origin        text NOT NULL CHECK (origin IN ('auto', 'dry_run', 'manual')),
    -- NULL only for manual rows, which have no tier.
    tier          text CHECK (tier IN ('soft', 'hard')),
    -- NULL only for a manual row whose person gave no reason.
    reason        text
        CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
    -- Who made a hand cordon or pause, when known; NULL for the pilot's rows.
    opened_by     text
        CHECK (opened_by IS NULL OR length(btrim(opened_by)) BETWEEN 1 AND 80),
    signal_detail jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(signal_detail) = 'object'),
    state         text NOT NULL
        CHECK (state IN ('would', 'live', 'held', 'manual', 'closed')),
    -- The fault's own timestamp; for manual rows, when the cordon was seen.
    fault_at      timestamptz NOT NULL,
    -- NULL until the pause or taint takes effect (never set for would/held).
    effective_at  timestamptz,
    -- Soft quarantines lift by themselves when this passes; hard have none.
    lease_until   timestamptz,
    closed_at     timestamptz,
    closed_by     text
        CHECK (closed_by IS NULL OR length(btrim(closed_by)) BETWEEN 1 AND 80),
    close_how     text
        CHECK (close_how IN (
            'returned', 'checks_passed', 'lease_expired', 'removed_by_hand'
        )),
    -- Free-text reason a person gave when returning the host.
    close_reason  text
        CHECK (
            close_reason IS NULL
            OR length(btrim(close_reason)) BETWEEN 1 AND 500
        ),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (
        state = 'closed'
        OR origin = CASE state
            WHEN 'would' THEN 'dry_run'
            WHEN 'manual' THEN 'manual'
            ELSE 'auto'
        END
    ),
    CHECK ((tier IS NULL) = (origin = 'manual')),
    CHECK (reason IS NOT NULL OR origin = 'manual'),
    CHECK (
        (state = 'closed')
        = (closed_at IS NOT NULL AND closed_by IS NOT NULL
           AND close_how IS NOT NULL)
    )
);

-- At most one open pilot record and one open hand record per host: a person
-- can cordon a host the pilot has already quarantined, and vice versa.
CREATE UNIQUE INDEX IF NOT EXISTS idx_quarantine_records_one_open_per_host
    ON alerting_quarantine_records (host, (origin = 'manual'))
    WHERE state <> 'closed';

CREATE INDEX IF NOT EXISTS idx_quarantine_records_host_fault
    ON alerting_quarantine_records (host, fault_at DESC);

-- R6 re-runs after a quarantine takes effect: at most one per job per record.
CREATE TABLE IF NOT EXISTS alerting_quarantine_reruns (
    rerun_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    record_id    bigint NOT NULL
        REFERENCES alerting_quarantine_records (record_id) ON DELETE CASCADE,
    job_id       text NOT NULL
        CHECK (length(btrim(job_id)) BETWEEN 1 AND 128),
    build_number bigint NOT NULL,
    pipeline     text NOT NULL
        CHECK (length(btrim(pipeline)) BETWEEN 1 AND 80),
    outcome      text NOT NULL
        CHECK (length(btrim(outcome)) BETWEEN 1 AND 200),
    at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (record_id, job_id)
);

-- People-edited exceptions to "expected GPU count = max(8, most ever seen)".
CREATE TABLE IF NOT EXISTS alerting_expected_gpu_exceptions (
    host         text PRIMARY KEY
        CHECK (length(btrim(host)) BETWEEN 1 AND 253),
    expected_gpus integer NOT NULL CHECK (expected_gpus BETWEEN 1 AND 16),
    note         text
        CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per shared-cause incident. The detector opens it as 'suspected';
-- a person confirms it (supplying cause and match) and later closes it, which
-- ends the window and starts the re-run. An unconfirmed suspicion closes
-- itself ('self_closed'); there is no dismiss.
CREATE TABLE IF NOT EXISTS alerting_incidents (
    incident_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- 'all' for all of CI, otherwise one queue name.
    scope         text NOT NULL
        CHECK (length(btrim(scope)) BETWEEN 1 AND 80),
    state         text NOT NULL
        CHECK (state IN ('suspected', 'confirmed', 'closed', 'self_closed')),
    -- First failure of the spike; the window ends when a person closes it.
    window_start  timestamptz NOT NULL,
    window_end    timestamptz,
    cause         text
        CHECK (cause IS NULL OR length(btrim(cause)) BETWEEN 1 AND 500),
    -- Error text or failure kind that re-run targets must match.
    match         text
        CHECK (match IS NULL OR length(btrim(match)) BETWEEN 1 AND 200),
    confirmed_by  text
        CHECK (
            confirmed_by IS NULL OR length(btrim(confirmed_by)) BETWEEN 1 AND 80
        ),
    confirmed_at  timestamptz,
    closed_by     text
        CHECK (closed_by IS NULL OR length(btrim(closed_by)) BETWEEN 1 AND 80),
    closed_at     timestamptz,
    -- Slack post the worker edits when the incident changes.
    slack_channel text,
    slack_ts      text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (
        state NOT IN ('confirmed', 'closed')
        OR (cause IS NOT NULL AND match IS NOT NULL
            AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
    ),
    CHECK (
        state <> 'closed'
        OR (closed_by IS NOT NULL AND closed_at IS NOT NULL
            AND window_end IS NOT NULL)
    ),
    CHECK (state <> 'self_closed' OR closed_at IS NOT NULL)
);

-- One open (suspected or confirmed) incident per scope.
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_one_open_per_scope
    ON alerting_incidents (scope)
    WHERE state IN ('suspected', 'confirmed');

-- Re-runs after an incident closes: at most one per job per incident.
CREATE TABLE IF NOT EXISTS alerting_incident_reruns (
    rerun_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    incident_id  bigint NOT NULL
        REFERENCES alerting_incidents (incident_id) ON DELETE CASCADE,
    job_id       text NOT NULL
        CHECK (length(btrim(job_id)) BETWEEN 1 AND 128),
    build_number bigint NOT NULL,
    pipeline     text NOT NULL
        CHECK (length(btrim(pipeline)) BETWEEN 1 AND 80),
    outcome      text NOT NULL
        CHECK (length(btrim(outcome)) BETWEEN 1 AND 200),
    at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (incident_id, job_id)
);

ALTER TABLE public.alerting_quarantine_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_quarantine_reruns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_expected_gpu_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_incident_reruns ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
    protected_tables constant text :=
        'public.alerting_quarantine_records, '
        'public.alerting_quarantine_reruns, '
        'public.alerting_expected_gpu_exceptions, '
        'public.alerting_incidents, '
        'public.alerting_incident_reruns';
    protected_sequences constant text :=
        'public.alerting_quarantine_records_record_id_seq, '
        'public.alerting_quarantine_reruns_rerun_id_seq, '
        'public.alerting_incidents_incident_id_seq, '
        'public.alerting_incident_reruns_rerun_id_seq';
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
                'REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM %I',
                protected_sequences,
                api_role
            );
        END IF;
    END LOOP;
END;
$$;
