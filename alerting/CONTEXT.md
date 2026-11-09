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
One job's classification in a Full CI Comparison: new, recurring, or fixed, with a cause and PR attribution. A job is fixed when it was in the baseline and is neither a hard nor a soft failure this run, so the baseline cannot retain names that no longer exist; a fixing PR is recorded only when verified merged.
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
Torch-nightly builds are excluded: their failures cannot open or refresh an
episode, and their passes cannot resolve a standard Main CI failure.
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

**Expected Host Set**:
The union of Kubernetes node names from each GPU cluster, GPU-queue Buildkite
agent hostnames lowercased, and hostnames seen recently in gpu_snapshots. It
authoritatively defines which hosts must report telemetry.
_Avoid_: Inventory, fleet registry

**Infra Alert Episode**:
One breach episode for an infra subject (an unreporting host, a shared disk
group, or one GPU). It opens only after the breach sustains across the
configured consecutive scans and resolves on the first positive observation,
so every episode produces exactly two Notification Intents.
_Avoid_: Machine-down alarm, flapping page

**Retired Host**:
A host absent from every expected source and silent for seven days. It stops
alerting and keeps a queryable retirement timestamp for the dashboard.
_Avoid_: Deleted host, decommission record

**Selector Recording**:
One table ci-selector decides from — the Python function table (fnrec) or
the CUDA or ROCm kernel table (kernrec) — as one scheduled Full CI Run's
collect step folded and published it. It is whole when its collect verdict
is ok, it published, and it delivered at least 80% of the expected jobs. A
whole recording is degraded when under 70% of its rows are usable, or its
usable rows fall under 60% of the median of the previous 7 runs.
_Avoid_: Coverage, test map

**Kernel Source Map**:
The kernel symbol map an image build (`image-build` for CUDA,
`image-build-amd` for ROCm) produces for one run, mapping compiled objects
to `csrc/` sources; each kernel table pairs with its backend's map. It is
broken when it carries a `reason`, has no objects, or was built from another
commit than the run's.
_Avoid_: Symbol table

**Selector Decision**:
The record one PR build's bootstrap uploads of what the selector did
(applied, skipped, fell back) and which recording builds it used. A build
with no decision artifact has a missing decision.
_Avoid_: Selection, plan

**Selector Health Episode**:
One open-or-resolved breach of a selector-health condition for a recording,
recorder, or the selector itself. It opens on the first breaching
observation and resolves on the first healthy one, so it is one Slack
message edited in place.
_Avoid_: Coverage alert
