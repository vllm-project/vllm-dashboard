-- migrate: no-transaction
-- migrate: valid-index idx_buildkite_agent_snapshots_lower_host
-- The daily summary looks up a bare-metal host's newest agent snapshot by
-- name. Buildkite stores the hostname as each agent reported it, in any case
-- and with or without a domain, so the lookup matches lower(hostname); the
-- plain (hostname, polled_at) index can't serve that, and without this one
-- each probe would read the whole table. CONCURRENTLY avoids blocking the
-- poll-metrics inserts; IF NOT EXISTS keeps replay safe if it was hand-applied.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_buildkite_agent_snapshots_lower_host
    ON buildkite_agent_snapshots (lower(hostname), polled_at DESC);
