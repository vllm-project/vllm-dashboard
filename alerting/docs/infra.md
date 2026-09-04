# Infra health alerts

## What it detects

Three fleet-health signals, reconciled by one five-minute scan
(`infra_scan`):

- **Unreporting** — an expected host whose latest successful report
  (any `gpu_snapshots` / `host_snapshots` row) is older than the threshold
  for `consecutive_scans` consecutive scans. The wording always says the
  host "stopped reporting"; the alert never claims a machine is down. A
  host absent from every expected source and silent for 7 days is
  auto-retired (`retired_at` set): it stops alerting, its open episode
  resolves, and the dashboard can still show it.
- **Disk usage** — any reported mount with role `workspace`, `images`,
  `data`, or `system` at ≥ the threshold percent. Episodes are keyed by the
  shared `(fstype, device)` group, not hostname, so an NFS volume mounted
  by N hosts pages once and resolves only when every mount in the group
  drops below the threshold. Mounts with role `other` or a per-mount error
  never alert.
- **GPU temperature** — any GPU at ≥ the threshold in °C, keyed per
  hostname and GPU index.

RAM, load, and network are display-only and never alert. Every episode
opens only after the breach sustains across `consecutive_scans` and
resolves on the first healthy observation. One Slack message per episode:
the resolve edits the bot's own open alert in place (chat.update) into a
✅-prefixed copy with each line struck through (Slack adds its own
`(edited)` marker); if the original message is gone it posts fresh.

## Where the code lives

- `alerting/infra.py` — the slice: records, the pure `plan_infra_scan`
  planner, renderers, `InfraScanHandler`, and the production sources
  (`KubectlNodesSource`, `UnionExpectedHostSource`).
- Ports/adapters: `InfraSnapshotPort` + `InfraStore` implemented by
  `alerting/postgres.py` (`PostgresAlertStore`), with in-memory doubles in
  `alerting/memory.py`.
- Deployment: `deploy/aws/systemd/alerting-infra.timer` runs
  `run-worker infra` every 5 minutes (UTC) on the EC2 worker.

## Configuration

- `alert_thresholds` Postgres table (fleet-wide, operator-tunable;
  `enabled = false` suppresses that alert type). Seeded defaults:
  `unreporting` 10 minutes / 2 scans, `disk_usage` 90% / 2 scans,
  `gpu_temperature` 85°C / 2 scans.
- The expected-host set is the union of: Kubernetes node names from both
  clusters (`GPU_REPORTER_KUBECONFIG_H100`, `GPU_REPORTER_KUBECONFIG_DGX` —
  **optional**; unset means the kubectl source is skipped, set-but-failing
  fails the scan closed) and hostnames seen in `gpu_snapshots` within the
  last 7 days. All hostnames are lowercased. The Buildkite `gpu`-queue
  agents roster was dropped: the fleet's queue is ephemeral pods and
  autoscaled CI instances that never run reporters, so it only produced
  never-reported noise. Note: the stock alerting worker's security group
  allows egress only on 443/5432/6543, so cluster API servers (6443) are
  unreachable from it and the kubectl sources are normally skipped —
  coverage is preserved because the control-plane scrapers report every
  cluster node (a dead scraper silences, and therefore alerts, its whole
  cluster).
- Slack: `SLACK_BOT_TOKEN`; channel `SLACK_CI_INFRA_ALERT_CHANNEL` (falls
  back to the shared alerts channel `C0ABTNM9L5U` until the secret exists).
- Control plane: S3 `control/infra.mode` (`shadow` default / `live` /
  `disabled`) applied to `alerting-infra.timer`.

## What it posts to Slack

One message when an episode opens and one when it resolves (including the
auto-retire resolution). Opens name the subject and evidence (last report
time, breaching mounts with per-host percentages, or GPU temperature);
resolves confirm the recovery. Delivery IDs are deterministic per episode
and transition (`infra:<type>:<digest>:<opened epoch>:open|resolve`), so
retries never duplicate.

## Dashboard history

`/alerts?tab=infra` ("Infra") lists open and resolved episodes plus retired
hosts; the view is read-only — there is nothing to resolve by hand. Backed
by `src/app/api/alerts/infra/route.ts`.

## Tables

Reads: `gpu_snapshots`, `host_snapshots`, `alert_thresholds`.
Writes: `alerting_infra_host_states` (per-subject consecutive-breach counts
and retirement), `alerting_infra_alerts` (episodes; partial unique index
keeps at most one open episode per `(alert_type, subject_key)`),
`alerting_notification_outbox`, `alerting_automation_executions`.
