-- Dead-process GPU memory: memory the driver still attributes to PIDs that no
-- longer exist after SIGKILL. The reporter collects it per GPU; NULL means the
-- host could not collect the metric.
ALTER TABLE gpu_snapshots
    ADD COLUMN IF NOT EXISTS dead_proc_mem_mb real;

ALTER TABLE gpu_snapshots
    DROP CONSTRAINT IF EXISTS gpu_snapshots_dead_proc_mem_mb_check,
    ADD CONSTRAINT gpu_snapshots_dead_proc_mem_mb_check
        CHECK (dead_proc_mem_mb IS NULL OR dead_proc_mem_mb >= 0);

-- Widen the allowed threshold combos for the new infra alert type.
ALTER TABLE alert_thresholds
    DROP CONSTRAINT IF EXISTS alert_thresholds_check,
    ADD CONSTRAINT alert_thresholds_check
        CHECK (
            (alert_type = 'unreporting' AND threshold_unit = 'minutes') OR
            (alert_type = 'disk_usage' AND threshold_unit = 'percent') OR
            (alert_type = 'gpu_temperature' AND threshold_unit = 'celsius') OR
            (alert_type = 'gpu_dead_memory' AND threshold_unit = 'mib')
        );

-- 4 GiB of dead-process memory is roughly the headroom a CI lane needs on an
-- 18 GiB MIG slice. Operators tune this row directly; rerunning the migration
-- never overwrites an existing value.
INSERT INTO alert_thresholds (
    alert_type, threshold_value, threshold_unit, consecutive_scans
) VALUES
    ('gpu_dead_memory', 4096, 'mib', 2)
ON CONFLICT (alert_type) DO NOTHING;
