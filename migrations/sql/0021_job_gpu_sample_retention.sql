-- migrate: no-transaction
-- Fine-grained samples have a shorter lifetime than command/test timing spans.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_otel_gpu_samples_end
    ON otel_spans (end_time)
    WHERE span_name = 'ci.gpu.samples';
