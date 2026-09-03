# Alert Production

This context turns scheduled CI observations into durable alert history and notification intent. It exists so source-system or worker outages do not lose alert state.

## Language

**Scheduled Command**:
A reconciliation wake-up identified by command type and target time. It is not itself an alert.
_Avoid_: Job, event, tick record

**Automation Execution**:
The durable attempt history for one Scheduled Command identity.
_Avoid_: Worker run, task

**Full CI Run**:
A scheduled daily or nightly CI build eligible for chronological comparison.
_Avoid_: Build, pipeline run

**Full CI Job Outcome**:
The observed state of one job in a Full CI Run, identified across runs by job name.
_Avoid_: Failure condition, test result

**Full CI Comparison**:
The ordered relationship between one Full CI Run and its preceding scheduled Full CI Run.
_Avoid_: Diff, report

**Full CI Failure Condition**:
One job's classification in a Full CI Comparison: new, recurring, or fixed, with a cause and PR attribution. A fixed condition requires a positively observed pass; a fixing PR is recorded only when verified merged.
_Avoid_: Incident, resolution state

**Analyzer Checkpoint**:
An immutable, versioned S3 object holding the analyzer's memory after one completed analysis. Postgres references it by URI and checksum; unreferenced objects are crash debris.
_Avoid_: Backup, snapshot of the database

**Fast Failure Event**:
An observation that one required Fast CI job on the main branch entered an eligible failure state within 30 seconds. It has no resolution lifecycle.
_Avoid_: Incident, alert lifecycle

**Main CI Job Observation**:
A hard terminal command-job outcome on the main branch, keyed by configured
step identity plus rendered job name so matrix cells remain independent.
_Avoid_: Test failure, diagnosis

**Main CI Job Alert**:
One failure episode for a Main CI job. Repeated hard failures refresh the open
episode; only a positively observed pass of the same job in the same or a newer
build resolves it. Missing, soft-failed, canceled, or older late-finishing jobs
do not resolve an episode.
_Avoid_: Full CI Failure Condition, automated diagnosis

**Main CI Backstop Sweep**:
An hourly reconciliation of every active main build and every build finished
in the last 48 hours with no per-job observation window — opening episodes
the poller's window missed entirely — plus a re-check of every open Main CI
Job Alert against the build where it last failed, so a retry pass the
observation window moved past still resolves the episode within an hour. It
never advances the Scan Cursor.
_Avoid_: Re-poll, full rescan

**Scan Cursor**:
The latest durable Fast or Main CI scan target used to derive the next
overlapping observation window.
_Avoid_: Last event time, checkpoint

**Notification Intent**:
A durable request to deliver one rendered alert message to a destination.
_Avoid_: Slack message, notification attempt
