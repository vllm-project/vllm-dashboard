-- The pull request a Full CI run's head commit merged. The analyzer already
-- resolves it against GitHub to write its report, but until now nothing kept
-- it, so the dashboard could link a run's commit without naming the change it
-- carried. Nullable throughout: a commit reachable by no pull request is a
-- real state, not missing data.
ALTER TABLE alerting_full_ci_runs
    ADD COLUMN IF NOT EXISTS commit_pr_number bigint,
    ADD COLUMN IF NOT EXISTS commit_pr_url    text,
    ADD COLUMN IF NOT EXISTS commit_pr_title  text;
