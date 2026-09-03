-- Host-level telemetry reported alongside the existing per-GPU payload.
-- Raw observations retain the exact latest disk/node detail. Five-minute
-- rows keep additive gauge aggregates plus the most recently received detail
-- in the bucket, matching the incremental gpu_history_5m ingestion model.
CREATE TABLE IF NOT EXISTS host_snapshots (
    id                  bigserial PRIMARY KEY,
    reported_at         timestamptz NOT NULL DEFAULT now(),
    hostname            text NOT NULL,
    cpu_util             real,
    cpu_count            integer,
    ram_used_bytes       bigint,
    ram_total_bytes      bigint,
    ram_available_bytes  bigint,
    disks                jsonb,
    reporter_status      text NOT NULL,
    last_error           text,
    node_conditions      jsonb,
    CHECK (hostname = lower(hostname)),
    CHECK (length(hostname) BETWEEN 1 AND 253),
    CHECK (cpu_util IS NULL OR cpu_util BETWEEN 0 AND 100),
    CHECK (cpu_count IS NULL OR cpu_count > 0),
    CHECK (ram_used_bytes IS NULL OR ram_used_bytes >= 0),
    CHECK (ram_total_bytes IS NULL OR ram_total_bytes > 0),
    CHECK (ram_available_bytes IS NULL OR ram_available_bytes >= 0),
    CHECK (ram_used_bytes IS NULL OR ram_total_bytes IS NULL OR ram_used_bytes <= ram_total_bytes),
    CHECK (ram_available_bytes IS NULL OR ram_total_bytes IS NULL OR ram_available_bytes <= ram_total_bytes),
    CHECK (disks IS NULL OR jsonb_typeof(disks) = 'array'),
    CHECK (reporter_status IN ('ok', 'degraded')),
    CHECK (last_error IS NULL OR length(last_error) <= 2048),
    CHECK (node_conditions IS NULL OR jsonb_typeof(node_conditions) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_host_snapshots_reported
    ON host_snapshots (reported_at DESC, hostname);

CREATE INDEX IF NOT EXISTS idx_host_snapshots_host
    ON host_snapshots (hostname, reported_at DESC);

CREATE TABLE IF NOT EXISTS host_history_5m (
    time_bucket             timestamptz NOT NULL,
    hostname                text NOT NULL,
    latest_reported_at      timestamptz NOT NULL,
    cpu_util_sum            double precision NOT NULL DEFAULT 0,
    cpu_util_max            real,
    cpu_sample_count        bigint NOT NULL DEFAULT 0,
    cpu_count               integer,
    ram_used_bytes_sum      double precision NOT NULL DEFAULT 0,
    ram_total_bytes_sum     double precision NOT NULL DEFAULT 0,
    ram_available_bytes_sum double precision NOT NULL DEFAULT 0,
    ram_sample_count        bigint NOT NULL DEFAULT 0,
    disks                   jsonb,
    reporter_status         text NOT NULL,
    last_error              text,
    node_conditions         jsonb,
    sample_count            bigint NOT NULL,
    PRIMARY KEY (time_bucket, hostname),
    CHECK (hostname = lower(hostname)),
    CHECK (latest_reported_at >= time_bucket),
    CHECK (cpu_sample_count >= 0),
    CHECK (cpu_count IS NULL OR cpu_count > 0),
    CHECK (ram_sample_count >= 0),
    CHECK (sample_count > 0),
    CHECK (disks IS NULL OR jsonb_typeof(disks) = 'array'),
    CHECK (reporter_status IN ('ok', 'degraded')),
    CHECK (last_error IS NULL OR length(last_error) <= 2048),
    CHECK (node_conditions IS NULL OR jsonb_typeof(node_conditions) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_host_history_5m_time_host
    ON host_history_5m (time_bucket DESC, hostname);

-- Fleet-wide defaults. Operators may tune these rows directly; rerunning the
-- migration never overwrites an existing value.
CREATE TABLE IF NOT EXISTS alert_thresholds (
    alert_type         text PRIMARY KEY,
    threshold_value   double precision NOT NULL CHECK (threshold_value >= 0),
    threshold_unit    text NOT NULL,
    consecutive_scans integer NOT NULL DEFAULT 2 CHECK (consecutive_scans > 0),
    enabled           boolean NOT NULL DEFAULT true,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (alert_type = 'unreporting' AND threshold_unit = 'minutes') OR
        (alert_type = 'disk_usage' AND threshold_unit = 'percent') OR
        (alert_type = 'gpu_temperature' AND threshold_unit = 'celsius')
    )
);

INSERT INTO alert_thresholds (
    alert_type, threshold_value, threshold_unit, consecutive_scans
) VALUES
    ('unreporting', 10, 'minutes', 2),
    ('disk_usage', 90, 'percent', 2),
    ('gpu_temperature', 85, 'celsius', 2)
ON CONFLICT (alert_type) DO NOTHING;

CREATE OR REPLACE TRIGGER alert_thresholds_updated_at
    BEFORE UPDATE ON alert_thresholds
    FOR EACH ROW EXECUTE FUNCTION alerting_set_updated_at();

-- These tables are reachable only through trusted server-side connections.
ALTER TABLE public.host_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.host_history_5m ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_thresholds ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
    protected_tables constant text :=
        'public.host_snapshots, public.host_history_5m, public.alert_thresholds';
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
                'REVOKE ALL PRIVILEGES ON SEQUENCE public.host_snapshots_id_seq FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END;
$$;
