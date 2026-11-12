# Context Map

## Contexts

- [Alert Production](./alerting/CONTEXT.md): reconciles CI source observations into durable alert history and notification intent.
- [CI Dashboard](./src/CONTEXT.md): presents CI operational state and alert history, and owns queue-wait alerts.
- [Triage Production](./triage/README.md): ingests vLLM issues and PRs, extracts facets with an LLM, scores and routes them to maintainers.

## Relationships

- **Alert Production to CI Dashboard**: Alert Production defines and writes
  Fast CI observations, Full CI comparisons, Main CI Job Alert episodes,
  infra episodes, and CI selector recording health (runs, decisions, and
  Selector Health Episodes).
  CI Dashboard reads those records, independently owns Queue Wait Alerts, and
  does not mutate schema during requests. Main CI diagnosis remains a curated
  Slack concern rather than dashboard state.
- **Triage Production to CI Dashboard**: Triage Production (`triage/`, the
  worker and the extractor host) writes triage items, extractions, scores,
  assignments it routes, and poll cursors. CI Dashboard reads those for the
  maintainers-only Triage pages and writes only Triage Actions, the
  assignment status changes they cause (including manual reassignments),
  and each signed-in maintainer's own `triage_maintainers` row. It never
  rescores or reroutes; the router acts on the actions it finds.
