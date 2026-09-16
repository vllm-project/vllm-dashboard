-- Widen the infra alert_type CHECK constraints for gpu_dead_memory.
-- Migration 0023 added the alert type to alert_thresholds but missed these
-- two tables; the first scan after deploy failed on
-- alerting_infra_host_states_alert_type_check and infra alerting stopped
-- reconciling until this was hand-applied (2026-09-16, before this file ran).
-- DROP + ADD keeps the file safe to replay over the hand-applied fix.
ALTER TABLE alerting_infra_host_states
    DROP CONSTRAINT IF EXISTS alerting_infra_host_states_alert_type_check,
    ADD CONSTRAINT alerting_infra_host_states_alert_type_check
        CHECK (alert_type IN ('unreporting', 'disk_usage', 'gpu_temperature', 'gpu_dead_memory'));

ALTER TABLE alerting_infra_alerts
    DROP CONSTRAINT IF EXISTS alerting_infra_alerts_alert_type_check,
    ADD CONSTRAINT alerting_infra_alerts_alert_type_check
        CHECK (alert_type IN ('unreporting', 'disk_usage', 'gpu_temperature', 'gpu_dead_memory'));
