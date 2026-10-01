import assert from "node:assert/strict";
import test from "node:test";

import { getQueueView, queueViewHref } from "./queue-navigation";

test("queue URLs default to Details, including queue links and unknown views", () => {
  for (const query of ["", "queue=gpu_1_queue", "view=unknown", "view=details"]) {
    assert.equal(getQueueView(new URLSearchParams(query)), "details");
  }
  assert.equal(getQueueView(new URLSearchParams("view=traffic")), "traffic");
});

test("opening Traffic from Details keeps the range and clears queue and traffic filters", () => {
  const params = new URLSearchParams(
    "queue=gpu_1_queue&range=168&group=cuda&family=h100&sort=waiting&metric=wait",
  );
  assert.equal(queueViewHref(params, "traffic"), "/queue?view=traffic&range=168");
  assert.equal(queueViewHref(new URLSearchParams(), "traffic"), "/queue?view=traffic");
});

test("opening Details from Traffic keeps only the range and explicit queue selection", () => {
  const params = new URLSearchParams(
    "view=traffic&range=24&group=rocm&family=mi300x&queue=mi300x&sort=waiting&metric=wait",
  );
  assert.equal(queueViewHref(params, "details"), "/queue?view=details&range=24&queue=mi300x");
  params.delete("queue");
  assert.equal(queueViewHref(params, "details"), "/queue?view=details&range=24");
  params.set("queue", "");
  assert.equal(queueViewHref(params, "details"), "/queue?view=details&range=24");
});

test("same-view navigation preserves the view's parameters without mutating them", () => {
  for (const query of [
    "view=details&queue=gpu_1_queue&range=6",
    "view=traffic&range=168&group=cuda&family=h100&queue=h100&sort=waiting&metric=wait",
  ]) {
    const params = new URLSearchParams(query);
    assert.equal(queueViewHref(params, getQueueView(params)), `/queue?${query}`);
    assert.equal(params.toString(), query);
  }
});
