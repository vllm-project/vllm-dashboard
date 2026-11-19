-- Widen the infra alert_type CHECK constraints for queue_zombie, and seed its
-- threshold row.
--
-- All three constraints change in this one file, as in 0027: widening only
-- some of them made the first scan that planned the new type fail and stopped
-- infra alerting (0023/0024). DROP + ADD keeps the file safe to replay.
ALTER TABLE alert_thresholds
    DROP CONSTRAINT IF EXISTS alert_thresholds_check,
    ADD CONSTRAINT alert_thresholds_check
        CHECK (
            (alert_type = 'unreporting' AND threshold_unit = 'minutes') OR
            (alert_type = 'disk_usage' AND threshold_unit = 'percent') OR
            (alert_type = 'gpu_temperature' AND threshold_unit = 'celsius') OR
            (alert_type = 'gpu_dead_memory' AND threshold_unit = 'mib') OR
            (alert_type = 'gpu_count' AND threshold_unit = 'gpus') OR
            (alert_type = 'queue_zombie' AND threshold_unit = 'minutes')
        );

ALTER TABLE alerting_infra_host_states
    DROP CONSTRAINT IF EXISTS alerting_infra_host_states_alert_type_check,
    ADD CONSTRAINT alerting_infra_host_states_alert_type_check
        CHECK (alert_type IN (
            'unreporting',
            'disk_usage',
            'gpu_temperature',
            'gpu_dead_memory',
            'gpu_count',
            'quarantine',
            'queue_zombie'
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
            'quarantine',
            'queue_zombie'
        ));

-- An Elastic CI Stack agent normally connects about a minute after launch;
-- ten minutes of grace before the newest agent poll leaves room for a slow
-- boot. Two consecutive scans match every other infra alert, so an instance
-- caught between finishing its one job and terminating cannot page.
-- Operators tune this row directly; rerunning the migration never overwrites
-- an existing value.
--
-- The row enables the type, but the check also needs the worker's
-- QUEUE_ZOMBIE_ROLE_ARN: without it the scan never lists instances. Apply
-- this only after the worker carries code that knows queue_zombie; older code
-- ignores threshold rows for types it does not implement.
INSERT INTO alert_thresholds (
    alert_type, threshold_value, threshold_unit, consecutive_scans
) VALUES
    ('queue_zombie', 10, 'minutes', 2)
ON CONFLICT (alert_type) DO NOTHING;
