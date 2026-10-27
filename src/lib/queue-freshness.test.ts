import assert from "node:assert/strict";
import test from "node:test";

import { staleQueueDataAge } from "./queue-freshness";

const now = Date.parse("2026-10-27T22:00:00Z");

test("a recent poll is fresh", () => {
  assert.equal(staleQueueDataAge("2026-10-27T21:52:00Z", now), null);
});

test("a poll older than 15 minutes is stale, with its age", () => {
  assert.equal(
    staleQueueDataAge("2026-10-27T21:40:00Z", now)?.label,
    "the last Buildkite queue poll was 20m ago",
  );
  assert.equal(
    staleQueueDataAge("2026-10-27T19:41:00Z", now)?.label,
    "the last Buildkite queue poll was 2h 19m ago",
  );
  assert.equal(
    staleQueueDataAge("2026-10-20T22:00:00Z", now)?.label,
    "the last Buildkite queue poll was 7d ago",
  );
});

test("no poll at all is stale", () => {
  assert.equal(
    staleQueueDataAge(null, now)?.label,
    "no queue poll has been recorded",
  );
});
