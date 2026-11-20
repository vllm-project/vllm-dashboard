-- Relevance efficiency:
--   1. `triage_scores.needs_relevance`: maintained by `triage-route` so the
--      restricted `triage_extractor` role skips items that are already owned,
--      dropped/slop, held back waiting on their author, or assigned elsewhere
--      on GitHub, without granting it read access to `triage_assignments` or
--      `triage_actions`.
--   2. `triage_maintainer_profiles.authored_paths`: directory-prefix touch
--      counts from each maintainer's authored PRs, used for compact profile
--      context and deterministic pre-shortlisting.
ALTER TABLE triage_scores
    ADD COLUMN IF NOT EXISTS needs_relevance boolean NOT NULL DEFAULT true;

UPDATE triage_scores s
SET needs_relevance = false
FROM triage_items i
WHERE i.item_key = s.item_key
  AND (
      NOT i.in_scope
      OR i.state <> 'open'
      OR s.band NOT IN ('page', 'route')
      OR EXISTS (
          SELECT 1 FROM triage_assignments a
          WHERE a.item_key = s.item_key
            AND a.role = 'primary'
            AND a.status IN ('open', 'acked', 'done')
      )
      OR EXISTS (
          SELECT 1 FROM triage_actions a
          WHERE a.item_key = s.item_key
            AND a.action IN ('drop', 'slop')
      )
      OR (COALESCE(i.prepass->>'waiting_on', '') = 'author' AND s.band <> 'page')
  );

ALTER TABLE triage_maintainer_profiles
    ADD COLUMN IF NOT EXISTS authored_paths jsonb NOT NULL DEFAULT '{}'::jsonb;
