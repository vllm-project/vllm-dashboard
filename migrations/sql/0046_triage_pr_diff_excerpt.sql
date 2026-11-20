-- Budgeted PR diff excerpt for Tier-1 extraction, cached per head commit SHA
-- so re-ingests on unchanged commits never re-fetch the diff from GitHub.
ALTER TABLE triage_items
    ADD COLUMN IF NOT EXISTS diff_excerpt text NOT NULL DEFAULT '';

ALTER TABLE triage_items
    ADD COLUMN IF NOT EXISTS diff_head_sha text;
