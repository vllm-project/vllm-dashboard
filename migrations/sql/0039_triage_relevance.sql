-- Relevance from history: each maintainer's recent vLLM work (built by the
-- worker from GitHub) and Claude's per-item judgement of whether an item is
-- theirs (written by the extractor host). Routing reads both.

-- One row per maintainer: their recent authored/reviewed PRs.
CREATE TABLE IF NOT EXISTS triage_maintainer_profiles (
    github_login  text PRIMARY KEY REFERENCES triage_maintainers (github_login) ON DELETE CASCADE,
    -- [{"number": 61343, "kind": "authored"|"reviewed", "title": "..."}], newest first
    prs           jsonb NOT NULL,
    -- Hash of prs + the maintainer's own notes; a change re-queues judgements.
    profile_hash  text NOT NULL,
    built_at      timestamptz NOT NULL DEFAULT now()
);

-- Claude's judgement for one item and one maintainer.
CREATE TABLE IF NOT EXISTS triage_relevance (
    item_key      text NOT NULL REFERENCES triage_items (item_key) ON DELETE CASCADE,
    maintainer    text NOT NULL REFERENCES triage_maintainers (github_login) ON DELETE CASCADE,
    relevance     text NOT NULL CHECK (relevance IN ('high', 'medium', 'low', 'none')),
    evidence_prs  jsonb NOT NULL DEFAULT '[]'::jsonb,
    reason        text NOT NULL DEFAULT '',
    content_hash  text NOT NULL,
    profile_hash  text NOT NULL,
    model         text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (item_key, maintainer)
);

CREATE INDEX IF NOT EXISTS triage_relevance_maintainer_idx
    ON triage_relevance (maintainer, relevance);

ALTER TABLE triage_maintainer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_relevance ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE triage_maintainer_profiles, triage_relevance FROM %I',
                api_role
            );
        END IF;
    END LOOP;
    -- The extractor host judges relevance: it reads maintainers, profiles and
    -- scores, and writes judgements. Same grants as extractor-role.sql, so an
    -- existing role picks them up with this migration.
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'triage_extractor') THEN
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
