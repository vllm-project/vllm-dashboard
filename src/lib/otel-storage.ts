import type postgres from "postgres";
import { getDb } from "@/lib/db";
import type {
  NormalizedOtlpSpan,
  OtlpAttributeValue,
} from "@/lib/otel-proto";

const INSERT_BATCH_SIZE = 200;

function jsonValue(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

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

  const db = getDb();
  const rows = spans.map((span) => {
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
      resource_attributes: db.json(jsonValue(span.resourceAttributes)),
      span_attributes: db.json(jsonValue(span.spanAttributes)),
      span_events: db.json(jsonValue(span.events)),
      span_links: db.json(jsonValue(span.links)),
      dropped_attributes_count: span.droppedAttributesCount,
      dropped_events_count: span.droppedEventsCount,
      dropped_links_count: span.droppedLinksCount,
    };
  });

  await db.begin(async (transaction) => {
    const tx = transaction as unknown as typeof db;
    for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
      await tx`
        INSERT INTO otel_spans ${tx(
          batch,
          "trace_id",
          "span_id",
          "parent_span_id",
          "trace_state",
          "trace_flags",
          "span_name",
          "span_kind",
          "start_time",
          "end_time",
          "duration_ms",
          "status_code",
          "status_message",
          "service_name",
          "scope_name",
          "scope_version",
          "resource_schema_url",
          "scope_schema_url",
          "organization_slug",
          "pipeline_slug",
          "build_id",
          "build_number",
          "build_state",
          "step_id",
          "step_key",
          "job_id",
          "job_label",
          "job_state",
          "job_type",
          "job_passed",
          "job_soft_failed",
          "job_exit_status",
          "job_wait_time_ms",
          "agent_id",
          "agent_name",
          "agent_queue",
          "resource_attributes",
          "span_attributes",
          "span_events",
          "span_links",
          "dropped_attributes_count",
          "dropped_events_count",
          "dropped_links_count",
        )}
        ON CONFLICT (trace_id, span_id) DO UPDATE SET
          parent_span_id = EXCLUDED.parent_span_id,
          trace_state = EXCLUDED.trace_state,
          trace_flags = EXCLUDED.trace_flags,
          span_name = EXCLUDED.span_name,
          span_kind = EXCLUDED.span_kind,
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          duration_ms = EXCLUDED.duration_ms,
          status_code = EXCLUDED.status_code,
          status_message = EXCLUDED.status_message,
          service_name = EXCLUDED.service_name,
          scope_name = EXCLUDED.scope_name,
          scope_version = EXCLUDED.scope_version,
          resource_schema_url = EXCLUDED.resource_schema_url,
          scope_schema_url = EXCLUDED.scope_schema_url,
          organization_slug = EXCLUDED.organization_slug,
          pipeline_slug = EXCLUDED.pipeline_slug,
          build_id = EXCLUDED.build_id,
          build_number = EXCLUDED.build_number,
          build_state = EXCLUDED.build_state,
          step_id = EXCLUDED.step_id,
          step_key = EXCLUDED.step_key,
          job_id = EXCLUDED.job_id,
          job_label = EXCLUDED.job_label,
          job_state = EXCLUDED.job_state,
          job_type = EXCLUDED.job_type,
          job_passed = EXCLUDED.job_passed,
          job_soft_failed = EXCLUDED.job_soft_failed,
          job_exit_status = EXCLUDED.job_exit_status,
          job_wait_time_ms = EXCLUDED.job_wait_time_ms,
          agent_id = EXCLUDED.agent_id,
          agent_name = EXCLUDED.agent_name,
          agent_queue = EXCLUDED.agent_queue,
          resource_attributes = EXCLUDED.resource_attributes,
          span_attributes = EXCLUDED.span_attributes,
          span_events = EXCLUDED.span_events,
          span_links = EXCLUDED.span_links,
          dropped_attributes_count = EXCLUDED.dropped_attributes_count,
          dropped_events_count = EXCLUDED.dropped_events_count,
          dropped_links_count = EXCLUDED.dropped_links_count,
          received_at = NOW()
      `;
    }
  });

  return { accepted: spans.length };
}
