-- migrate: no-transaction
-- migrate: valid-index idx_gpu_snapshots_dead_memory
-- The infra scan's gpu_dead_memory query filters dead_proc_mem_mb IS NOT NULL
-- over the last two days of gpu_snapshots. Only hosts running the newest
-- reporter write the column, so the filter walks every recent row of every
-- other host and intermittently exceeds the two-minute statement timeout,
-- failing the whole scan. Indexing only the matching rows keeps the query
-- off the uninstrumented majority. CONCURRENTLY avoids blocking reporter
-- writes; IF NOT EXISTS keeps replay safe if the index was hand-applied.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gpu_snapshots_dead_memory
    ON gpu_snapshots (hostname, gpu_index, reported_at DESC)
    INCLUDE (dead_proc_mem_mb)
    WHERE dead_proc_mem_mb IS NOT NULL;
