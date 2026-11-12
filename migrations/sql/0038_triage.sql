-- Issue/PR triage: every vllm-project/vllm issue and PR, the facets an LLM
-- read from it, a deterministic impact score, the maintainers it was routed
-- to, and what those maintainers did with it. See triage/README.md.
--
-- Writers:
--   * the alerting worker (triage ingest/route/digest consumers): items,
--     scores, assignments, cursors, outbox rows;
--   * the extractor host (runs the LLM through Claude Code): reads items,
--     inserts extractions, updates the extraction columns on items only;
--   * the dashboard: inserts actions and updates assignment status and its
--     signed-in maintainer's own rules.
ALTER TABLE alerting_notification_outbox
    DROP CONSTRAINT IF EXISTS alerting_notification_outbox_path_check;
ALTER TABLE alerting_notification_outbox
    ADD CONSTRAINT alerting_notification_outbox_path_check
    CHECK (alert_path IN ('fast_ci', 'full_ci', 'main_ci', 'infra', 'selector', 'triage'));

-- One GitHub issue or pull request. `item_key` is "<owner>/<repo>#<number>".
-- Body and comments are untrusted public text, stored truncated so the
-- extractor needs only database access.
CREATE TABLE IF NOT EXISTS triage_items (
    item_key            text PRIMARY KEY,
    repo                text NOT NULL,
    number              integer NOT NULL,
    kind                text NOT NULL CHECK (kind IN ('issue', 'pr')),
    title               text NOT NULL,
    body_excerpt        text NOT NULL DEFAULT '',
    comments_excerpt    text NOT NULL DEFAULT '',
    author              text NOT NULL,
    author_association  text NOT NULL,
    state               text NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
    draft               boolean NOT NULL DEFAULT false,
    html_url            text NOT NULL,
    labels              jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- PRs: [{"path": ..., "additions": n, "deletions": n}], capped.
    files               jsonb NOT NULL DEFAULT '[]'::jsonb,
    reactions           integer NOT NULL DEFAULT 0,
    comment_count       integer NOT NULL DEFAULT 0,
    gh_created_at       timestamptz NOT NULL,
    gh_updated_at       timestamptz NOT NULL,
    gh_closed_at        timestamptz,
    -- Deterministic signals (areas from paths, linked issues, template
    -- fields, hardware/model hints, slop heuristics). Recomputed on ingest.
    prepass             jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Cheap priority used to order extraction when the LLM budget is short.
    prepass_priority    integer NOT NULL DEFAULT 0,
    -- Hash of the text the extractor reads; a change re-queues extraction.
    content_hash        text NOT NULL,
    -- Whether this item is in triage scope (e.g. maintainer-authored PRs
    -- without a linked issue are recorded but not extracted or routed).
    in_scope            boolean NOT NULL DEFAULT true,
    extraction_status   text NOT NULL DEFAULT 'pending'
        CHECK (extraction_status IN ('pending', 'running', 'done', 'failed', 'skipped')),
    extraction_attempts integer NOT NULL DEFAULT 0,
    extraction_lease_until timestamptz,
    extraction_error    text,
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repo, number)
);

CREATE INDEX IF NOT EXISTS triage_items_extraction_queue_idx
    ON triage_items (prepass_priority DESC, gh_created_at DESC)
    WHERE extraction_status IN ('pending', 'failed') AND in_scope;
CREATE INDEX IF NOT EXISTS triage_items_updated_idx
    ON triage_items (gh_updated_at DESC);

-- One LLM reading of one version of an item. Kept per content hash and
-- prompt version so re-extraction never overwrites history.
CREATE TABLE IF NOT EXISTS triage_extractions (
    id              bigserial PRIMARY KEY,
    item_key        text NOT NULL REFERENCES triage_items (item_key) ON DELETE CASCADE,
    content_hash    text NOT NULL,
    prompt_version  text NOT NULL,
    model           text NOT NULL,
    facets          jsonb NOT NULL,
    input_tokens    integer,
    output_tokens   integer,
    duration_ms     integer,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (item_key, content_hash, prompt_version)
);

CREATE INDEX IF NOT EXISTS triage_extractions_item_idx
    ON triage_extractions (item_key, created_at DESC);
CREATE INDEX IF NOT EXISTS triage_extractions_created_idx
    ON triage_extractions (created_at DESC);

-- The current score of an item: a pure function of its prepass, latest
-- extraction and the scoring config version.
CREATE TABLE IF NOT EXISTS triage_scores (
    item_key        text PRIMARY KEY REFERENCES triage_items (item_key) ON DELETE CASCADE,
    extraction_id   bigint REFERENCES triage_extractions (id) ON DELETE SET NULL,
    score           integer NOT NULL,
    band            text NOT NULL CHECK (band IN ('page', 'route', 'watch', 'ignore')),
    -- [{"factor": "severity:serving_broken", "points": 40}, ...]
    breakdown       jsonb NOT NULL,
    scoring_version text NOT NULL,
    scored_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS triage_scores_score_idx ON triage_scores (score DESC);

-- A maintainer and their routing rules. The repo seed file
-- (triage/config/maintainers.yaml) creates rows; afterwards the dashboard
-- owns each maintainer's own rules.
CREATE TABLE IF NOT EXISTS triage_maintainers (
    github_login        text PRIMARY KEY,
    slack_user_id       text,
    active              boolean NOT NULL DEFAULT true,
    -- {"areas": [...], "hardware": [...], "models": [...], "paths": [...],
    --  "keywords": [...], "exclude": {...}, "natural_language": "..."}
    rules               jsonb NOT NULL DEFAULT '{}'::jsonb,
    min_score           integer NOT NULL DEFAULT 40,
    capacity_per_week   integer NOT NULL DEFAULT 10,
    -- [{"start": "2026-12-20", "end": "2027-01-03"}]
    away                jsonb NOT NULL DEFAULT '[]'::jsonb,
    notify_mode         text NOT NULL DEFAULT 'digest'
        CHECK (notify_mode IN ('immediate', 'digest', 'off')),
    updated_by          text,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One routing of one item to one maintainer. An item has at most one open
-- primary assignment; a reassignment closes the old row and opens a new one.
CREATE TABLE IF NOT EXISTS triage_assignments (
    id              bigserial PRIMARY KEY,
    item_key        text NOT NULL REFERENCES triage_items (item_key) ON DELETE CASCADE,
    maintainer      text NOT NULL REFERENCES triage_maintainers (github_login),
    role            text NOT NULL CHECK (role IN ('primary', 'backup')),
    status          text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'acked', 'not_mine', 'reassigned', 'dropped', 'slop', 'done')),
    -- {"matched": ["area:moe", "hardware:B200"], "affinity": 0.4, "load": 3}
    reason          jsonb NOT NULL DEFAULT '{}'::jsonb,
    score_at_assign integer NOT NULL,
    assigned_by     text NOT NULL DEFAULT 'router',
    assigned_at     timestamptz NOT NULL DEFAULT now(),
    notified_at     timestamptz,
    closed_at       timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS triage_assignments_one_open_role_idx
    ON triage_assignments (item_key, role)
    WHERE status IN ('open', 'acked');
CREATE INDEX IF NOT EXISTS triage_assignments_maintainer_idx
    ON triage_assignments (maintainer, status, assigned_at DESC);

-- Everything a person did, from the dashboard or Slack. Append-only; this is
-- the feedback the router and scorer are tuned against.
CREATE TABLE IF NOT EXISTS triage_actions (
    id              bigserial PRIMARY KEY,
    item_key        text NOT NULL REFERENCES triage_items (item_key) ON DELETE CASCADE,
    assignment_id   bigint REFERENCES triage_assignments (id) ON DELETE SET NULL,
    actor           text NOT NULL,
    action          text NOT NULL
        CHECK (action IN ('ack', 'not_mine', 'reassign', 'drop', 'slop', 'done', 'reopen')),
    target          text,
    note            text,
    source          text NOT NULL CHECK (source IN ('dashboard', 'slack', 'cli')),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS triage_actions_item_idx
    ON triage_actions (item_key, created_at DESC);
CREATE INDEX IF NOT EXISTS triage_actions_created_idx
    ON triage_actions (created_at DESC);

-- Poll cursors (e.g. "github:vllm-project/vllm" -> last gh_updated_at seen).
CREATE TABLE IF NOT EXISTS triage_cursors (
    name        text PRIMARY KEY,
    value       timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS triage_items_set_updated_at ON triage_items;
CREATE TRIGGER triage_items_set_updated_at
    BEFORE UPDATE ON triage_items
    FOR EACH ROW EXECUTE FUNCTION alerting_set_updated_at();
DROP TRIGGER IF EXISTS triage_assignments_set_updated_at ON triage_assignments;
CREATE TRIGGER triage_assignments_set_updated_at
    BEFORE UPDATE ON triage_assignments
    FOR EACH ROW EXECUTE FUNCTION alerting_set_updated_at();
DROP TRIGGER IF EXISTS triage_maintainers_set_updated_at ON triage_maintainers;
CREATE TRIGGER triage_maintainers_set_updated_at
    BEFORE UPDATE ON triage_maintainers
    FOR EACH ROW EXECUTE FUNCTION alerting_set_updated_at();

-- Same posture as 0009: server-side connections only, never the Supabase
-- anon/authenticated API roles. Item text and slop flags are not public.
ALTER TABLE triage_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_maintainers ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_cursors ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE triage_items, triage_extractions, '
                'triage_scores, triage_maintainers, triage_assignments, '
                'triage_actions, triage_cursors FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END
$$;
