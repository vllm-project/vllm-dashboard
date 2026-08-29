# Disaster recovery

The alerting worker is disposable. All durable state lives in Postgres (runs,
comparisons, analyses, scan cursors, outbox, execution records) and the S3
checkpoint bucket (analyzer memory, delivery modes), both outside the instance.

## Instance replacement (crash, termination, rebuild)

Redeploy the stack with the same parameters; CloudFormation recreates the
instance and UserData reprovisions it from scratch:

```bash
aws cloudformation deploy \
  --stack-name <stack-name> \
  --template-file deploy/aws/alerting-worker.yaml \
  --parameter-overrides VpcId=... SubnetId=... WorkerSecretArn=... GitHubReadOnlySecretArn=... \
  --capabilities CAPABILITY_IAM
```

The bucket, role, and secrets are reused (`DeletionPolicy: Retain`). After
boot:

- control service re-syncs delivery modes from S3 within one minute;
- timers are `Persistent=true`, so missed runs fire immediately;
- scans resume from their Postgres cursors; pending Slack notifications
  dispatch from the outbox; a command that was in flight replays
  idempotently once its 30-minute lease expires.

Nothing else to do. Expected recovery time: ~10 minutes.

## Stack recreation (delete + create)

A new stack creates a **new** checkpoint bucket (auto-generated name). The old
bucket is retained but the new instance role cannot read it. Effects:

- **Delivery modes** reset to `shadow` — deliberate, so a fresh deployment
  never posts to Slack unprompted. Re-apply after verifying:

  ```bash
  printf 'live\n' | aws s3 cp - "s3://<new-bucket>/control/fast_ci.mode" --only-show-errors
  printf 'live\n' | aws s3 cp - "s3://<new-bucket>/control/full_ci.mode" --only-show-errors
  ```

- **Analyzer memory** heals itself: stored checkpoint URIs point at the old
  bucket, the analyzer detects the unreadable reference, starts from empty
  memory once, and its first completed analysis uploads the new bucket's
  initial checkpoint. No database edits needed. The first report may classify
  ongoing failures as new for one comparison.

## Verifying health after recovery

```bash
systemctl list-timers 'alerting-*' --no-pager
```

All timers (control, fast-ci, full-ci, retention, main-ci) should be active
with future trigger times. Execution status is in Postgres:

```sql
SELECT command_type, status, last_error, updated_at
FROM alerting_automation_executions
ORDER BY updated_at DESC LIMIT 10;
```
