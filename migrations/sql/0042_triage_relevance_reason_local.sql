-- Claude's one-line "why you" in the maintainer's own language (their file's
-- `language`, e.g. vi), shown in their Slack messages. Empty for English
-- maintainers; `reason` stays English for the dashboard.
ALTER TABLE triage_relevance ADD COLUMN IF NOT EXISTS reason_local text NOT NULL DEFAULT '';
