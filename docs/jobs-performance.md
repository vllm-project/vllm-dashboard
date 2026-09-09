# Diagnosing slow Jobs loads

Run the read-only probe against a local server or production:

```bash
BASE=https://ci.vllm.ai node scripts/profile-jobs.mjs
BASE=http://localhost:3000 SOURCE=otel BYPASS_CDN=1 node scripts/profile-jobs.mjs
```

The probe times the page shell, filter options, and three sequential jobs API
requests. It exits nonzero for failed requests or jobs loads over `MAX_MS`
(default 3000). Set `START`, `END`, `PIPELINE`, and `BRANCH` to reproduce the
reported filters; set `SAMPLES` (1–20) to control request count. Omit `SOURCE`
to use the deployment's configured backend, or explicitly compare `otel` and
`databricks`. These backends can have different coverage; switching sources is
not a performance fix by itself.

In browser DevTools, open Network and inspect `/api/jobs`:

- `X-Vercel-Cache` and `Age` describe the CDN response. HIT/STALE responses can
  retain timing headers from the original cache fill, not the current request.
- `Server-Timing` includes `source`, application `cache` (HIT, MISS, or
  COALESCED), and handler `total`. Databricks includes separate `failures`
  and `duration` measurements; OTel includes a single `statistics` measurement
  and overall `backend` time.
  Failed requests use `cache=ERROR`; the originating fill records both query
  durations for Databricks, or the statistics duration for OTel, before returning
  an error. Followers report their own total wait.
- Query times include connection acquisition, transport, and database work.
  They are not database execution plans. Databricks queries run concurrently,
  so do not sum them to calculate total latency.
- A large query duration directs investigation to warehouse query history or
  Postgres query plans/pool pressure. Low server time with high time to first
  byte points toward startup, routing, or network delay. If the API finishes
  quickly but rows appear late, capture a browser Performance trace.

`BYPASS_CDN=1` gives each probe URL a unique diagnostic parameter. It does not
bypass the 60-second application cache. To measure an application miss, use a
fresh local process, wait for expiry, or reproduce an uncached filter selection.
Concurrent identical jobs requests share one load per server instance (one
OTel query or two Databricks queries). Separate instances still rely on CDN caching; this is not a global
lock. TTLs and data freshness are unchanged. Charts load when a job is expanded.

## Investigation baseline (2026-09-08)

Measurements from this workstation against production, not an aggregate or
an SLA: page HTML 446 ms; default jobs data 82 ms (CDN STALE); alternate date
range 1255 ms (MISS); explicit Databricks two-week request 7645 ms (MISS).
Further uncached source comparisons returned OTel in 1182 ms and Databricks in
1756 ms. Direct calls through the local handler took approximately 1.0 s for
Databricks and 1.4 s for OTel. This reproduced variable backend latency, but not
the full reported 15 seconds. Default responses matched the OTel row counts;
the deployment's environment setting was not inspected.

A regression test against the actual jobs handler reproduced eight simultaneous
requests issuing 16 warehouse statements. Coalescing reduces that to two,
while preserving results, separate filter keys, and retries after failure.
These changes reduce duplicate load and initial JavaScript work; production
latency must be measured again after deployment before claiming a speedup.

## Local verification

The production build passes. Its initial `/jobs` scripts exclude the chart
library (the chart chunk is approximately 397 kB uncompressed, 114 kB gzipped).
Browser checks verified the table and the chart after expansion without console
errors. Local production-server probes recorded Databricks MISS at 707 ms and
HIT at 7 ms; OTel MISS at 1299 ms and HIT at 6 ms. These samples verify the
instrumentation and cache paths, not a production before/after comparison.
Regression coverage also holds a partial query failure open until its sibling
settles, preventing retries from launching duplicate outstanding work.

## First-load follow-up

A fresh Chrome incognito window loaded the production jobs API in 31 ms,
with CDN `STALE`, `Age: 102`; page load was 356 ms and all recorded requests
finished by 804 ms. Incognito clears browser state but does not clear shared
CDN/application/database caches. The default response matched the explicit OTel
response exactly after sorting by job name; Databricks returned different data.
This indicates the live page was using OTel, so the earlier explicit Databricks
sample cannot be assumed to explain its delay.

The real OTel handler reproduced a 14,531 ms first call. A subsequent probe of
the unchanged handler measured 10,178 ms with a fresh connection pool versus
1,125/1,012 ms on repeats. Plans showed the duration query doing approximately
230,000 parent-build index lookups. Connection setup, database cache state and
concurrent load can contribute to first-call variance; the measurements do not
attribute the entire delay to SQL execution alone.

The optimized OTel handler calculates both rankings in one aggregate over the
same completed jobs, filtering duration aggregates to passed jobs. This avoids
the second scan/join and second connection. A read-only repeatable-read snapshot
comparison returned identical statistics in three trials: combined SQL took
412/384/372 ms versus 1,043/1,113/1,046 ms for the slower old query. The changed
handler then measured 725 ms with a fresh pool and 366/384 ms on repeats.
These are samples from the workstation against the configured database, not
proof of a production latency bound. The changes still require deployment.

To reproduce first versus repeated database calls without any HTTP cache:

```bash
node --env-file=.env.local --import tsx scripts/profile-jobs-db.mjs
```

Start a new process for each fresh-pool comparison. This does not flush the
database's shared buffers or restart its pooler. The probe asserts one statistics
query per call and a `MAX_MS` budget (default 3000), and prints `dispatchMs`
(time until the SQL driver sends each statistics query) to distinguish startup
and connection waits from work after submission. No SQL, credentials, or job
contents are logged. Filter overrides match the HTTP probe.

## Cold-instance fills, stable window keys, and the cache warmer (2026-09-09)

Post-fix, warm-instance application misses measure 300–900 ms. The remaining
spike is the first fill on a cold serverless instance: 20.7s and 23.1s fills
were measured on the default key while interleaved warm-instance misses took
under a second. Because `staleWhileRevalidate` absorbs revalidations, users
only pay this when a POP has no entry at all — which used to happen every
morning, because the page put absolute `startDate`/`endDate` in the URL and
the midnight rollover created a cache key no edge had ever seen.

The default view now sends `window=14d` instead of absolute dates. The route
resolves the window at fill time, so the URL — and its CDN entry — is stable
across days and stale-while-revalidate can serve every request instantly.
Explicit date ranges keep the old per-day keys. `/api/cron/warm-defaults` runs
every minute against that same stable URL with a CDN-bypassing parameter,
keeping the origin application cache warm so even a first fill costs the
warm-query time (~300–500 ms) instead of the cold-instance penalty. The cron
warms only the region its request lands in, and it reports the warm request's
`Server-Timing` in its JSON response.
