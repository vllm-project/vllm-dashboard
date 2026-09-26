-- Force-merge records for merged vllm-project/vllm pull requests, ingested
-- hourly by the fetch-force-merge-stats cron. A force-merge is a PR merged
-- while the `buildkite/ci/pr` status on its head commit was red (failure or
-- error). ci_state is that status as of the merge (NULL when CI never
-- reported), which never changes afterwards, so rows accumulate indefinitely.
CREATE TABLE IF NOT EXISTS force_merge_records (
    pr_number     integer PRIMARY KEY,
    title         text NOT NULL,
    url           text NOT NULL,
    author        text,
    merged_by     text,
    merged_at     timestamptz NOT NULL,
    head_sha      text,
    ci_state      text,
    force_merged  boolean NOT NULL,
    fetched_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_force_merge_records_merged
    ON force_merge_records (merged_at DESC);

-- Partial index for the top-force-merged-authors aggregation window.
CREATE INDEX IF NOT EXISTS idx_force_merge_records_author
    ON force_merge_records (author, merged_at DESC) WHERE force_merged;
