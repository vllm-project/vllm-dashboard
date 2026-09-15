-- Give every responder update an optional, machine-auditable ownership path.
-- All three columns are either populated together or absent together. Absence
-- is intentional: the corresponding failure revision is still untriaged.
ALTER TABLE alerting_main_ci_job_updates
    ADD COLUMN IF NOT EXISTS solution_kind text,
    ADD COLUMN IF NOT EXISTS solution_owner text,
    ADD COLUMN IF NOT EXISTS solution_action text;

ALTER TABLE alerting_main_ci_job_updates
    DROP CONSTRAINT IF EXISTS alerting_main_ci_job_updates_solution_check;
ALTER TABLE alerting_main_ci_job_updates
    ADD CONSTRAINT alerting_main_ci_job_updates_solution_check
    CHECK (
        (
            solution_kind IS NULL
            AND solution_owner IS NULL
            AND solution_action IS NULL
        )
        OR (
            solution_kind IN (
                'code_fix', 'infra_action', 'known_flake', 'monitoring'
            )
            AND length(btrim(solution_owner)) BETWEEN 1 AND 80
            AND length(btrim(solution_action)) BETWEEN 1 AND 1000
            AND (
                solution_kind <> 'code_fix'
                OR jsonb_array_length(fix_prs) > 0
            )
        )
    );

CREATE INDEX IF NOT EXISTS idx_main_ci_job_updates_current_solution
    ON alerting_main_ci_job_updates (
        alert_id, failure_job_id, created_at DESC, update_id DESC
    )
    WHERE solution_kind IS NOT NULL;
