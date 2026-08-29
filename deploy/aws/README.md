# AWS alerting worker

This stack provisions one disposable Amazon Linux 2023 EC2 worker, an encrypted
and versioned analyzer-checkpoint bucket, an egress-only security group, and an
instance role. Postgres and S3 remain authoritative; replacing the instance
does not require restoring its root volume.

## Secrets

Create both Secrets Manager secrets before deploying the stack. Secret values
must be JSON objects whose keys are environment-variable names.

- `WorkerSecretArn` supplies `DATABASE_URL`, `BUILDKITE_TOKEN`,
  `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID`, and
  `SLACK_BOT_TOKEN`, plus `KIMI_API_KEY`, the Kimi credential used by the
  Full CI analyzer.
- `GitHubReadOnlySecretArn` supplies `GITHUB_TOKEN`. Use a fine-grained token
  limited to read-only metadata and contents for required repositories. The
  worker must have no repository write permission.

The role can read only these two named secrets and can list, read, and write
only the stack's checkpoint bucket. The instance has no SSH ingress and needs
no interactive credential setup. Each service fetches credentials through its
instance role, writes them briefly under `/run/alerting`, removes the file
before starting Python, and suppresses worker stdout and stderr so credentials,
CI logs, model output, and Slack payloads do not enter the journal.

The Full CI analyzer calls the Kimi API using `KIMI_API_KEY` from
`WorkerSecretArn`, with a bundled read-only analyzer definition and the stack
checkpoint bucket. It does not receive a GitHub write credential.

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

## Shadow, cutover, and rollback

All three paths start in shadow mode. Durable controls live at
`s3://CHECKPOINT_BUCKET/control/fast_ci.mode` and
`s3://CHECKPOINT_BUCKET/control/full_ci.mode`, plus
`s3://CHECKPOINT_BUCKET/control/main_ci.mode`; allowed values are `shadow`,
`live`, and `disabled`. A root oneshot reconciles those objects every minute,
but workers run as the non-login `alerting` user. Shadow runs persist source
observations and rendered Slack payloads without leasing them for delivery.
Main CI currently writes dashboard lifecycle only and renders no Slack payload;
its mode still controls the independent five-minute timer.

Run the repeatable operator wizard from the repository root:

```bash
export DATABASE_URL='postgresql://...'
deploy/aws/cutover-wizard.sh
```

Cutover is path-specific. Fast CI fences only
`vllm-fast-ci-failure-alert.timer`; Full CI requires disabling only its task in
the shared legacy scheduler. Rollback disables the selected new timer through
S3, archives any undelivered live rows as shadow output, restores only the
selected old producer, and never rewinds Postgres or S3 state.

## Recovery check

Stop all three timers before a scheduled tick, wait through the tick, then
start the timers again. `Persistent=true` and `OnBootSec` start reconciliation,
while the Postgres cursors and processed-run history recover missed Fast, Full,
or Main CI observations. Each path has a separate timer and service, so a long
Full CI execution cannot occupy either frequent poller.

For instance replacement and stack recreation, see
[disaster-recovery.md](disaster-recovery.md).
