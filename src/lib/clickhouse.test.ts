import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQueryUrl, encodeParam, normalizeValue } from "./clickhouse";

test("normalizeValue trims ClickHouse nanosecond timestamps to ms", () => {
  assert.equal(normalizeValue("2026-11-13T08:24:26.285000000Z"), "2026-11-13T08:24:26.285Z");
  assert.equal(normalizeValue("2026-11-13T08:24:26Z"), "2026-11-13T08:24:26.000Z");
  assert.equal(normalizeValue("2026-11-13T08:24:26.5Z"), "2026-11-13T08:24:26.500Z");
});

test("normalizeValue maps the NULL marker to null and keeps other strings", () => {
  assert.equal(normalizeValue("ᴺᵁᴸᴸ"), null);
  assert.equal(normalizeValue("passed"), "passed");
  assert.equal(normalizeValue("12.5"), "12.5");
});

test("encodeParam quotes array items for Array(String) placeholders", () => {
  assert.equal(encodeParam(["a", "b'c", "d\\e"]), "['a','b\\'c','d\\\\e']");
  assert.equal(encodeParam([1, 2]), "[1,2]");
  assert.equal(encodeParam(true), "true");
  assert.equal(encodeParam(7), "7");
});

test("buildQueryUrl passes params as param_<name>", () => {
  const url = new URL(buildQueryUrl("https://ch.example:8443", { branch: "main" }, { max_execution_time: "5" }));
  assert.equal(url.searchParams.get("param_branch"), "main");
  assert.equal(url.searchParams.get("max_execution_time"), "5");
});
