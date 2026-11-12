-- Restricted role for the triage extractor host (the machine that runs the
-- LLM through Claude Code). It can read items, record extractions, and move
-- an item's extraction status; nothing else. Run once as the database owner
-- after migration 0038, replacing the password:
--
--   psql "$OWNER_DATABASE_URL" -v pw="'<strong password>'" -f extractor-role.sql
--
-- Then give the extractor host this DATABASE_URL (Supabase session pooler,
-- port 5432 or 6543):
--   postgres://triage_extractor.<project-ref>:<password>@<pooler-host>:6543/postgres
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'triage_extractor') THEN
        CREATE ROLE triage_extractor LOGIN;
    END IF;
END
$$;
ALTER ROLE triage_extractor WITH LOGIN PASSWORD :pw;

GRANT USAGE ON SCHEMA public TO triage_extractor;
GRANT SELECT ON triage_items TO triage_extractor;
GRANT UPDATE (extraction_status, extraction_attempts, extraction_lease_until, extraction_error)
    ON triage_items TO triage_extractor;
GRANT SELECT, INSERT, UPDATE ON triage_extractions TO triage_extractor;
GRANT USAGE ON SEQUENCE triage_extractions_id_seq TO triage_extractor;

-- 0038 enables row-level security on every triage table; without a policy a
-- non-owner role sees no rows at all.
DROP POLICY IF EXISTS triage_extractor_items ON triage_items;
CREATE POLICY triage_extractor_items ON triage_items
    FOR ALL TO triage_extractor USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS triage_extractor_extractions ON triage_extractions;
CREATE POLICY triage_extractor_extractions ON triage_extractions
    FOR ALL TO triage_extractor USING (true) WITH CHECK (true);

-- Relevance judging (migration 0039 grants these too when the role exists).
-- Only valid once 0039 is applied.
DO $$
BEGIN
    IF to_regclass('public.triage_relevance') IS NOT NULL THEN
        GRANT SELECT ON triage_maintainers, triage_maintainer_profiles, triage_scores TO triage_extractor;
        GRANT SELECT, INSERT, UPDATE ON triage_relevance TO triage_extractor;
        DROP POLICY IF EXISTS triage_extractor_maintainers ON triage_maintainers;
        CREATE POLICY triage_extractor_maintainers ON triage_maintainers
            FOR SELECT TO triage_extractor USING (true);
        DROP POLICY IF EXISTS triage_extractor_profiles ON triage_maintainer_profiles;
        CREATE POLICY triage_extractor_profiles ON triage_maintainer_profiles
            FOR SELECT TO triage_extractor USING (true);
        DROP POLICY IF EXISTS triage_extractor_scores ON triage_scores;
        CREATE POLICY triage_extractor_scores ON triage_scores
            FOR SELECT TO triage_extractor USING (true);
        DROP POLICY IF EXISTS triage_extractor_relevance ON triage_relevance;
        CREATE POLICY triage_extractor_relevance ON triage_relevance
            FOR ALL TO triage_extractor USING (true) WITH CHECK (true);
    END IF;
END
$$;
