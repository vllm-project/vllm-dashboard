-- Quarantine and shared-cause incidents for the CI stability pilot.
--
-- A quarantine is one more infra alert type, not a table of its own: one
-- 'quarantine' episode per host in alerting_infra_alerts, whose partial unique
-- index already allows only one open episode per host. The episode's stage
-- lives in details->>'stage':
--   would         dry run: the worker would quarantine; nothing is applied
--   held          a safety limit blocked the command; applied when a slot frees
--   quarantining  command sent; running jobs are finishing
--   quarantined   the actuator confirmed no CI job runs and none can land
--   resolving     an operator resolved it; the actuator is undoing its changes
--   resolved      the actuator confirmed the host is back (status 'resolved')
-- The EC2 alerting worker owns the episodes; the operator endpoint only moves
-- an episode to 'resolving', and the worker and timers act on it.
--
-- Both infra alert_type constraints are widened together, as 0027 learned.
-- DROP + ADD keeps the file safe to replay.
ALTER TABLE alerting_infra_host_states
    DROP CONSTRAINT IF EXISTS alerting_infra_host_states_alert_type_check,
    ADD CONSTRAINT alerting_infra_host_states_alert_type_check
        CHECK (alert_type IN (
            'unreporting',
            'disk_usage',
            'gpu_temperature',
            'gpu_dead_memory',
            'gpu_count',
            'quarantine'
        ));

ALTER TABLE alerting_infra_alerts
    DROP CONSTRAINT IF EXISTS alerting_infra_alerts_alert_type_check,
    ADD CONSTRAINT alerting_infra_alerts_alert_type_check
        CHECK (alert_type IN (
            'unreporting',
            'disk_usage',
            'gpu_temperature',
            'gpu_dead_memory',
            'gpu_count',
            'quarantine'
        ));

ALTER TABLE alerting_infra_alerts
    DROP CONSTRAINT IF EXISTS alerting_infra_alerts_quarantine_stage_check,
    ADD CONSTRAINT alerting_infra_alerts_quarantine_stage_check
        CHECK (
            alert_type <> 'quarantine'
            OR (
                -- IS NOT NULL first: a missing stage would make IN unknown,
                -- and a CHECK passes on unknown.
                details->>'stage' IS NOT NULL
                AND details->>'stage' IN (
                    'would', 'held', 'quarantining', 'quarantined',
                    'resolving', 'resolved'
                )
                AND (status = 'resolved') = (details->>'stage' = 'resolved')
            )
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

ALTER TABLE public.alerting_expected_gpu_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerting_incident_reruns ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
    protected_tables constant text :=
        'public.alerting_expected_gpu_exceptions, '
        'public.alerting_incidents, '
        'public.alerting_incident_reruns';
    protected_sequences constant text :=
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
