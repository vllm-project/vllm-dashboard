-- CI status of open P0-P2 pull requests, for the triage dashboard, Slack
-- lines and "whose move". One row per PR: the Buildkite build GitHub's
-- `buildkite/ci/pr` status points at for the PR's head commit, its job
-- counts, and its failed jobs with whether each also fails on main, now or
-- in the last 7 days (from alerting_main_ci_job_states and
-- alerting_main_ci_job_alerts). Written by the
-- triage-ingest consumer (triage/ci.py); a separate table so refreshing it
-- doesn't touch triage_items (whose updated_at re-queues scoring).
CREATE TABLE IF NOT EXISTS triage_pr_ci (
    item_key            text PRIMARY KEY REFERENCES triage_items (item_key) ON DELETE CASCADE,
    head_sha            text NOT NULL,
    -- not_started: no Buildkite build for the head commit yet (nobody ran
    -- `/ci run`); running also covers a build that is already failing.
    state               text NOT NULL
        CHECK (state IN ('passed', 'failed', 'running', 'canceled', 'not_started')),
    build_number        bigint,
    build_url           text,
    build_state         text,
    jobs_total          integer NOT NULL DEFAULT 0,
    jobs_passed         integer NOT NULL DEFAULT 0,
    jobs_running        integer NOT NULL DEFAULT 0,
    jobs_failed         integer NOT NULL DEFAULT 0,
    -- Of jobs_failed: failing on main now; failed on main in the last 7 days
    -- but not now; neither (and not a lost agent): the PR's own.
    jobs_failed_on_main        integer NOT NULL DEFAULT 0,
    jobs_failed_recent_on_main integer NOT NULL DEFAULT 0,
    jobs_failed_pr_only        integer NOT NULL DEFAULT 0,
    -- Main CI job states were readable and fresh when on_main was decided.
    main_known          boolean NOT NULL DEFAULT false,
    -- [{"name", "key", "url", "count", "on_main", "recent_on_main", "infra"}],
    -- at most 50.
    failed_jobs         jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Last time GitHub (and, while unfinished, Buildkite) was asked.
    checked_at          timestamptz NOT NULL,
    -- Last time anything above changed.
    changed_at          timestamptz NOT NULL
);

ALTER TABLE public.triage_pr_ci ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role name;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE triage_pr_ci FROM %I', api_role);
        END IF;
    END LOOP;
END
$$;
