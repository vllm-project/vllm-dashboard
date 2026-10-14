-- Hardware fault readings for the quarantine rules. NULL always means the
-- reporter could not read the value, never a passing value.
ALTER TABLE gpu_snapshots
    ADD COLUMN IF NOT EXISTS recovery_action text,
    ADD COLUMN IF NOT EXISTS remapped_rows_failure boolean,
    ADD COLUMN IF NOT EXISTS ecc_uncorrected bigint;

ALTER TABLE gpu_snapshots
    DROP CONSTRAINT IF EXISTS gpu_snapshots_ecc_uncorrected_check,
    ADD CONSTRAINT gpu_snapshots_ecc_uncorrected_check
        CHECK (ecc_uncorrected IS NULL OR ecc_uncorrected >= 0);

-- Host-level readings live on host_snapshots, which already carries one row
-- per report for bare-metal and Kubernetes nodes alike. allocatable/capacity
-- are Kubernetes-only; H200 hosts leave them NULL. gpu_query_hung is an
-- explicit failing value (true when nvidia-smi errored or ran past 30 s), and
-- network_probes holds one {target, ok, error, latency_ms} per probe target.
ALTER TABLE host_snapshots
    ADD COLUMN IF NOT EXISTS mig_slices integer,
    ADD COLUMN IF NOT EXISTS root_owned_slots jsonb,
    ADD COLUMN IF NOT EXISTS allocatable_gpus integer,
    ADD COLUMN IF NOT EXISTS capacity_gpus integer,
    ADD COLUMN IF NOT EXISTS gpu_query_hung boolean,
    ADD COLUMN IF NOT EXISTS gpu_query_error text,
    ADD COLUMN IF NOT EXISTS network_probes jsonb;

ALTER TABLE host_snapshots
    DROP CONSTRAINT IF EXISTS host_snapshots_fault_fields_check,
    ADD CONSTRAINT host_snapshots_fault_fields_check
        CHECK (
            (mig_slices IS NULL OR mig_slices >= 0) AND
            (allocatable_gpus IS NULL OR allocatable_gpus >= 0) AND
            (capacity_gpus IS NULL OR capacity_gpus >= 0) AND
            (root_owned_slots IS NULL OR jsonb_typeof(root_owned_slots) = 'array') AND
            (network_probes IS NULL OR jsonb_typeof(network_probes) = 'array')
        );

-- Xids new since the reporter's last read, one row per kernel-log line. The
-- reporter resends on a failed POST, so the unique key makes ingestion
-- idempotent. bus_id is '' (never NULL) when the Xid can't be tied to a GPU,
-- as with the Kubernetes device-plugin feed; NOT NULL keeps those rows
-- covered by the unique key, where NULLs would never dedupe.
CREATE TABLE IF NOT EXISTS gpu_xid_events (
    id           bigserial PRIMARY KEY,
    hostname     text NOT NULL,
    bus_id       text NOT NULL,
    xid          integer NOT NULL,
    at           timestamptz NOT NULL,
    message      text NOT NULL,
    reported_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (hostname = lower(hostname)),
    CHECK (xid >= 0),
    UNIQUE (hostname, bus_id, xid, at)
);

CREATE INDEX IF NOT EXISTS idx_gpu_xid_events_host_at
    ON gpu_xid_events (hostname, at DESC);

-- Reachable only through trusted server-side connections.
ALTER TABLE public.gpu_xid_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE public.gpu_xid_events FROM %I',
                api_role
            );
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON SEQUENCE public.gpu_xid_events_id_seq FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END;
$$;
