-- Force-merge records for merged vllm-project/vllm pull requests, refreshed
-- daily by the fetch-force-merge-stats cron. A force-merge is a merge performed
-- by the `vllm-bot` account: every PR is squash-merged with an identical git
-- committer, so GitHub's mergedBy field is the only reliable signal. Rows are
-- keyed by PR number and upserted over a rolling fetch window, so history
-- accumulates indefinitely instead of rolling off with the window.
CREATE TABLE IF NOT EXISTS force_merge_records (
    pr_number     integer PRIMARY KEY,
    title         text NOT NULL,
    url           text NOT NULL,
    author        text,
    merged_by     text,
    merged_at     timestamptz NOT NULL,
    force_merged  boolean NOT NULL,
    fetched_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_force_merge_records_merged
    ON force_merge_records (merged_at DESC);

-- Partial index for the top-force-merged-authors aggregation window.
CREATE INDEX IF NOT EXISTS idx_force_merge_records_author
    ON force_merge_records (author, merged_at DESC) WHERE force_merged;
