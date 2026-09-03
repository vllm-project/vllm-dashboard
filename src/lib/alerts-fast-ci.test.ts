import assert from "node:assert/strict";
import test from "node:test";
import {
  groupFastFailureEvents,
  worstNotificationState,
  type FastFailureEvent,
} from "./alerts-fast-ci";

function event(overrides: Partial<FastFailureEvent> = {}): FastFailureEvent {
  return {
    buildkiteJobId: "job-1",
    jobName: "Async engine test",
    jobUrl: "https://buildkite.com/vllm/ci/builds/9001#job-1",
    state: "failed",
    softFailed: false,
    durationSeconds: 4,
    finishedAt: "2026-08-27T10:00:00.000Z",
    buildUrl: "https://buildkite.com/vllm/ci/builds/9001",
    message: "Add paged attention kernel",
    commitSha: "1f4c9a2b7d3e5f6a8b9c0d1e2f3a4b5c6d7e8f90",
    branch: "main",
    author: "a-maintainer",
    prNumber: null,
    pipeline: "ci",
    notificationStatuses: ["delivered"],
    ...overrides,
  };
}

test("jobs from one build and commit read as a single cluster", () => {
  const groups = groupFastFailureEvents([
    event({
      buildkiteJobId: "job-1",
      jobName: "Async engine test",
      finishedAt: "2026-08-27T10:00:00.000Z",
    }),
    event({
      buildkiteJobId: "job-2",
      jobName: "Entrypoints test",
      finishedAt: "2026-08-27T10:04:00.000Z",
    }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].buildUrl, "https://buildkite.com/vllm/ci/builds/9001");
  assert.equal(
    groups[0].commitSha,
    "1f4c9a2b7d3e5f6a8b9c0d1e2f3a4b5c6d7e8f90",
  );
  assert.deepEqual(
    groups[0].events.map((e) => e.jobName),
    ["Entrypoints test", "Async engine test"],
  );
});

test("a retried build separates from the original run of the same commit", () => {
  const groups = groupFastFailureEvents([
    event({
      buildkiteJobId: "job-1",
      buildUrl: "https://buildkite.com/vllm/ci/builds/9001",
      finishedAt: "2026-08-27T10:00:00.000Z",
    }),
    event({
      buildkiteJobId: "job-2",
      buildUrl: "https://buildkite.com/vllm/ci/builds/9002",
      finishedAt: "2026-08-27T11:00:00.000Z",
    }),
  ]);

  assert.deepEqual(
    groups.map((group) => group.buildUrl),
    [
      "https://buildkite.com/vllm/ci/builds/9002",
      "https://buildkite.com/vllm/ci/builds/9001",
    ],
  );
});

test("a rebuilt commit and a fresh commit stay distinct clusters", () => {
  const groups = groupFastFailureEvents([
    event({
      buildkiteJobId: "job-1",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    event({
      buildkiteJobId: "job-2",
      commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
  ]);

  assert.equal(groups.length, 2);
});

test("each event carries its own notification state", () => {
  const [group] = groupFastFailureEvents([
    event({ buildkiteJobId: "job-1", notificationStatuses: [] }),
    event({
      buildkiteJobId: "job-2",
      notificationStatuses: ["pending", "dead_letter"],
      finishedAt: "2026-08-27T10:05:00.000Z",
    }),
  ]);

  assert.deepEqual(
    group.events.map((e) => e.notificationState),
    ["dead_letter", "unnotified"],
  );
});

test("repeated runs of one job collapse into a job group within a build", () => {
  const [group] = groupFastFailureEvents([
    event({
      buildkiteJobId: "job-1",
      jobName: "Async engine test",
      finishedAt: "2026-08-27T10:00:00.000Z",
    }),
    event({
      buildkiteJobId: "job-2",
      jobName: "Async engine test",
      finishedAt: "2026-08-27T10:06:00.000Z",
    }),
    event({
      buildkiteJobId: "job-3",
      jobName: "Entrypoints test",
      finishedAt: "2026-08-27T10:04:00.000Z",
    }),
  ]);

  assert.equal(group.jobGroups.length, 2);
  const [asyncGroup, entrypointsGroup] = group.jobGroups;
  assert.equal(asyncGroup.jobName, "Async engine test");
  assert.equal(asyncGroup.count, 2);
  assert.equal(asyncGroup.firstFinishedAt, "2026-08-27T10:00:00.000Z");
  assert.equal(asyncGroup.lastFinishedAt, "2026-08-27T10:06:00.000Z");
  assert.deepEqual(
    asyncGroup.events.map((e) => e.buildkiteJobId),
    ["job-2", "job-1"],
  );
  assert.equal(entrypointsGroup.count, 1);
});

test("job groups are ordered by their latest finish", () => {
  const [group] = groupFastFailureEvents([
    event({
      buildkiteJobId: "job-1",
      jobName: "Async engine test",
      finishedAt: "2026-08-27T10:00:00.000Z",
    }),
    event({
      buildkiteJobId: "job-2",
      jobName: "Entrypoints test",
      finishedAt: "2026-08-27T10:04:00.000Z",
    }),
    event({
      buildkiteJobId: "job-3",
      jobName: "Async engine test",
      finishedAt: "2026-08-27T10:02:00.000Z",
    }),
  ]);

  assert.deepEqual(
    group.jobGroups.map((jobGroup) => jobGroup.jobName),
    ["Entrypoints test", "Async engine test"],
  );
});

test("a job group reports the worst Slack state across its attempts", () => {
  const [group] = groupFastFailureEvents([
    event({ buildkiteJobId: "job-1", notificationStatuses: ["delivered"] }),
    event({
      buildkiteJobId: "job-2",
      notificationStatuses: ["dead_letter"],
      finishedAt: "2026-08-27T10:05:00.000Z",
    }),
    event({
      buildkiteJobId: "job-3",
      notificationStatuses: ["pending"],
      finishedAt: "2026-08-27T10:04:00.000Z",
    }),
  ]);

  assert.equal(group.jobGroups.length, 1);
  assert.equal(group.jobGroups[0].notificationState, "dead_letter");
});

test("worstNotificationState ranks undelivered states above delivered", () => {
  assert.equal(
    worstNotificationState(["delivered", "retrying"]),
    "retrying",
  );
  assert.equal(
    worstNotificationState(["delivered", "unnotified"]),
    "unnotified",
  );
  assert.equal(worstNotificationState(["delivered"]), "delivered");
  assert.equal(worstNotificationState([]), "unnotified");
});
