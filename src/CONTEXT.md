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

**Queue Wait Alert**:
An active or resolved warning that a CI queue's observed wait is excessive. It belongs to CI Dashboard rather than Alert Production.
_Avoid_: Fast CI alert, Full CI alert
