# vLLM CI Dashboard: tasks for parallel agents

Source: review of https://ci.vllm.ai on 2026-09-03. Each task below is
self-contained and mostly data or logic. They can run in parallel in separate
worktrees branched from `main`.

## Ground rules for every task

- Branch from `main`. One task per branch and PR.
- Keep changes to logic, data, and the minimum UI needed. **Do not restyle.**
  A separate session is reworking the shared UI kit and page layout
  (`src/components/segmented-control.tsx`, `stat-card.tsx`, `section-nav.tsx`,
  `nav.tsx`, `src/app/layout.tsx`, `globals.css`, `builds-table.tsx`,
  `build-chart.tsx`, the perf pages, and the home page). Reuse existing
  components and classes; do not introduce new colors, radii, or controls.
- Run `npm run lint` and `npm test` before opening the PR.
- Add unit tests next to existing ones (`src/lib/*.test.ts`,
  `src/components/*.test.ts`), run with `npm test`.

---

## Fix first

### 1. Authenticate the Main CI alert resolve endpoint

**Why.** `POST /api/alerts/main-ci/resolve` accepts `{alertId}` with no auth
and marks the alert resolved in Postgres. The dashboard is public, so anyone
can close alerts. The Resolve button renders for every visitor.

**Files.** `src/app/api/alerts/main-ci/resolve/route.ts`,
`src/components/main-ci-alerts.tsx`, `src/app/alerts/alerts-content.tsx`,
`README.md`.

**Steps.**
1. Look at how queue-job promotion is authorized: grep `BUILDKITE_QUEUE_OPERATOR_TOKEN`
   under `src/` (server check in the route under `src/app/api/queue/jobs`,
   client token entry in `src/components/queue-waiting-jobs.tsx`). Reuse that
   mechanism and env var, or add `ALERT_OPERATOR_TOKEN` if separate scopes are
   warranted. Document the env var in the README table.
2. Require `Authorization: Bearer <token>` in the resolve route. Return 401 on
   missing or invalid token, 503 when no token is configured. Constant-time
   comparison.
3. Only show Resolve when the operator token has been entered for this tab
   (mirror the queue page UX; sessionStorage, never the URL). Send the header
   from `resolveAlert` in `alerts-content.tsx`.
4. Unit test the token check helper.

### 2. Render Buildkite emoji shortcodes in all job names

**Why.** Job names contain `:amd:`, `:nvidia:`, `:docker:`, `:database:`,
`:computer:`, `:github:`. `src/components/job-name.tsx` already renders these as
icons and is used on Alerts, but other pages print the raw text.

**Files.** `src/app/jobs/page.tsx` (both ranking tables and the
"Highest Failure Rate" / "Slowest Job" stat card details),
`src/app/cost/page.tsx` (Cost by Job table),
`src/components/build-waterfall.tsx` (timeline rows),
check `src/components/builds-table.tsx` failed-job lists and
`src/components/queue-waiting-jobs.tsx`.

**Steps.**
1. Read `job-name.tsx` for its API. If a plain-text stripping helper is needed
   (stat card `detail`, `title` attributes, sort keys), add it in the same file
   with a test.
2. Swap raw rendering for the component or helper. Sorting and searching must
   work on the display name without the shortcode.
3. Do not change layout, colors, or spacing.

### 3. Make Cost page totals honest about priced coverage

**Why.** On `/cost` for 2026-08-20 to 2026-09-03, Total Cost shows $31,176
"Known queues only", but only 7 of 33 queues are priced. `h200_35gb` (23,207 h)
and `amd_mi300_1` (20,456 h) have no price, so the total is misleading. The
"Daily cost by queue" chart also rendered empty in two headless captures even
though `/api/cost` returned 105 `dailyCostByQueue` rows with `total_cost > 0`.

**Files.** `src/app/cost/page.tsx`, `src/app/api/cost/route.ts`,
`src/lib/queue-costs.ts`.

**Steps.**
1. Add `pricedHoursShare` (priced hours / total hours) to the API response and
   show it in the Total Cost card detail, e.g. "Covers 18% of compute hours".
   Keep the StatCard API.
2. Add hourly rates for unpriced queues where knowable. For self-hosted or
   partner hardware (AMD MI300/MI355, H200 pools, TPU, Intel) either add a
   clearly labeled `estimated: true` rate with a source comment, or leave
   unpriced and make the "Unpriced Queues" card list them on expand.
3. Mark estimated rates in the Cost by Queue table with an "est." suffix (no
   new colors).
4. Verify the daily chart in a real browser (`npm run dev`). If it is a real
   bug (Recharts key characters, animation or initial render), fix it.

---

## Page behavior

### 4. Default the Queue page to the busiest queue and link summary rows

**Why.** `/queue` defaults to `gpu_1_queue` (3 agents, 0 waiting, no
percentiles) while `h200_35gb` had 128 agents and 43 waiting. Queue Summary rows
are plain text.

**Files.** `src/app/queue/page.tsx`, `src/components/queue-table.tsx`,
`src/app/api/metrics/*`, `src/app/api/queue/route.ts`, `src/components/nav.tsx`
(prefetch hard-codes `queue=gpu_1_queue`).

**Steps.**
1. With no `queue` param, default to the queue with the most waiting jobs
   (fallback: most agents, then the current constant). Read the summary first,
   then select. Fix the prefetch in `nav.tsx`.
2. Make Queue Summary rows clickable and keyboard-accessible to select that
   queue and scroll metrics into view. Highlight the selected row with existing
   zinc tokens.
3. Put `queue` and `range` in the URL via `useSearchParams` + `router.replace`,
   following `src/app/alerts/alerts-content.tsx`.
4. Do not change stat cards, segmented controls, or chart styling.

### 5. Add a confidence threshold and trend data to the Jobs ranking

**Why.** Failure Ranking sorts by raw rate, so a job with 5 runs at 100%
outranks one with 45 runs at 64%. There is no "failing since", no trend, and
no Buildkite link.

**Files.** `src/app/api/jobs/route.ts`, `src/app/api/jobs/runs/*`,
`src/app/jobs/page.tsx`, `src/lib/databricks.ts`, `src/lib/optional-jobs.ts`.

**Steps.**
1. API: add per job `wilsonLowerBound` (95% lower bound of failure rate),
   `firstFailureAt`, `lastFailureAt`, `lastPassedAt`, `dailyHistory` as
   `{date, passed, failed}[]` (cap 30 days), and `buildkiteUrl` for the latest
   run if available. Keep the response near its current ~130 KB.
2. Page: add a "Min runs" control (1 / 5 / 10 / 20, default 5) filtering
   client-side; sort Failure Ranking by `wilsonLowerBound` while still showing
   the raw rate; add a "Failing since" column with relative time. Expose
   `dailyHistory` in a `title` or data attribute only; sparkline styling is
   owned elsewhere.
3. Link job names to `buildkiteUrl` using the existing external-link treatment.
4. Unit test the Wilson bound helper in `src/lib/`.

### 6. Group parametrized tests and add server-side search on Tests

**Why.** `test_modular_oai_triton_moe.py::test_oai_triton_moe[...]` appears as
about 15 rows, one per parameter set. The search box says "Search this page"
and only filters the 30 loaded rows.

**Files.** `src/app/tests/page.tsx`, `src/app/api/tests/route.ts`,
`src/lib/test-groups.ts` (+ `.test.ts`), `src/lib/test-areas.ts`.

**Steps.**
1. Grouping (default on): collapse rows sharing file + function (strip the
   `[...]` suffix). Group row shows function name, variant count, worst
   reliability, total executions and failures; expands to variants. Put the
   helper in `test-groups.ts` with tests.
2. Search: check the Test Engine API for a server-side query param. If present,
   wire a debounced `q` through the API and page; otherwise fetch more pages
   server-side when a query is present (bounded) and filter there. Update the
   placeholder text to match reality.
3. Keep pagination working with grouping (group within a page; caption if
   groups may span pages).
4. Reuse existing row markup; no new colors or header changes.

### 7. Collapse repeated jobs in Fast failures alerts

**Why.** On `/alerts?tab=fast-ci&window=7d`, build `584e8f0` lists 48 rows,
many the same job repeated 4 to 6 times.

**Files.** `src/lib/alerts-fast-ci.ts` (+ `.test.ts`, has
`groupFastFailureEvents`), `src/components/fast-ci-alerts.tsx` (+ `.test.ts`),
`src/app/alerts/alerts-content.tsx`.

**Steps.**
1. Within each build group, group events by job name with `count`,
   `firstFinishedAt`, `lastFinishedAt`, worst Slack delivery state, and the
   event list. Unit tests.
2. Render one row per job group with a "×N" badge when N > 1 and a disclosure
   to expand individual events (reuse existing row markup). Single-event rows
   stay unchanged.
3. Collapse builds with more than 10 job groups behind "Show all N jobs".

### 8. Deduplicate eval runs and compare against a rolling baseline

**Why.** `/eval` shows four rows for `openai/gpt-oss-120b`, `gsm8k`, commit
`33898f8`, all at "Wed 2:02 PM", 83.62% ±1.02%. Regression watch compares only
to the immediately previous run. The Tasks stat shows 1 while the filter offers
12 tasks.

**Files.** `src/lib/eval-data.ts`, `src/lib/eval-images.ts`,
`src/app/api/eval/route.ts`, `src/app/api/eval/filters/*`,
`src/app/api/eval/samples/*`, `src/app/eval/page.tsx` (data shaping and run
list only).

**Steps.**
1. Dedupe runs by (model, task, commit, image, score, stderr, n_samples) within
   a 10-minute window; keep the earliest, record `duplicateCount`, show "×N"
   next to the time when N > 1.
2. Replace previous-run comparison with a rolling baseline: median of the last
   K=5 runs for the same model+task (excluding current). Flag when
   |current − baseline| > max(2 × stderr, 1 pp). Compute sigma against the
   baseline. Put the math in `eval-data.ts` with tests.
3. Fix the Tasks count to reflect the filtered dataset, not the current page.

### 9. Add baseline and candidate presets to the Compare page

**Why.** `/compare` opens with two empty selects and a long list of raw image
strings. Users must know exact tags.

**Files.** `src/app/compare/compare-content.tsx`,
`src/app/compare/[...filters]/page.tsx`, `src/lib/compare.ts`,
`src/lib/commit-from-image.ts`, `src/lib/eval-images.ts`,
`src/app/api/compare/*`, `src/app/api/perf/filters`, `src/app/api/eval/filters`.

**Steps.**
1. Add `classifyImage(image)` returning
   `{kind: 'release' | 'nightly' | 'commit' | 'other', version?, date?, sha?}`
   with tests, based on real tags from the two filters endpoints.
2. Add a preset row above the selects: "Latest nightly vs previous nightly",
   "Latest release vs previous release", "Latest nightly vs latest release",
   "Latest main commit vs latest release". Show only presets that resolve.
   Presets set the same URL params the manual selects use.
3. Show a human label beside each select once chosen (e.g. "release v0.29.0 ·
   33898f8") and group options by kind, newest first.

---

## Backend

### 10. Link GPU hosts to the Buildkite jobs running on them

**Why.** `/gpu` shows `dgxb200-01` at 97% memory and 94% utilization with no
way to see which queue it serves or which job is running. `/queue` shows 50
queues with no link to hardware.

**Files.** `src/lib/gpu-data.ts`, `src/lib/gpu-types.ts`, `src/app/api/gpu/*`,
`src/lib/buildkite-agent-query.ts` (+ `.test.ts`),
`src/lib/buildkite-queue-jobs.ts`, `src/app/api/cron/*`,
`src/app/gpu/gpu-dashboard.tsx` (Host Summary data mapping only),
`migrations/`.

**Steps.**
1. Extend the 5-minute agent sampling to persist, per connected agent:
   hostname, queue tag(s), current job id/name/build number/web URL. Add a
   migration under `migrations/` following that module's plan + explicit apply
   conventions. Never create tables from request handlers.
2. Add `GET /api/gpu/agents` (or extend `/api/gpu/latest`) joining GPU hosts to
   agents by hostname. Normalize case and domain suffix; document mismatches.
3. Add `queue` and `currentJob` to the Host Summary mapping and render
   "queue · job name" as plain text with a Buildkite link under the host name.
4. Unit tests for hostname normalization and the join.

---

## Not for delegation (owned by the UI session)

Design tokens and fonts, the shared control kit, section shell and navigation,
the Overview home page, the Builds table redesign, URL state for filters, Perf
chart cleanup, mobile layout fixes, per-build and per-job detail pages, and the
final styling pass over whatever the tasks above add.
