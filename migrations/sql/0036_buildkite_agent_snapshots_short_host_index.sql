-- migrate: no-transaction
-- migrate: valid-index idx_buildkite_agent_snapshots_short_host
-- A bare-metal host's newest agent snapshot is looked up by its short name
-- (the infra scan for a host whose agents are gone, and the daily summary).
-- Buildkite stores the hostname as each agent reported it, in any case and
-- with or without a domain, so the lookup matches the first DNS label of
-- lower(hostname); no other index can serve that, and without this one each
-- probe would read the whole table. CONCURRENTLY avoids blocking the
-- poll-metrics inserts; IF NOT EXISTS keeps replay safe if it was hand-applied.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_buildkite_agent_snapshots_short_host
    ON buildkite_agent_snapshots (split_part(lower(hostname), '.', 1), polled_at DESC);
