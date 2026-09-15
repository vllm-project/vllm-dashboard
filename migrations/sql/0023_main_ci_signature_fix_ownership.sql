-- Bind responder fix ownership to the normalized failure identity instead of
-- only to one Buildkite execution. The exact revision remains the source of
-- truth for notes; readers may carry fix links across revisions only after a
-- fresh analysis reports this exact signature and GitHub verifies the fix is
-- still applicable to the new failing commit.
ALTER TABLE alerting_main_ci_job_analysis
    ADD COLUMN IF NOT EXISTS failure_signature text;

ALTER TABLE alerting_main_ci_job_analysis
    DROP CONSTRAINT IF EXISTS alerting_main_ci_job_analysis_signature_check;
ALTER TABLE alerting_main_ci_job_analysis
    ADD CONSTRAINT alerting_main_ci_job_analysis_signature_check
    CHECK (
        failure_signature IS NULL
        OR (
            char_length(failure_signature) BETWEEN 1 AND 500
            AND failure_signature = lower(failure_signature)
        )
    );

ALTER TABLE alerting_main_ci_job_updates
    ADD COLUMN IF NOT EXISTS failure_signature text;

ALTER TABLE alerting_main_ci_job_updates
    DROP CONSTRAINT IF EXISTS alerting_main_ci_job_updates_signature_check;
ALTER TABLE alerting_main_ci_job_updates
    ADD CONSTRAINT alerting_main_ci_job_updates_signature_check
    CHECK (
        failure_signature IS NULL
        OR (
            char_length(failure_signature) BETWEEN 1 AND 500
            AND failure_signature = lower(failure_signature)
        )
    );

CREATE INDEX IF NOT EXISTS idx_main_ci_job_updates_signature
    ON alerting_main_ci_job_updates (
        failure_signature, alert_id, created_at DESC, update_id DESC
    )
    WHERE failure_signature IS NOT NULL
      AND jsonb_array_length(fix_prs) > 0;
