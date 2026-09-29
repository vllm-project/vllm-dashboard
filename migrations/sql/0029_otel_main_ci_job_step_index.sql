-- migrate: no-transaction
-- migrate: valid-index idx_otel_spans_main_ci_job_step_time
-- /api/timings/latest finds the newest main-branch CI build where every job
-- of one step passed. The existing job index has no step_key, so the filter
-- fetches every recent job span from the heap: about 37k rows per day of
-- window, 16 seconds for one day, past the two-minute statement timeout for
-- two weeks. This partial index holds only main-branch CI job spans, keyed by
-- step, so PR runs never enter it. The query repeats this predicate
-- literally. CONCURRENTLY avoids blocking span ingestion; IF NOT EXISTS keeps
-- replay safe.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otel_spans_main_ci_job_step_time
    ON otel_spans (step_key, start_time DESC)
    INCLUDE (build_number, job_id, job_state, job_passed, end_time)
    WHERE span_name = 'buildkite.job'
      AND job_type = 'script'
      AND pipeline_slug = 'ci'
      AND (span_attributes->>'buildkite.build.branch') = 'main';
