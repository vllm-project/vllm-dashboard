# Infra health alerts

## What it detects

Three fleet-health signals, reconciled by one five-minute scan
(`infra_scan`):

- **Unreporting** — an expected host whose latest successful report
  (newest `gpu_history_5m` / `host_history_5m` rollup row; reporters write
  raw snapshots and rollups in one transaction) is older than the threshold
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
- Slack: `SLACK_BOT_TOKEN`; `SLACK_CI_ALERT_CHANNEL` overrides the shared
  alert channel (`C0ANHBE642Y`).
- Control plane: S3 `control/infra.mode` (`shadow` default / `live` /
  `disabled`) applied to `alerting-infra.timer`.

## What it posts to Slack

One message per episode: the bot posts the open alert with subject and
evidence (last report time, breaching mounts with per-host percentages, or
GPU temperature), and the resolve edits that same message in place into a
✅-prefixed, struck-through copy (a fresh post only when the original is
gone). Delivery IDs are deterministic per episode
and transition (`infra:<type>:<digest>:<opened epoch>:open|resolve`), so
retries never duplicate.

## Dashboard history

`/alerts?tab=infra` ("Infra") lists open and resolved episodes plus retired
hosts. Alerts resolve themselves; the only thing resolved by hand is a
quarantine (below), once the operator token is entered. Backed by
`src/app/api/alerts/infra/route.ts`.

## Quarantine

The same scan also decides when to take a host out of CI. A quarantine is
one more episode type (`quarantine`, keyed by host) in
`alerting_infra_alerts`; its stage and evidence live in `details`.
`QUARANTINE_MODE` defaults to `dry_run`: decisions open `would` episodes
and nothing changes on a host.

**Triggers** (`plan_trigger_rules`), over the pilot pools (`pilot_pools`):

- GPU hardware, on first sight: a driver recovery action other than `None`,
  a row-remap failure, or a first-sight hardware Xid. Reset-class Xids trip
  on 3 of one Xid on one GPU in 24 h, or on 1 within 24 h of the host's
  last resolve (`xid_probation`).
- Host faults, on 2 consecutive scans that each read a fresh (≤ 60 s),
  unused reading: GPU hang, all network probes failing while most of the
  pool passes, disk and dead-process GPU memory at the alert thresholds,
  and on H200 only root-owned checkout slots and a short GPU count.
- Job failures (`job_failure_trigger.py`), at most every 15 minutes. These
  stay dry run (`would` only) even when quarantine is live; the trigger
  goes live only after its own review.

**Limits** (`_quarantine_limits`): a quarter of a pool out at once (at
least one), except that a hardware fault skips this cap. The last serving
host is held unless the fault is hardware, which goes ahead and pages.
More than 3 quarantines commanded within an hour (resolved ones included,
from a record in subject state `limits:commands`) trips the fleet breaker,
which holds hardware faults too. A breaker hold sticks while its decision
stands, so a person needs to look. A blocked decision opens as `held`.

**Paging:** a live hardware fault on the last serving host, a repeat
offender, and a tripped breaker also go to
`ALERTING_FAILURE_SLACK_DESTINATION`, the same DM as a worker failure.

**Stages:**

```
would (dry run)        held ─┐
                             ▼
quarantining ──drained──▶ quarantined ──resolve──▶ resolve_requested
                              ▲                         │ fresh reading, no fault
                              │ fault still read,       ▼
                              │ or return check fails  resolving ──returned──▶ resolved
                              └─────────────────────────┘
```

- The actuators pull their cluster's desired set
  (`/api/alerts/quarantine/desired`) every minute and report what they did
  (`/api/alerts/quarantine/<host>/applied`): `out`, `drained`, `verifying`,
  `verify_failed`, `returned`. The worker moves the stage on those reports.
- **Resolve** (`POST /api/alerts/quarantine/<host>/resolve {by, reason,
  force?}`, operator token, or the Resolve button) moves the episode to
  `resolve_requested`. The host stays out until a full reading taken after
  the request: a row for every GPU the host has had, a host reading whose
  GPU query answered, and a new measurement of the fault it was quarantined
  for (its network probes, disk, slots, dead-process memory or GPU count).
  If a reading-based trigger fires on a reading after the request (one failing
  reading is enough, no two-scan streak), it goes back to `quarantined` and
  the post says what it still reports; otherwise it moves to `resolving`.
  Faults read before the request, and Xids up to it, are what the resolve
  covers. Job-failure decisions don't block it, since an idle host can't
  clear them. `force: true` (the "Skip the clean-reading check" box) goes
  straight to `resolving`, and so does a `held` episode: its host never went
  out, and waiting would take it out past the limit that held it. A resolve
  already waiting can be forced too ("Skip the wait"), for a dead reporter.
- **Return check** (Kubernetes actuator, `resolving`): once no CI pod is
  left on the node, a one-off pod there holding all its GPUs checks
  nvidia-smi and runs `dcgmi diag -r 2`. It runs in the
  `vllm-quarantine-verify` namespace, where an admission policy allows only
  pods shaped like it, on GPU nodes. A GPU the device plugin dropped, a
  failure, or no finish in 30 min reports `verify_failed` and the episode
  goes back to `quarantined`. A failed check pod stays until the dashboard
  has the failure, so a lost post can't start a fresh check.
  `QUARANTINE_VERIFY_LEVEL=0` skips it. The H200 bare-metal actuator is not
  built yet; it needs the same check on the host.
- A host quarantined again within 7 days of a resolve still goes out, and
  its post says the fix may not have held and pages a person.
- An actuator that hasn't confirmed 10 minutes after a command, a return
  check or CI wait that stopped reporting for 10 minutes, or a resolve with
  no fresh reading for 10 minutes, posts once per stage.
- A resolve still waiting for CI jobs on the host an hour after it was
  resolved posts once, naming the jobs (the actuator reports them each run
  as `out` with a note), so a hung job doesn't hold a host out unexplained.

Posts never say how to resolve. Delivery ids add the scan time for the
posts that can repeat in one episode (a failed return, a stuck actuator).

## Tables

Reads: `gpu_history_5m`, `host_history_5m` (latest-report times),
`gpu_snapshots` (recent hosts, GPU temperatures), `host_snapshots` (disk
mounts), `alert_thresholds`.
Writes: `alerting_infra_host_states` (per-subject consecutive-breach counts
and retirement), `alerting_infra_alerts` (episodes; partial unique index
keeps at most one open episode per `(alert_type, subject_key)`),
`alerting_notification_outbox`, `alerting_automation_executions`.
