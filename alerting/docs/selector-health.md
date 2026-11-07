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
using build 96933 for six days with nothing said. This slice says so.

## What it detects

Four conditions, each one episode per subject:

- **`run_incomplete`** (per recording: `fnrec`, `kernrec_cuda`,
  `kernrec_rocm`) — in the latest completed scheduled full run, the
  recording is not whole: its collect job failed or soft-failed with no
  backend verdict to explain it, its verdict is not `ok`, it was expected
  and published nothing, or it delivered fewer than 80% of the expected
  jobs. A backend that was not armed for that run (ROCm before it was on,
  `expected_jobs` 0) is `off` and never alerts.
- **`stale`** (per recording) — the newest run whose recording published is
  more than 30 hours older than the newest completed run, or nothing
  published in the 14-day history. `kernrec_rocm` alerts only once it has
  published at least once.
- **`pr_stale`** (per recorder: `fnrec`, `kernrec`) — in the last 6 hours of
  PR decisions, the median `records.<recorder>.build` is more than 30 hours
  older than the newest run that published that recording (`kernrec` is the
  CUDA table, `latest.json`): published recordings are not being picked up.
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

### Before and after ci-infra#881

After ci-infra#881 each collect job uploads `fnrec_collect_summary.json` or
`kernrec_collect_summary.json` with per-backend `expected_jobs`,
`delivered_jobs`, rows and `verdict`, and soft-fails when an armed backend is
not whole. Those summaries are read first. When the kernel collect
soft-fails, the failure is blamed on the backends whose own verdict is not
ok, so a CUDA failure does not mark a published ROCm table broken.

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
  collect steps (which can take until about 4.5 hours after the 06:00 and
  18:00 UTC starts). `alerting-selector-health-pr.timer` runs
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
  window, 5% and 5 builds over 24 h, 14-day history).

## What it posts to Slack

One message per episode, headed `🧭 CI SELECTOR`. It names the recording,
the full-run build with a Buildkite link, the verdict, delivered vs expected
jobs and usable rows, the last build that published it and how many hours
it trails, and links the `/selector` page. The resolve edits that message in
place into a ✅-prefixed, struck-through copy (a fresh post only when the
original is gone). Delivery IDs are deterministic per episode
(`selector:<condition>:<digest>:<opened epoch>:open|resolve`).

## Dashboard

`/selector` ("CI Selector", Health → Metrics) shows one row per scheduled
full run of the last 14 days with a cell per component (verdict on hover), a
freshness panel (published build, age, and the build PR decisions use), a
daily PR-decision table, and open and recent episodes. Backed by
`src/app/api/selector/route.ts`, read-only.

## Tables

Writes (migration `0036_selector_health.sql`):
`alerting_selector_full_runs` (one row per run; `settled` runs are not
fetched again), `alerting_selector_run_components` (per run and component:
status, job state, expected/delivered jobs, rows, verdict, published commit,
source), `alerting_selector_decisions` (per non-main build), and
`alerting_selector_alerts` (episodes; a partial unique index keeps at most
one open per `(condition, subject_key)`), plus `alerting_notification_outbox`
and `alerting_automation_executions`. Runs and decisions older than 30 days
are pruned in the scan transaction.
