-- OTel spans live in ClickHouse (ci.otel_spans) since PRs #292 and #301.
-- Ingestion stopped writing this table on 2026-11-14 12:30 UTC; every span
-- reader (timings, build trace, GPU samples, ?source=otel views) queries
-- ClickHouse, which holds the full history back to 2026-08-14. Dropping the
-- table frees about 317 GB, nearly all of the database. Nothing depends on
-- it (no views or foreign keys), so this needs no CASCADE.
DROP TABLE IF EXISTS otel_spans;
