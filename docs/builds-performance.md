# Diagnosing slow Builds (main page) loads

The main page loads in a chain: page shell, then `/api/builds/filters` and
`/api/builds` in parallel, then `/api/builds/groups?buildIds=...` for the 50
builds on the first page. The groups response carries the Job Groups filter
options, so a slow groups call delays the whole filter/table area.

Run the read-only probe against a local server or production:

```bash
BASE=https://ci.vllm.ai node scripts/profile-builds.mjs
BASE=http://localhost:3000 BYPASS_CDN=1 node scripts/profile-builds.mjs
```

The probe times each chain step and the total. It exits nonzero for failed
requests or chains over `MAX_MS` (default 3000). Set `START`, `END`,
`PIPELINE`, and `BRANCH` to reproduce reported filters; set `SAMPLES` (1–20)
for repeats. `BYPASS_CDN=1` gives each URL a unique diagnostic parameter; it
does not bypass the application caches. `/api/builds/groups` responds with a
`Server-Timing` header breaking out `roster` (Buildkite REST), `spans` (OTel
fallback), or `warehouse` (Databricks) time.

## Why cold groups loads were slow (2026-09-09)

In OTel mode `/api/builds/groups` reads each build's job roster from the
Buildkite REST API, because OTel spans only cover jobs that ran — jobs behind
the pipeline's manual gate never execute and produce no spans. That is one
REST call per build, ~50 per page, and the request URL embeds the current
build ids, so every new CI build creates a URL no CDN or application cache
has seen. Production misses measured 3.5–3.6 s (twice) versus 56–92 ms warm.

Settled builds (passed/failed/canceled/skipped/not_run/finished) have an
immutable roster, so they are now cached per build for 24 hours; only active
builds are refetched. Steady-state misses therefore fetch a handful of builds
instead of 50. Failed fetches are never cached, and concurrent requests for
the same build share one fetch.

## Remaining risks

- `/api/builds/filters` cold misses measured 2.4–8.5 s in production, but the
  SQL itself runs 50–400 ms warm; the spread is serverless cold start plus
  database buffer state, not query shape. Both filter queries are bounded to
  30 days so cold scans do not grow with table history.
- The OTel roster fallback (`queryBuildJobsFromOtel`, used when the Buildkite
  token fails) measured 77–92 s for 50 builds: the row constructor
  `(pipeline_slug, build_number) IN (...)` cannot use `idx_otel_spans_build`
  because its leading `organization_slug` column is unconstrained. Roster
  caching makes an empty roster (and therefore this fallback) much less
  likely, but the query itself still needs an org-scoped rewrite or index.
  To reproduce: `node --env-file=.env.local --import tsx scripts/profile-groups.mjs`
  (without a Buildkite token the roster returns empty and the fallback runs).

To time the filters queries directly, bypassing browser/CDN/application
caches:

```bash
node --env-file=.env.local --import tsx scripts/profile-filters-db.mjs
```
