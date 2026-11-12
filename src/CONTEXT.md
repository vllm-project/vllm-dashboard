# CI Dashboard

This context presents CI operational state and alert history for maintainers
and public readers, and owns the queue-wait alert lifecycle. Fast, Full, and
Main CI alert qualification belongs to Alert Production.

## Language

**Alert History**:
The read-only sequence of durable records produced by Alert Production.
_Avoid_: Notification history, Slack history

**Main CI Job Alert View**:
The read-only open and recently resolved failure episodes for exact
main-branch jobs. It presents Buildkite evidence but no automated diagnosis.
_Avoid_: Incident analysis, Slack ledger

**CI Health View**:
A dashboard presentation of build, job, queue, test, and alert state.
_Avoid_: Alert producer, monitoring worker

**Selector Health View**:
The read-only CI Selector page over Alert Production's selector-health
records: each scheduled Full CI Run's five components (Python function
table, CUDA and ROCm kernel tables, CUDA and ROCm kernel source maps) with
their counts, the recordings' freshness, and PR selector decisions by day
with the kernel backends they used.
_Avoid_: Coverage dashboard

**Queue Wait Alert**:
An active or resolved warning that a CI queue's observed wait is excessive. It belongs to CI Dashboard rather than Alert Production.
_Avoid_: Fast CI alert, Full CI alert

**Triage Queue**:
The maintainers-only view of in-scope vLLM issues and PRs produced by Triage
Production: each item's current score and band, its latest extracted facets,
and its open assignments. Readable only with a signed-in maintainer session.
_Avoid_: Issue tracker, inbox

**Assignment**:
One routing of one triage item to one maintainer as primary or backup, with
a status (`open`, `acked`, `done`, or closed as `not_mine`, `reassigned`,
`dropped`, `slop`). The router creates them; maintainers move them.
_Avoid_: Ticket, claim

**Triage Action**:
An append-only record of what a maintainer did to an item (ack, not mine,
reassign, drop, slop, done, reopen), written in the same transaction as the
assignment change it causes. It is the feedback the router and scorer are
tuned against.
_Avoid_: Event, vote
