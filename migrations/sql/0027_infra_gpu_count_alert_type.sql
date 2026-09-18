-- Widen the infra alert_type CHECK constraints for gpu_count, and seed its
-- threshold row.
--
-- All three constraints must be widened before the first scan that plans a
-- gpu_count subject. Migration 0023 widened alert_thresholds but missed the
-- two infra tables, the first scan after that deploy failed on
-- alerting_infra_host_states_alert_type_check, and infra alerting stopped
-- reconciling until 0024 was hand-applied. This file changes all three in one
-- place so that cannot recur.
--
-- DROP + ADD keeps the file safe to replay, matching 0023 and 0024.
ALTER TABLE alert_thresholds
    DROP CONSTRAINT IF EXISTS alert_thresholds_check,
    ADD CONSTRAINT alert_thresholds_check
        CHECK (
            (alert_type = 'unreporting' AND threshold_unit = 'minutes') OR
            (alert_type = 'disk_usage' AND threshold_unit = 'percent') OR
            (alert_type = 'gpu_temperature' AND threshold_unit = 'celsius') OR
            (alert_type = 'gpu_dead_memory' AND threshold_unit = 'mib') OR
            (alert_type = 'gpu_count' AND threshold_unit = 'gpus')
        );

ALTER TABLE alerting_infra_host_states
    DROP CONSTRAINT IF EXISTS alerting_infra_host_states_alert_type_check,
    ADD CONSTRAINT alerting_infra_host_states_alert_type_check
        CHECK (alert_type IN (
            'unreporting',
            'disk_usage',
            'gpu_temperature',
            'gpu_dead_memory',
            'gpu_count'
        ));

ALTER TABLE alerting_infra_alerts
    DROP CONSTRAINT IF EXISTS alerting_infra_alerts_alert_type_check,
    ADD CONSTRAINT alerting_infra_alerts_alert_type_check
        CHECK (alert_type IN (
            'unreporting',
            'disk_usage',
            'gpu_temperature',
            'gpu_dead_memory',
            'gpu_count'
        ));

-- One missing GPU is the alert-worthy unit: a host is either whole or it is
-- not, and a shortfall of one already breaks any job requesting the full
-- topology. Two consecutive scans match every other infra alert, so a single
-- late or partial report cannot page. Operators tune this row directly;
-- rerunning the migration never overwrites an existing value.
--
-- Inserting this row is what switches the alert on, so apply this migration
-- only after the worker carries code that knows the gpu_count type. Older
-- code ignores threshold rows for types it does not implement, so the reverse
-- order is harmless, just inert.
INSERT INTO alert_thresholds (
    alert_type, threshold_value, threshold_unit, consecutive_scans
) VALUES
    ('gpu_count', 1, 'gpus', 2)
ON CONFLICT (alert_type) DO NOTHING;
