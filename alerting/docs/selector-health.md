# CI selector health alerts

## Why it exists

vLLM's PR builds run only the test steps ci-selector
([ci-infra `buildkite/ci_selector`](https://github.com/vllm-project/ci-infra/tree/main/buildkite/ci_selector))
picks. It decides from recordings the scheduled Full CI runs on `main`
make: a Python function table (fnrec, step `fnrec-collect`) and CUDA and ROCm
kernel tables (kernrec, step `kernrec-collect`), each kernel table paired
with a symbol map uploaded by `image-build` (`kernel_symbol_map.json.gz`) or
`image-build-amd` (`kernel_symbol_map.rocm.json.gz`). Both collect steps are
`soft_fail`, so a broken collect never turns a build red. From 2026-10-24 to
10-30 no CUDA kernel table was published (a setup script broke under
`/bin/sh`, so no job delivered a recording, and the collect passed with
`0 recording files from 0 jobs` / `nothing to fold`) and PR decisions kept
using build 96933 for six days with nothing said. And in full run #100914
(2026-11-08 19:00 UTC) every collect step passed and published, but the
CUDA kernel table had 95 usable rows of 253 (157 rows came from jobs that
passed with `trace_complete: false`), against about 243 a week earlier. This
slice says so.

## Components

Every scheduled full run (first message line exactly `Full CI run -
nightly` or `Full CI run - daily`) is recorded as five components:

| Component | Produced by | Recorded |
|---|---|---|
| `fnrec` — Python function table | `fnrec-collect` (`table.json.gz`, `fnrec_collect_summary.json`) | collected, published, expected/delivered jobs, rows. Usable rows are unknown: the summary has no `usable_rows` and the ~125 MB table is never downloaded. The slice reads `usable_rows` as soon as the summary carries it. |
| `kernrec_cuda` / `kernrec_rocm` — CUDA / ROCm kernel table | `kernrec-collect` (`kernel_table[.rocm].json.gz`, `kernrec_collect_summary.json`) | collected, published, expected/delivered jobs, rows, usable rows and share, and the rows failing each usability condition (`passed` false, `trace_complete` not true, `dropped`, `complete` false), counted from the ~0.5 MB tables themselves; if a table cannot be read, the summary's (or log's) `usable_rows` stands. |
| `map_cuda` / `map_rocm` — CUDA / ROCm kernel source map | `image-build` (`kernel_symbol_map.json.gz`) / `image-build-amd` (`kernel_symbol_map.rocm.json.gz`); `kernrec-collect` re-uploads both | collected (uploaded by the image build), published (re-uploaded by the kernel collect), objects, device objects, symbols, distinct `csrc/` sources. |

A kernel-table row is usable iff `passed`, `complete` (default true), not
`dropped`, `backend` in {cuda, rocm}, and `trace_complete is True` — the
selector's own rule. Tables older than version 3 (before trace health, e.g.
build 96933) have no `backend` or `trace_complete`; their rows are usable on
`passed`, `complete` and not `dropped`, as their collect counted them.

A source map is `ok` when it is readable, has objects, carries no `reason`,
and its `commit` is the run's commit. It is `broken` when its image build
ran and it is unreadable, carries a `reason`, has no objects, was built from
another commit, or is for the other backend, or when it was not uploaded
although its backend's kernel recorder was armed for the run. It is
`missing` (no alert) when the image build did not run or the backend was
not armed (ROCm before its recorder was on).

## What it detects

Five conditions, each one episode per subject:

- **`run_incomplete`** (per component: `fnrec`, `kernrec_cuda`,
  `kernrec_rocm`, `map_cuda`, `map_rocm`) — in the latest completed
  scheduled full run, the recording is not whole: its collect job failed or
  soft-failed with no backend verdict to explain it, its verdict is not
  `ok`, it was expected and published nothing, or it delivered fewer than
  80% of the expected jobs; or the source map is `broken` (above). A backend
  that was not armed for that run (ROCm before it was on, `expected_jobs`
  0) is `off` and never alerts.
- **`rows_degraded`** (per table: `fnrec` once its usable rows are known,
  `kernrec_cuda`, `kernrec_rocm`) — the latest completed run's table is
  whole and published, but under 70% of its rows are usable, or its usable
  rows are under 60% of the median usable rows of the previous 7 completed
  runs (counting those that published the table with a known usable count;
  the median rule waits until 3 such runs exist). #100914 opens it for
  `kernrec_cuda` only (95/253 = 38%, and 95 < 60% of ~243); ROCm's 215/245
  (88%) is fine. Each run's reason is also stored on its component
  (`rows_degraded`) so the page shows what the alert saw.
- **`stale`** (per recording) — the newest run whose recording published is
  more than 30 hours older than the newest completed run, or nothing
  published in the 14-day history. `kernrec_rocm` alerts only once it has
  published at least once.
- **`pr_stale`** (per recorder: `fnrec`, `kernrec`, `kernrec_rocm`) — in the
  last 6 hours of PR decisions, the median recording build is more than 30
  hours older than the newest run that published that recording
  (`kernrec` is the CUDA table, `latest.json`; `kernrec_rocm` only once
  decisions name a ROCm kernel table): published recordings are not being
  picked up.
- **`pr_errors`** (subject `selector`) — more than 5% of the last 24 hours'
  PR builds ended in a `fallback` starting with `selector failed` or
  `gate error`, and at least 5 did. `selector declined: ...` is not an error.

A completed run is one whose two collect jobs have finished (a run still
collecting is neither graded nor resolves anything). Episodes open on the
first observation, because a full run only comes twice a day, and resolve on
the first healthy one. A condition with no observation (no PR decisions with
records in the window) leaves its episode as it is. All thresholds live in
`SelectorHealthThresholds` in `alerting/selector_health.py`.

PR builds are every non-`main` build of `vllm/ci`. Their outcome is
`applied`, `skipped` (with the decision's `skipped` reason), `fallback` (with
its reason), or `missing` when the bootstrap uploaded no
`ci_selector_decision.json` (docs-only builds, a failed bootstrap).

Each decision also records which kernel backends it used. Today
`records.kernrec` is `{"backend": "cuda", "build": N, ...}`. A ci-infra
change makes the gate fetch the ROCm kernel pair too, in a shape that is not
final, so `decision_kernel_builds` reads it liberally: `records.kernrec` as
one dict (its `backend`, default cuda), a dict of per-backend dicts, or a
list of per-backend dicts, and extra keys such as `records.kernrec_rocm`
(backend from the entry, else the key suffix). The CUDA build is stored as
`kernrec_build`, the ROCm build as `kernrec_rocm_build`, and every backend
named as `kernel_backends`.

### Before and after ci-infra#881

After ci-infra#881 each collect job uploads `fnrec_collect_summary.json` or
`kernrec_collect_summary.json` with per-backend `expected_jobs`,
`delivered_jobs`, rows and `verdict`, and soft-fails when an armed backend is
not whole. Those summaries are read first. When the kernel collect
soft-fails, the failure is blamed on the backends whose own verdict is not
ok, so a CUDA failure does not mark a published ROCm table broken.

The kernel collect's two tables are then read whole for usable rows and row
failure counts (component `source` = `table`), falling back to the summary's
or log's usable rows if a table is absent or unreadable. The two source maps
are read from the image builds. The Python table is never downloaded.

Runs without a summary are read from the collect job's log (ANSI codes and
`_bk;t=` markers stripped). Kernel logs: `N recording files from M jobs`,
`wrote out/kernel_table[.rocm].json.gz (...): {... 'rows_usable': N ...}`,
`<backend> has no valid table/map pair`, `published; latest[.rocm].json ->
<sha>`, `nothing to fold`. CUDA is treated as armed whenever the kernel
collect ran, and ROCm when its log folds or rejects a ROCm table. Python
logs: `expecting N jobs`, `D/E started jobs recorded`, `N rows (`,
`published; latest.json -> <sha>`, `nothing to fold`, `table has no usable
rows`, `REFUSING`. Old logs carry no per-backend job counts, so the 80% rule
applies only to Python runs and to runs with a summary.

## Where the code lives

- `alerting/selector_health.py` — the slice: records, log and summary
  parsers, the pure `plan_selector_health` planner, renderers,
  `SelectorHealthHandler`, and the `BuildkiteSelectorSource` adapter over
  `BuildkiteRestClient` (`alerting/full_ci.py`: builds, jobs, job artifacts,
  log tails; artifact downloads keep the token off the S3 redirect).
- Ports/adapters: `SelectorSource` + `SelectorHealthStore`, implemented by
  `alerting/postgres.py` (`PostgresAlertStore.selector_health_state`,
  `commit_selector_health`) with the in-memory double
  `InMemorySelectorHealthStore` in `alerting/memory.py`.
- Deployment: `deploy/aws/systemd/alerting-selector-health.timer` runs
  `run-worker selector-health` (`selector_health_scan`: full runs and PR
  decisions) at 04:45 and 16:45 America/Los_Angeles, after each full run's
  collect steps (which can take until about 4.5 hours after the 07:00 and
  19:00 UTC starts). `alerting-selector-health-pr.timer` runs
  `run-worker selector-health-pr` (`selector_health_pr_scan`: PR decisions
  only, re-planned against the stored runs) every hour at :25 UTC.

## Configuration

- `BUILDKITE_TOKEN` (the worker's existing read token) and `DATABASE_URL`.
- Slack: `SLACK_BOT_TOKEN`; alerts post to `SLACK_CI_INFRA_ALERT_CHANNEL`,
  else to the shared alert channel (`SLACK_CI_ALERT_CHANNEL`, default
  `C0ANHBE642Y`), the same fallback as infra alerts.
- Control plane: S3 `control/selector.mode` (`shadow` default / `live` /
  `disabled`) applied to both selector timers. A missing control starts in
  shadow: records and rendered posts are written, nothing is delivered.
- Thresholds: `SelectorHealthThresholds` (80% delivered, 30 h stale, 6 h PR
  window, 5% and 5 builds over 24 h, 14-day history; usable share 70%, 60%
  of the median of the previous 7 runs once 3 exist).

## What it posts to Slack

One message per episode, headed `🧭 CI SELECTOR`. It names the component,
the full-run build with a Buildkite link, the verdict, delivered vs expected
jobs and usable rows, the last build that published it and how many hours
it trails, and links the `/selector` page. A `rows_degraded` message gives
the reason (usable share, or the drop against the median), the unusable rows
by cause (incomplete trace, job not passed, dropped, incomplete), and the
median. A source-map message gives the map's verdict and object count. The resolve edits that message in
place into a ✅-prefixed, struck-through copy (a fresh post only when the
original is gone). Delivery IDs are deterministic per episode
(`selector:<condition>:<digest>:<opened epoch>:open|resolve`).

## Dashboard

`/selector` ("CI Selector", Health → Metrics) shows one row per scheduled
full run of the last 14 days with a cell per component (usable/all rows and
delivered/expected jobs for tables, objects and symbols for maps; amber for
a degraded table; verdict on hover), a detail table for the selected run
(default: the latest completed) with every component's collected and
published flags, jobs, rows, usable rows and share, why rows are unusable,
and map objects, device objects, symbols and sources; a freshness panel
(published build, age, the build PR decisions use for each table, and the
kernel backends decisions named), a daily PR-decision table (with kernel
backends per day), and open and recent episodes. Backed by
`src/app/api/selector/route.ts`, read-only.

## Tables

Writes (migration `0036_selector_health.sql`):
`alerting_selector_full_runs` (one row per run; `settled` runs are not
fetched again), `alerting_selector_run_components` (per run and component:
status, job state, expected/delivered jobs, rows, usable rows, rows failing
each usability condition, map objects/device objects/symbols/sources,
verdict, collected, published, published commit, `rows_degraded`, source),
`alerting_selector_decisions` (per non-main build, with `kernrec_build`,
`kernrec_rocm_build` and `kernel_backends`), and
`alerting_selector_alerts` (episodes; a partial unique index keeps at most
one open per `(condition, subject_key)`), plus `alerting_notification_outbox`
and `alerting_automation_executions`. Runs and decisions older than 30 days
are pruned in the scan transaction.
