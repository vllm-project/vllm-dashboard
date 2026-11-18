import assert from "node:assert/strict";
import test from "node:test";
import { describeReason, formatAge, itemFromLocation } from "./triage-format";

test("router reasons read as plain words", () => {
  assert.equal(describeReason("relevance:high"), "judged high from their recent work");
  assert.equal(describeReason("authored #61201"), "wrote #61201, which this item names");
  assert.equal(describeReason("commented"), "already commented on this item");
  assert.equal(describeReason("area:moe"), "their rule: area moe");
  assert.equal(describeReason("something:new"), "something:new");
});

test("ages are compact", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  assert.equal(formatAge("2026-11-16T11:30:00Z", now), "30m");
  assert.equal(formatAge("2026-11-15T12:00:00Z", now), "24h");
  assert.equal(formatAge("2026-11-10T12:00:00Z", now), "6d");
  assert.equal(formatAge("not a date", now), "—");
});

test("item links survive an unencoded '#'", () => {
  assert.equal(itemFromLocation("vllm-project/vllm#48071", ""), "vllm-project/vllm#48071");
  assert.equal(itemFromLocation("vllm-project/vllm", "#48071"), "vllm-project/vllm#48071");
  assert.equal(itemFromLocation("vllm-project/vllm", "#section"), "vllm-project/vllm");
  assert.equal(itemFromLocation(null, "#48071"), null);
});
