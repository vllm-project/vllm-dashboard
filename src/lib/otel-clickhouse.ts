// Shared helpers for reading OTel spans from ClickHouse's ci.otel_spans.
//
// Span attributes are stored as JSON text. Postgres's `->>` returned the text
// of any JSON scalar (a string's contents, or a number/boolean's literal) and
// NULL when the key was absent or JSON null; attrText() reproduces that.

const SAFE_KEY = /^[A-Za-z0-9_.-]+$/;

/** SQL for `column->>'key'` with Postgres semantics, '' mapped to NULL. */
export function attrText(key: string, column = "span_attributes"): string {
  if (!SAFE_KEY.test(key)) throw new Error(`Invalid attribute key: ${key}`);
  return `nullIf(multiIf(
    JSONType(${column}, '${key}') = 'String', JSONExtractString(${column}, '${key}'),
    JSONType(${column}, '${key}') IN ('Null', 'Object', 'Array'), '',
    JSONExtractRaw(${column}, '${key}')), '')`;
}

/**
 * Keeps one row per span: the newest version by received_at. Wrap a filtered
 * SELECT with it; FINAL would scan the whole sort-key range instead.
 */
export const DEDUPE_SPANS = "ORDER BY received_at DESC LIMIT 1 BY trace_id, span_id";

/** Parses a ClickHouse ISO timestamp string (as returned by queryClickHouse). */
export function toDate(value: unknown): Date {
  return new Date(String(value));
}

export function toNumber(value: unknown): number {
  return value === null || value === undefined ? Number.NaN : Number(value);
}

export function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
