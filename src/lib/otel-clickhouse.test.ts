import assert from "node:assert/strict";
import test from "node:test";
import { attrText, DEDUPE_SPANS, toNullableNumber } from "./otel-clickhouse";

test("attrText reads strings as text and other scalars as their JSON literal", () => {
  const sql = attrText("buildkite.job.passed");
  assert.match(sql, /JSONType\(span_attributes, 'buildkite\.job\.passed'\) = 'String'/);
  assert.match(sql, /JSONExtractRaw\(span_attributes, 'buildkite\.job\.passed'\)/);
  assert.match(sql, /IN \('Null', 'Object', 'Array'\)/);
  assert.match(attrText("timeUnixNano", "ev"), /JSONExtractString\(ev, 'timeUnixNano'\)/);
});

test("attrText refuses keys that could break out of the SQL literal", () => {
  assert.throws(() => attrText("a') OR 1=1 --"), /Invalid attribute key/);
});

test("spans dedupe to the newest version of each span", () => {
  assert.equal(DEDUPE_SPANS, "ORDER BY received_at DESC LIMIT 1 BY trace_id, span_id");
  assert.equal(toNullableNumber(null), null);
  assert.equal(toNullableNumber("12.5"), 12.5);
});
