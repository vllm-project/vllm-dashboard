-- migrate: no-transaction
-- migrate: valid-index idx_otel_spans_treatment_ci_job_step_time
-- /api/timings/latest also reads the OTel treatment branch, for commands main
-- hasn't timed yet. Like 0029 for main, this partial index holds only that
-- branch's CI job spans, keyed by step, so the lookup stays an index scan; it
-- holds a handful of builds. The query repeats this predicate literally.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otel_spans_treatment_ci_job_step_time
    ON otel_spans (step_key, start_time DESC)
    INCLUDE (build_number, job_id, job_state, job_passed, end_time)
    WHERE span_name = 'buildkite.job'
      AND job_type = 'script'
      AND pipeline_slug = 'ci'
      AND (span_attributes->>'buildkite.build.branch') = 'khluu/otel';
