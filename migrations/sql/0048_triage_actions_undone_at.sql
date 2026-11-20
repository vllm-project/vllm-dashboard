-- Dashboard Undo marks a triage_actions row as undone instead of deleting it,
-- so triage_actions stays append-only (an audit of every click, including the
-- ones taken back). Every reader that treats an action as a decision (the
-- router's drop/slop and not_mine checks, needs_relevance, suppression
-- alerts, relevance feedback, dashboard stats and "why no owner") ignores
-- rows with undone_at set.
ALTER TABLE triage_actions
    ADD COLUMN IF NOT EXISTS undone_at timestamptz;

-- Live decisions per item (the router's drop/slop and not_mine lookups).
CREATE INDEX IF NOT EXISTS triage_actions_live_item_idx
    ON triage_actions (item_key, action)
    WHERE undone_at IS NULL;
