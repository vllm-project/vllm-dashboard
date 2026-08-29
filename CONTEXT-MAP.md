# Context Map

## Contexts

- [Alert Production](./alerting/CONTEXT.md): reconciles CI source observations into durable alert history and notification intent.
- [CI Dashboard](./src/CONTEXT.md): presents CI operational state and alert history, and owns queue-wait alerts.

## Relationships

- **Alert Production to CI Dashboard**: Alert Production defines and writes
  Fast CI observations, Full CI comparisons, and Main CI Job Alert episodes.
  CI Dashboard reads those records, independently owns Queue Wait Alerts, and
  does not mutate schema during requests. Main CI diagnosis remains a curated
  Slack concern rather than dashboard state.
