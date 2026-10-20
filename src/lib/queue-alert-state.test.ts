import assert from "node:assert/strict";
import test from "node:test";

import { parseQueueStates } from "./queue-alert-state";

const entry = { status: "active", lastP90Secs: 2584.25 };

test("parseQueueStates reads a jsonb object", () => {
  assert.deepEqual(parseQueueStates({ H200: entry }), { H200: entry });
});

test("parseQueueStates reads a jsonb string left by older writes", () => {
  const states = parseQueueStates<typeof entry>(JSON.stringify({ H200: entry }));
  // The old crash: adding a queue to state that was still a string.
  states.gpu_1_queue = entry;
  assert.deepEqual(Object.keys(states), ["H200", "gpu_1_queue"]);
});

test("parseQueueStates falls back to empty state", () => {
  for (const stored of [null, undefined, "not json", "[]", 42, []]) {
    assert.deepEqual(parseQueueStates(stored), {});
  }
});
