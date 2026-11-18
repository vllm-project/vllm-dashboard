import { insertClickHouse, writeConfig } from "@/lib/clickhouse";
import type {
  NormalizedOtlpSpan,
  OtlpAttributeValue,
} from "@/lib/otel-proto";

function mergedAttributes(span: NormalizedOtlpSpan) {
  return { ...span.resourceAttributes, ...span.spanAttributes };
}

function stringAttribute(
  attributes: Record<string, OtlpAttributeValue>,
  key: string,
): string | null {
  const value = attributes[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function numberAttribute(
  attributes: Record<string, OtlpAttributeValue>,
  key: string,
): number | null {
  const value = attributes[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function floatAttribute(
  attributes: Record<string, OtlpAttributeValue>,
  key: string,
): number | null {
  const value = attributes[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function storeOtlpSpans(spans: NormalizedOtlpSpan[]) {
  if (spans.length === 0) return { accepted: 0 };

  const plainRows = spans.map(spanRow);
  if (!writeConfig()) {
    throw new Error("ClickHouse write configuration is missing; spans have nowhere to go");
  }

  // ClickHouse is the span store. Its failure fails the request so the OTLP
  // exporter retries (503); the insert is idempotent on retry because
  // ci.otel_spans keeps one row per (trace_id, span_id).
  await insertClickHouse("ci.otel_spans", plainRows.map(clickHouseRow), { asyncInsert: true });
  return { accepted: spans.length };
}

type SpanRow = ReturnType<typeof spanRow>;

function clickHouseRow(row: SpanRow) {
  return {
    ...row,
    start_time: row.start_time.toISOString(),
    end_time: row.end_time.toISOString(),
    resource_attributes: JSON.stringify(row.resource_attributes ?? {}),
    span_attributes: JSON.stringify(row.span_attributes ?? {}),
    span_events: JSON.stringify(row.span_events ?? []),
    span_links: JSON.stringify(row.span_links ?? []),
  };
}

function spanRow(span: NormalizedOtlpSpan) {
  const attributes = mergedAttributes(span);
  return {
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    trace_state: span.traceState,
    trace_flags: span.flags,
    span_name: span.name,
    span_kind: span.kind,
    start_time: span.startTime,
    end_time: span.endTime,
    duration_ms: span.durationMs,
    status_code: span.statusCode,
    status_message: span.statusMessage,
    service_name: stringAttribute(attributes, "service.name"),
    scope_name: span.scopeName,
    scope_version: span.scopeVersion,
    resource_schema_url: span.resourceSchemaUrl,
    scope_schema_url: span.scopeSchemaUrl,
    organization_slug: stringAttribute(
      attributes,
      "buildkite.organization.slug",
    ),
    pipeline_slug: stringAttribute(attributes, "buildkite.pipeline.slug"),
    build_id: stringAttribute(attributes, "buildkite.build.id"),
    build_number: numberAttribute(attributes, "buildkite.build.number"),
    build_state: stringAttribute(attributes, "buildkite.build.state"),
    step_id: stringAttribute(attributes, "buildkite.step.id"),
    step_key: stringAttribute(attributes, "buildkite.step.key"),
    job_id: stringAttribute(attributes, "buildkite.job.id"),
    job_label: stringAttribute(attributes, "buildkite.job.label"),
    job_state: stringAttribute(attributes, "buildkite.job.state"),
    job_type: stringAttribute(attributes, "buildkite.job.type"),
    job_passed: stringAttribute(attributes, "buildkite.job.passed"),
    job_soft_failed: stringAttribute(attributes, "buildkite.job.soft_failed"),
    job_exit_status: numberAttribute(
      attributes,
      "buildkite.job.exit_status",
    ),
    job_wait_time_ms: floatAttribute(
      attributes,
      "buildkite.job.wait_time_ms",
    ),
    agent_id: stringAttribute(attributes, "buildkite.agent.id"),
    agent_name: stringAttribute(attributes, "buildkite.agent.name"),
    agent_queue:
      stringAttribute(attributes, "buildkite.agent.queue") ??
      stringAttribute(attributes, "buildkite.queue"),
    resource_attributes: span.resourceAttributes as unknown,
    span_attributes: span.spanAttributes as unknown,
    span_events: span.events as unknown,
    span_links: span.links as unknown,
    dropped_attributes_count: span.droppedAttributesCount,
    dropped_events_count: span.droppedEventsCount,
    dropped_links_count: span.droppedLinksCount,
  };
}
