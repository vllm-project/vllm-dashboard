-- Routing no longer waits forever for relevance judgements, and relevance
-- learns from what maintainers did with items routed to them.

-- When an item last entered the page/route band (NULL outside it). The router
-- waits for every maintainer's relevance judgement for a grace period counted
-- from here (or from the item's first extraction, if later), then routes
-- among the maintainers who have been judged. Rows already in the band start
-- their clock at their last scoring.
ALTER TABLE triage_scores ADD COLUMN IF NOT EXISTS routable_since timestamptz;
UPDATE triage_scores SET routable_since = scored_at
WHERE band IN ('page', 'route') AND routable_since IS NULL;

-- Snapshot of items the maintainer recently said "not mine" to and items they
-- acked or finished: {"declined": [{"item_key", "title", "at"}], "took": [...]}.
-- Written by the worker when it rebuilds the profile (it can read
-- triage_actions and triage_assignments; the relevance job's restricted role
-- cannot, and already has SELECT on this whole table).
ALTER TABLE triage_maintainer_profiles ADD COLUMN IF NOT EXISTS feedback jsonb NOT NULL DEFAULT '{}'::jsonb;
