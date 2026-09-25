-- The daily retention cron deletes about a thirtieth of gpu_snapshots, but
-- the default autovacuum_vacuum_scale_factor (0.2) waits for ~20% dead
-- tuples before vacuuming, so the table carries millions of dead tuples for
-- days at a time and every scan of it slows down. Vacuum at 2% instead so
-- bloat tracks the daily delete cadence.
ALTER TABLE gpu_snapshots SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_analyze_scale_factor = 0.01
);
