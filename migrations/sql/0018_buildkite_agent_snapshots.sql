-- Connected Buildkite agents sampled by the five-minute poll-metrics cron.
-- Each poll inserts one row per connected agent so the GPU dashboard can join
-- a host to the queue it serves and the job it is currently running. Rows are
-- retained for 30 days (matching queue_snapshots), which also records which
-- job was running on a host at a given time.
CREATE TABLE IF NOT EXISTS buildkite_agent_snapshots (
    id            serial PRIMARY KEY,
    polled_at     timestamptz NOT NULL DEFAULT now(),
    agent_name    text NOT NULL,
    hostname      text,
    queues        text[] NOT NULL DEFAULT '{}',
    job_id        text,
    job_label     text,
    build_number  bigint,
    job_url       text
);

CREATE INDEX IF NOT EXISTS idx_buildkite_agent_snapshots_polled
    ON buildkite_agent_snapshots (polled_at DESC);

CREATE INDEX IF NOT EXISTS idx_buildkite_agent_snapshots_host
    ON buildkite_agent_snapshots (hostname, polled_at DESC);
