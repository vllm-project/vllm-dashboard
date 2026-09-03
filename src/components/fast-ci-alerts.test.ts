import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FastCIAlerts } from "./fast-ci-alerts";
import {
  groupFastFailureEvents,
  type FastFailureEvent,
} from "../lib/alerts-fast-ci";

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
    prNumber: "24680",
    pipeline: "ci",
    notificationStatuses: ["delivered"],
    ...overrides,
  };
}

function render(events: FastFailureEvent[]): string {
  return renderToStaticMarkup(
    createElement(FastCIAlerts, { groups: groupFastFailureEvents(events) }),
  );
}

test("Fast Failure Events offer no resolution controls", () => {
  const markup = render([
    event({ buildkiteJobId: "job-1" }),
    event({ buildkiteJobId: "job-2", notificationStatuses: ["dead_letter"] }),
  ]);

  assert.doesNotMatch(markup, /<button|<form|<input|<select|<textarea/i);
  assert.doesNotMatch(
    markup,
    /resolve|resolved|acknowledge|snooze|mute|dismiss|assign/i,
  );
});

test("each event links to its Buildkite job and its GitHub commit", () => {
  const markup = render([event()]);

  assert.match(markup, /https:\/\/buildkite\.com\/vllm\/ci\/builds\/9001#job-1/);
  assert.match(markup, /https:\/\/buildkite\.com\/vllm\/ci\/builds\/9001"/);
  assert.match(
    markup,
    /https:\/\/github\.com\/vllm-project\/vllm\/commit\/1f4c9a2b7d3e5f6a8b9c0d1e2f3a4b5c6d7e8f90/,
  );
  assert.match(markup, /https:\/\/github\.com\/vllm-project\/vllm\/pull\/24680/);
});

test("notification state is visible for every event", () => {
  const markup = render([
    event({ buildkiteJobId: "job-1", notificationStatuses: ["pending"] }),
    event({ buildkiteJobId: "job-2", notificationStatuses: ["retrying"] }),
    event({ buildkiteJobId: "job-3", notificationStatuses: ["delivered"] }),
    event({ buildkiteJobId: "job-4", notificationStatuses: ["dead_letter"] }),
  ]);

  for (const label of [
    "Slack pending",
    "Slack retrying",
    "Slack delivered",
    "Slack dead-lettered",
  ]) {
    assert.match(markup, new RegExp(label));
  }
});

test("an empty window says so instead of rendering an empty list", () => {
  const markup = renderToStaticMarkup(
    createElement(FastCIAlerts, { groups: [], showSoftFailed: true }),
  );

  assert.match(markup, /No Fast CI failures/);
});

test("an empty window with soft failures hidden says they are hidden", () => {
  const markup = renderToStaticMarkup(
    createElement(FastCIAlerts, { groups: [] }),
  );

  assert.match(markup, /soft failures are hidden/);
});

const ROW_CLASS = "flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2";

test("repeated runs of one job collapse into a single row with a count badge", () => {
  const markup = render([
    event({ buildkiteJobId: "job-1" }),
    event({
      buildkiteJobId: "job-2",
      jobUrl: "https://buildkite.com/vllm/ci/builds/9001#job-2",
      finishedAt: "2026-08-27T10:05:00.000Z",
    }),
  ]);

  assert.match(markup, /×2/);
  assert.match(markup, /<details/);
  // Both attempts stay reachable behind the disclosure.
  assert.match(markup, /#job-1/);
  assert.match(markup, /#job-2/);
  assert.equal(markup.split(ROW_CLASS).length - 1, 2);
});

test("a job that failed once renders as a plain row with no disclosure", () => {
  const markup = render([event()]);

  assert.doesNotMatch(markup, /<details/);
  assert.doesNotMatch(markup, /×\d/);
  assert.equal(markup.split(ROW_CLASS).length - 1, 1);
});

test("a collapsed row shows the worst Slack state across its attempts", () => {
  const markup = render([
    event({ buildkiteJobId: "job-1", notificationStatuses: ["delivered"] }),
    event({
      buildkiteJobId: "job-2",
      notificationStatuses: ["dead_letter"],
      finishedAt: "2026-08-27T10:05:00.000Z",
    }),
  ]);

  assert.match(markup, /Slack dead-lettered/);
});

test("builds with more than ten job groups collapse the rest behind a toggle", () => {
  const events = Array.from({ length: 12 }, (_, i) =>
    event({
      buildkiteJobId: `job-${i}`,
      jobName: `Job ${String(i).padStart(2, "0")}`,
      finishedAt: `2026-08-27T10:${String(i).padStart(2, "0")}:00.000Z`,
    }),
  );
  const markup = render(events);

  assert.match(markup, /Show all 12 jobs/);
  // Only the ten newest job groups render before the toggle.
  assert.equal(markup.split(ROW_CLASS).length - 1, 10);
  assert.match(markup, /Job 11/);
  assert.doesNotMatch(markup, /Job 00/);
  assert.doesNotMatch(markup, /Job 01/);
});

test("builds with ten or fewer job groups render every row", () => {
  const events = Array.from({ length: 10 }, (_, i) =>
    event({ buildkiteJobId: `job-${i}`, jobName: `Job ${i}` }),
  );
  const markup = render(events);

  assert.doesNotMatch(markup, /Show all/);
  assert.equal(markup.split(ROW_CLASS).length - 1, 10);
});
