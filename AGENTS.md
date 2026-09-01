# vLLM Dashboard — Agent Guide

Next.js dashboard (Vercel) + Python alerting worker (`alerting/`) + SQL
migrations (`migrations/`). Tests: `npm test`, `npm run lint`,
`uv run --project alerting pytest alerting/tests`, `uv run --project migrations pytest migrations/tests`.

## Git

- Commits need DCO sign-off: `git commit -s`.
- Branch `agent/<slug>` off `origin/main`, PR to main. No fork workflow.

## Alerting worker (EC2)

Runs on a single EC2 instance via systemd timers (`deploy/aws/`):
`alerting-control` (1min, syncs delivery modes from S3), `alerting-fast-ci`
(15min), `alerting-main-ci` (5min), `alerting-full-ci` (05:00/19:00 PT),
`alerting-retention` (daily, prunes fast-failure events > 7d).

Key facts that bite:

- **Delivery modes** live in S3 as `control/fast_ci.mode` etc. —
  **underscores**, not hyphens. Values: `shadow` (records only, never posts)
  / `live` / `disabled`. Control service copies them to
  `/run/alerting/*.mode` (hyphenated) every minute.
- **Worker stdout/stderr are suppressed** by design (`StandardOutput=null`).
  Real errors are in Postgres: `alerting_automation_executions.last_error`.
- **Slack**: both paths post via `SLACK_BOT_TOKEN` to `SLACK_CHANNEL_ID`
  (secret keys; `alerting/fast_ci.py` has the default). Bot must be invited
  to the channel. Shadow rows never deliver, even after a flip to live.
- **Secrets** come from Secrets Manager (`vllm-alerting-worker`,
  `vllm-alerting-github-read`), fetched per service start by
  `deploy/aws/bin/load-secrets`.
- **Kimi analyzer**: `alerting/kimi.py`; env knobs `KIMI_API_KEY` (secret),
  `KIMI_MODEL`, `KIMI_REASONING_EFFORT`, `KIMI_TIMEOUT_SECONDS`. Analyzer
  instructions: `alerting/assets/vllm-ci-failure-analyzer.md`. Memory
  checkpoints in S3; lost-bucket self-heals (starts empty once).
- **Migrations must run before deploys** that read new columns:
  `DATABASE_URL=... uv run --project migrations vllm-dashboard-migrate`
  (plan), then `--apply --confirm-target <target>`.

## Runbooks

- `deploy/aws/disaster-recovery.md` — instance replacement / stack recreation.
- `alerting/README.md`, `alerting/CONTEXT.md` — worker architecture + domain
  vocabulary.

## Ops environment notes

- The host has no SSH ingress; use SSM Session Manager. The SSM console
  mangles long pasted lines (wraps with leading spaces) — deliver scripts as
  short `printf` lines or base64 chunks, never heredocs/long one-liners.
- On-host update: `git fetch --depth 1 origin main && git checkout -B main FETCH_HEAD`
  in `/opt/alerting/source`, then re-run `deploy/aws/install.sh` (3 args:
  bucket, worker secret ARN, GitHub secret ARN; the latter two are in
  `/etc/alerting/secret-arns`, bucket in `/etc/alerting/worker.env`).
- Legacy automation on `kevin-devbox` must stay fenced or alerts double-post.
