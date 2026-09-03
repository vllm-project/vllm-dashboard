import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_QUEUE,
  DEFAULT_QUEUE_RANGE_HOURS,
  parseQueueRangeParam,
  pickDefaultQueue,
} from "./queue-default";

test("pickDefaultQueue selects the queue with the most waiting jobs", () => {
  const queue = pickDefaultQueue([
    { queue: "gpu_1_queue", agents_total: 3, jobs_scheduled: 0, jobs_waiting: 0 },
    { queue: "h200_35gb", agents_total: 128, jobs_scheduled: 10, jobs_waiting: 43 },
  ]);

  assert.equal(queue, "h200_35gb");
});

test("pickDefaultQueue counts scheduled jobs as waiting for docker-plugin queues", () => {
  const queue = pickDefaultQueue([
    { queue: "h200_35gb", agents_total: 128, jobs_scheduled: 0, jobs_waiting: 5 },
    { queue: "gpu_1_queue", agents_total: 3, jobs_scheduled: 40, jobs_waiting: 0 },
  ]);

  assert.equal(queue, "gpu_1_queue");
});

test("pickDefaultQueue breaks waiting ties by agent count", () => {
  const queue = pickDefaultQueue([
    { queue: "small", agents_total: 2, jobs_scheduled: 0, jobs_waiting: 7 },
    { queue: "big", agents_total: 50, jobs_scheduled: 0, jobs_waiting: 7 },
  ]);

  assert.equal(queue, "big");
});

test("pickDefaultQueue falls back to most agents when nothing is waiting", () => {
  const queue = pickDefaultQueue([
    { queue: "gpu_1_queue", agents_total: 3, jobs_scheduled: 0, jobs_waiting: 0 },
    { queue: "h200_35gb", agents_total: 128, jobs_scheduled: 0, jobs_waiting: 0 },
  ]);

  assert.equal(queue, "h200_35gb");
});

test("pickDefaultQueue falls back to the default constant when the summary is empty", () => {
  assert.equal(pickDefaultQueue([]), DEFAULT_QUEUE);
});

test("parseQueueRangeParam accepts only known hour windows", () => {
  const allowed = [1, 6, 24, 168];

  assert.equal(parseQueueRangeParam("24", allowed), 24);
  assert.equal(parseQueueRangeParam("168", allowed), 168);
  assert.equal(parseQueueRangeParam("25", allowed), null);
  assert.equal(parseQueueRangeParam("abc", allowed), null);
  assert.equal(parseQueueRangeParam(null, allowed), null);
});

test("DEFAULT_QUEUE_RANGE_HOURS remains 24", () => {
  assert.equal(DEFAULT_QUEUE_RANGE_HOURS, 24);
});
