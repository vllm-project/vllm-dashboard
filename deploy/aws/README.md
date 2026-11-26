# AWS alerting worker

This stack provisions one disposable Amazon Linux 2023 EC2 worker, an encrypted
and versioned analyzer-checkpoint bucket, an egress-only security group, and an
instance role. Postgres and S3 remain authoritative; replacing the instance
does not require restoring its root volume.

## Secrets

Create both Secrets Manager secrets before deploying the stack. Secret values
must be JSON objects whose keys are environment-variable names.

- `WorkerSecretArn` supplies `DATABASE_URL`, `BUILDKITE_TOKEN`,
  `CLICKHOUSE_URL`, `CLICKHOUSE_READ_USER`, `CLICKHOUSE_READ_PASSWORD` (Fast
  CI's read-only ClickHouse Cloud access; use the port-443 HTTPS URL, since the
  security group allows no egress on 8443), and `SLACK_BOT_TOKEN`, plus
  `KIMI_API_KEY`, the Kimi credential used by the Full CI analyzer. The old
  `DATABRICKS_*` keys are no longer read and can be removed.
- `GitHubReadOnlySecretArn` supplies `GITHUB_TOKEN`. Use a fine-grained token
  limited to read-only metadata and contents for required repositories. The
  worker must have no repository write permission.

Pass the **full ARN**, including the six-character suffix, for both parameters:

```bash
aws secretsmanager describe-secret --secret-id vllm-alerting-github-read \
  --query ARN --output text
```

Secrets Manager accepts a partial ARN for lookups, but the template also uses
these values as exact IAM policy resources. A partial ARN there denies secret
access and prevents every worker from starting. The parameter validation rejects
the missing-suffix form; always use the ARN returned by `describe-secret`.

The role can read only these two named secrets and can list, read, and write
only the stack's checkpoint bucket. The instance has no SSH ingress and needs
no interactive credential setup; day-to-day access is through SSM Session
Manager / Run Command via the role's `AmazonSSMManagedInstanceCore` managed
policy. Each service fetches credentials through its instance role, writes
them briefly under `/run/alerting`, removes the file before starting Python,
and suppresses worker stdout and stderr so credentials, CI logs, model output,
and Slack payloads do not enter the journal.

The Full CI analyzer calls the Kimi API using `KIMI_API_KEY` from
`WorkerSecretArn`, with a bundled read-only analyzer definition and the stack
checkpoint bucket. It does not receive a GitHub write credential.

Two stack parameters tune the Kimi analyzers and are written to
`/etc/alerting/worker.env` by `install.sh`:

- `KimiReasoningEffort` (default `high`) sets `KIMI_REASONING_EFFORT`, the
  shared effort used by the Full CI analyzer.
- `KimiMainCIReasoningEffort` (default `high`) sets
  `KIMI_MAIN_CI_REASONING_EFFORT`, used only by the Main CI failure analyzer.
  It is intentionally independent — Main CI does not fall back to
  `KIMI_REASONING_EFFORT`. Each Main CI analysis has a ten-minute default
  budget (`KIMI_MAIN_CI_TIMEOUT_SECONDS`, 600s), including any model and curl
  calls made by the Kimi runner.

## Deploy

```bash
aws cloudformation deploy \
  --stack-name vllm-alerting-worker \
  --template-file deploy/aws/alerting-worker.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId=vpc-... \
    SubnetId=subnet-... \
    WorkerSecretArn=arn:aws:secretsmanager:...:secret:vllm-alerting-worker \
    GitHubReadOnlySecretArn=arn:aws:secretsmanager:...:secret:vllm-alerting-github-read
```

`RepositoryRef` defaults to `main`; set it to the reviewed deployment branch
when validating before merge.

**Gotcha:** a stack update that only changes UserData (including parameter
changes such as `KimiMainCIReasoningEffort`) makes CloudFormation stop/start
the instance **without** re-running provisioning — cloud-init runs UserData
only once per instance, so `/etc/alerting/worker.env` is not rewritten. Any
parameter or environment change requires a real instance replacement (see
[disaster-recovery.md](disaster-recovery.md)).

A merged code change does **not** need a stack update at all: pull the repo on
the worker and re-run `install.sh` over SSM Run Command — see
[disaster-recovery.md](disaster-recovery.md#in-place-code-updates-ssm).

## H200 quarantine pauser

`alerting-h200-pauser.timer` runs
`scripts/gpu-reporter/quarantine-pauser-h200.py` every minute. It pauses the
Buildkite agents of quarantined H200 hosts (see `alerting/docs/infra.md`).
`install.sh` installs it but doesn't enable it. Before enabling:

1. Add `GPU_REPORT_URL` and `GPU_REPORT_SECRET` (the reporters' dashboard
   endpoint and bearer secret) to the worker secret. It already has
   `BUILDKITE_WRITE_TOKEN`, which needs `read_agents` and `write_agents` and
   must belong to an org admin.
2. Install `quarantine-check-host.service` and `.timer` on every H200 host
   (from `scripts/gpu-reporter`, next to gpu-reporter, which provides
   `/etc/gpu-reporter.env`).
3. `sudo systemctl enable --now alerting-h200-pauser.timer`. The unit passes
   `--dry-run`, so it only logs what it would pause. Its output goes to the
   journal (`journalctl -u alerting-h200-pauser`): hosts, agent names and
   posts, never a token. A failed run DMs the worker-failure destination.
4. To go live, drop `--dry-run` from the unit (and from the host check's).

## Off-worker heartbeat

`control`, `fast-ci`, `main-ci`, `infra` and `h200-pauser` each chain
`alerting-heartbeat@<job>.service` from their `OnSuccess=`, which runs
`bin/emit-heartbeat` as its own oneshot unit (so it never shares the job
unit's start timeout) and puts a `VllmAlerting/Heartbeat` datapoint
(dimension `Job`) using the instance role only, never the worker secret. The
stack's CloudWatch alarms count a missing period as zero (`FILL(m1, 0)`, so
an old heartbeat cannot hold an alarm at OK) and notify the stack's SNS
topic (`<stack-name>-heartbeat`), so a dead timer, a dead instance, or a
secret the worker cannot load all alarm without the worker, its database or
its secret. Set `HeartbeatAlertEmail` and click SNS's confirmation link
once; empty means no subscriber. A job whose timer is intentionally stopped
or disabled (a path turned off in S3 control; the pauser's timer is enabled
by hand, not by S3 control) will alarm once — one ALARM email, and an OK
email when the job resumes; that is the alarm working, so don't mute its
actions (a muted alarm left in ALARM notifies nobody when the job comes
back broken). `control` doesn't load the worker secret, so its alarm covers
a dead instance or timers, not the secret. Windows (15/50/25/35/20 min for
control/fast-ci/main-ci/infra/h200-pauser) outlast one timed-out run plus
one successful run at the durations we observe, with one full bucket of
margin in case FILL counts the in-progress bucket as a zero. A unit timeout
pages once through `OnFailure`; the heartbeat alarm must not add a second
page for the same run. (App-level timeout errors on main-ci, infra and
h200-pauser are also held ten minutes by bin/hold-failure before they page.)
The metric has only the `Job` dimension:
one worker per account and region, or a second emitter would hold the
alarms at OK.

Deploy the code before the stack change: until the stack grants
`PutMetricData` the emit fails (journaled, and the `alerting-heartbeat@*`
units sit failed, so `systemctl is-system-running` reads degraded — expected
and brief), and the code is already in place when the alarms are born.
Whether each alarm fires ALARM on missing data at deploy or goes straight to
OK depends on whether a heartbeat lands before its first evaluation; either
is fine, and each alarm also mails on recovery, so an "OK" email from a new
alarm is the subscription working, not a recovered incident. A dead worker
pages all five alarms (15/20/25/35/50 min in, plus evaluation lag) and mails
OK again on recovery.
The delivery test is `aws cloudwatch set-alarm-state --state-value ALARM`;
the physical alarm names carry the stack name, so read them from the stack
(`aws cloudformation describe-stack-resource --stack-name <stack> --logical-resource-id HeartbeatInfraAlarm`).
Don't test by stopping a timer: unless a path is `disabled`, the control
service re-enables the path timers within a minute (not h200-pauser, whose
timer is enabled by hand).

## Shadow, cutover, and rollback

All three paths start in shadow mode. Durable controls live at
`s3://CHECKPOINT_BUCKET/control/fast_ci.mode` and
`s3://CHECKPOINT_BUCKET/control/full_ci.mode`, plus
`s3://CHECKPOINT_BUCKET/control/main_ci.mode`; allowed values are `shadow`,
`live`, and `disabled`. A root oneshot reconciles those objects every minute,
but workers run as the non-login `alerting` user. Shadow runs persist source
observations and rendered Slack payloads without leasing them for delivery.
Main CI writes dashboard lifecycle and renders Slack payloads only for image
builds red on two main builds in a row (see `alerting/docs/main-ci.md`); its
mode controls those posts and the independent two-minute timer.

CI selector health (`alerting/docs/selector-health.md`) has its own control,
`s3://CHECKPOINT_BUCKET/control/selector.mode`, applied to
`alerting-selector-health.timer` and `alerting-selector-health-pr.timer`.
After `install.sh` ships the units, the control reconciler creates the
missing object as `shadow` and enables both timers; write `live` to post.

Run the repeatable operator wizard from the repository root:

```bash
export DATABASE_URL='postgresql://...'
deploy/aws/cutover-wizard.sh
```

Cutover is path-specific. Fast CI fences only
`vllm-fast-ci-failure-alert.timer`; Full CI requires disabling only its task in
the shared legacy scheduler. Rollback disables the selected new timer through
S3, archives any undelivered live rows as shadow output, restores only the
selected old producer, and never rewinds Postgres or S3 state. A path left
`disabled` stops emitting heartbeats, so its heartbeat alarm fires once and
recovers with an OK email when the path resumes — expected, not a fault.

## Recovery check

Stop all alert timers before a scheduled tick, wait through the tick, then
start the timers again. The heartbeat alarms fire only if the timers stay
stopped past their windows (15-50 min); unless a path is `disabled`, the
control service re-enables the path timers within a minute (not h200-pauser,
whose timer is enabled by hand), so a one-tick pause sends nothing. Use
`set-alarm-state` for a delivery test. `Persistent=true` and `OnBootSec`
start reconciliation,
while the Postgres cursors and processed-run history recover missed Fast, Full,
or Main CI observations. Each path has a separate timer and service — Main CI
has three: one for lifecycle reconciliation, one for AI analysis, and one
hourly backstop sweep that reconciles all builds finished in the last 48
hours plus active builds (catching failures the poller's window missed) and
re-checks open alerts against their failure builds —
so a long Full CI execution cannot occupy either frequent poller.

For instance replacement and stack recreation, see
[disaster-recovery.md](disaster-recovery.md).
