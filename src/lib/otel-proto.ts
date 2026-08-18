import { parse, type Type } from "protobufjs";

export type OtlpAttributeValue =
  | string
  | number
  | boolean
  | null
  | OtlpAttributeValue[]
  | { [key: string]: OtlpAttributeValue };

export interface OtlpSpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: Record<string, OtlpAttributeValue>;
  droppedAttributesCount: number;
}

export interface OtlpSpanLink {
  traceId: string;
  spanId: string;
  traceState: string | null;
  attributes: Record<string, OtlpAttributeValue>;
  droppedAttributesCount: number;
  flags: number;
}

export interface NormalizedOtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceState: string | null;
  flags: number;
  name: string;
  kind: number;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  statusCode: number;
  statusMessage: string | null;
  scopeName: string | null;
  scopeVersion: string | null;
  scopeSchemaUrl: string | null;
  resourceSchemaUrl: string | null;
  resourceAttributes: Record<string, OtlpAttributeValue>;
  spanAttributes: Record<string, OtlpAttributeValue>;
  events: OtlpSpanEvent[];
  links: OtlpSpanLink[];
  droppedAttributesCount: number;
  droppedEventsCount: number;
  droppedLinksCount: number;
}

interface LongLike {
  toString(): string;
}

interface ProtoAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: number | string | LongLike;
  doubleValue?: number;
  arrayValue?: { values?: ProtoAnyValue[] };
  kvlistValue?: { values?: ProtoKeyValue[] };
  bytesValue?: Uint8Array;
}

interface ProtoKeyValue {
  key?: string;
  value?: ProtoAnyValue;
}

interface ProtoSpan {
  traceId?: Uint8Array;
  spanId?: Uint8Array;
  traceState?: string;
  parentSpanId?: Uint8Array;
  flags?: number;
  name?: string;
  kind?: number;
  startTimeUnixNano?: number | string | LongLike;
  endTimeUnixNano?: number | string | LongLike;
  attributes?: ProtoKeyValue[];
  droppedAttributesCount?: number;
  events?: Array<{
    timeUnixNano?: number | string | LongLike;
    name?: string;
    attributes?: ProtoKeyValue[];
    droppedAttributesCount?: number;
  }>;
  droppedEventsCount?: number;
  links?: Array<{
    traceId?: Uint8Array;
    spanId?: Uint8Array;
    traceState?: string;
    attributes?: ProtoKeyValue[];
    droppedAttributesCount?: number;
    flags?: number;
  }>;
  droppedLinksCount?: number;
  status?: { message?: string; code?: number };
}

interface ExportTraceServiceRequest {
  resourceSpans?: Array<{
    resource?: { attributes?: ProtoKeyValue[] };
    scopeSpans?: Array<{
      scope?: { name?: string; version?: string };
      spans?: ProtoSpan[];
      schemaUrl?: string;
    }>;
    schemaUrl?: string;
  }>;
}

// This is the wire-compatible subset of the stable OpenTelemetry trace proto.
// Protobuf message names and packages do not affect the wire format; field
// numbers and wire types do. Keeping the schema inline avoids filesystem reads
// from a serverless function bundle.
const TRACE_PROTO = `
syntax = "proto3";

message ExportTraceServiceRequest {
  repeated ResourceSpans resource_spans = 1;
}

message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}

message ScopeSpans {
  InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}

message Resource {
  repeated KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
}

message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
    int32 string_value_strindex = 8;
  }
}

message ArrayValue {
  repeated AnyValue values = 1;
}

message KeyValueList {
  repeated KeyValue values = 1;
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
  int32 key_strindex = 3;
}

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  int32 kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  repeated Event events = 11;
  uint32 dropped_events_count = 12;
  repeated Link links = 13;
  uint32 dropped_links_count = 14;
  Status status = 15;
  fixed32 flags = 16;

  message Event {
    fixed64 time_unix_nano = 1;
    string name = 2;
    repeated KeyValue attributes = 3;
    uint32 dropped_attributes_count = 4;
  }

  message Link {
    bytes trace_id = 1;
    bytes span_id = 2;
    string trace_state = 3;
    repeated KeyValue attributes = 4;
    uint32 dropped_attributes_count = 5;
    fixed32 flags = 6;
  }
}

message Status {
  string message = 2;
  int32 code = 3;
}
`;

let requestType: Type | undefined;

function getRequestType(): Type {
  if (!requestType) {
    requestType = parse(TRACE_PROTO).root.lookupType("ExportTraceServiceRequest");
  }
  return requestType;
}

function longToBigInt(value: number | string | LongLike | undefined): bigint {
  if (value === undefined) return BigInt(0);
  return BigInt(typeof value === "number" ? Math.trunc(value) : value.toString());
}

function longToJsonValue(value: number | string | LongLike): number | string {
  const parsed = longToBigInt(value);
  if (
    parsed <= BigInt(Number.MAX_SAFE_INTEGER) &&
    parsed >= BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return Number(parsed);
  }
  return parsed.toString();
}

function anyValueToJson(value: ProtoAnyValue | undefined): OtlpAttributeValue {
  if (!value) return null;
  const has = (field: keyof ProtoAnyValue) =>
    Object.prototype.hasOwnProperty.call(value, field);
  if (has("stringValue")) return value.stringValue ?? "";
  if (has("boolValue")) return value.boolValue ?? false;
  if (has("intValue")) return longToJsonValue(value.intValue!);
  if (has("doubleValue")) return value.doubleValue ?? 0;
  if (has("arrayValue")) {
    return (value.arrayValue!.values ?? []).map(anyValueToJson);
  }
  if (has("kvlistValue")) {
    return keyValuesToRecord(value.kvlistValue!.values);
  }
  if (has("bytesValue")) {
    return Buffer.from(value.bytesValue!).toString("base64");
  }
  return null;
}

function keyValuesToRecord(
  attributes: ProtoKeyValue[] | undefined,
): Record<string, OtlpAttributeValue> {
  const result: Record<string, OtlpAttributeValue> = {};
  for (const attribute of attributes ?? []) {
    if (attribute.key) result[attribute.key] = anyValueToJson(attribute.value);
  }
  return result;
}

function bytesToHex(
  value: Uint8Array | undefined,
  expectedLength: number,
  field: string,
  allowEmpty = false,
): string | null {
  const bytes = value ?? new Uint8Array();
  if (allowEmpty && bytes.length === 0) return null;
  if (bytes.length !== expectedLength || bytes.every((byte) => byte === 0)) {
    throw new Error(`Invalid OTLP ${field}`);
  }
  return Buffer.from(bytes).toString("hex");
}

function nanoTimestampToDate(nanoseconds: bigint, field: string): Date {
  if (nanoseconds <= BigInt(0)) throw new Error(`Invalid OTLP ${field}`);
  const date = new Date(Number(nanoseconds / BigInt(1_000_000)));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid OTLP ${field}`);
  return date;
}

export function decodeOtlpTraceRequest(
  payload: Uint8Array,
): NormalizedOtlpSpan[] {
  const decoded = getRequestType().decode(payload) as unknown as ExportTraceServiceRequest;
  const result: NormalizedOtlpSpan[] = [];

  for (const resourceSpans of decoded.resourceSpans ?? []) {
    const resourceAttributes = keyValuesToRecord(
      resourceSpans.resource?.attributes,
    );

    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        const startNanos = longToBigInt(span.startTimeUnixNano);
        const endNanos = longToBigInt(span.endTimeUnixNano);
        if (endNanos < startNanos) {
          throw new Error("Invalid OTLP span duration");
        }

        result.push({
          traceId: bytesToHex(span.traceId, 16, "trace_id")!,
          spanId: bytesToHex(span.spanId, 8, "span_id")!,
          parentSpanId: bytesToHex(
            span.parentSpanId,
            8,
            "parent_span_id",
            true,
          ),
          traceState: span.traceState || null,
          flags: span.flags ?? 0,
          name: span.name || "unknown",
          kind: span.kind ?? 0,
          startTime: nanoTimestampToDate(startNanos, "start_time_unix_nano"),
          endTime: nanoTimestampToDate(endNanos, "end_time_unix_nano"),
          durationMs: Number(endNanos - startNanos) / 1_000_000,
          statusCode: span.status?.code ?? 0,
          statusMessage: span.status?.message || null,
          scopeName: scopeSpans.scope?.name || null,
          scopeVersion: scopeSpans.scope?.version || null,
          scopeSchemaUrl: scopeSpans.schemaUrl || null,
          resourceSchemaUrl: resourceSpans.schemaUrl || null,
          resourceAttributes,
          spanAttributes: keyValuesToRecord(span.attributes),
          events: (span.events ?? []).map((event) => ({
            timeUnixNano: longToBigInt(event.timeUnixNano).toString(),
            name: event.name || "unknown",
            attributes: keyValuesToRecord(event.attributes),
            droppedAttributesCount: event.droppedAttributesCount ?? 0,
          })),
          links: (span.links ?? []).map((link) => ({
            traceId: bytesToHex(link.traceId, 16, "link.trace_id")!,
            spanId: bytesToHex(link.spanId, 8, "link.span_id")!,
            traceState: link.traceState || null,
            attributes: keyValuesToRecord(link.attributes),
            droppedAttributesCount: link.droppedAttributesCount ?? 0,
            flags: link.flags ?? 0,
          })),
          droppedAttributesCount: span.droppedAttributesCount ?? 0,
          droppedEventsCount: span.droppedEventsCount ?? 0,
          droppedLinksCount: span.droppedLinksCount ?? 0,
        });
      }
    }
  }

  return result;
}

export function encodeOtlpTraceRequestForTest(value: object): Uint8Array {
  return getRequestType().encode(getRequestType().fromObject(value)).finish();
}
