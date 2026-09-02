import assert from "node:assert/strict";
import test from "node:test";
import {
  alertWindowCutoff,
  commitUrl,
  formatRelativeTime,
  isAlertTimeWindow,
  notificationStateFor,
  pullRequestUrl,
  withinAlertWindow,
} from "./alerts-shared";

test("an alert with no outbox row reads as unnotified", () => {
  assert.equal(notificationStateFor([]), "unnotified");
});

test("delivery to Slack outranks the attempts that preceded it", () => {
  assert.equal(notificationStateFor(["retrying", "delivered"]), "delivered");
});

test("an undelivered alert reports its worst outstanding attempt", () => {
  assert.equal(notificationStateFor(["pending", "dead_letter"]), "dead_letter");
  assert.equal(notificationStateFor(["pending", "retrying"]), "retrying");
  assert.equal(notificationStateFor(["pending"]), "pending");
});

test("GitHub links resolve from a commit and a pull request number", () => {
  assert.equal(
    commitUrl("1f4c9a2b7d3e5f6a8b9c0d1e2f3a4b5c6d7e8f90"),
    "https://github.com/vllm-project/vllm/commit/1f4c9a2b7d3e5f6a8b9c0d1e2f3a4b5c6d7e8f90",
  );
  assert.equal(
    pullRequestUrl("24680"),
    "https://github.com/vllm-project/vllm/pull/24680",
  );
  assert.equal(pullRequestUrl(null), null);
});

test("only the four named windows parse as alert time windows", () => {
  assert.equal(isAlertTimeWindow("1h"), true);
  assert.equal(isAlertTimeWindow("3h"), true);
  assert.equal(isAlertTimeWindow("1d"), true);
  assert.equal(isAlertTimeWindow("7d"), true);
  assert.equal(isAlertTimeWindow("30d"), false);
  assert.equal(isAlertTimeWindow(null), false);
});

test("a window cutoff steps back from now by the window's length", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  assert.equal(
    alertWindowCutoff("1h", now).toISOString(),
    "2026-08-28T11:00:00.000Z",
  );
  assert.equal(
    alertWindowCutoff("3h", now).toISOString(),
    "2026-08-28T09:00:00.000Z",
  );
  assert.equal(
    alertWindowCutoff("1d", now).toISOString(),
    "2026-08-27T12:00:00.000Z",
  );
  assert.equal(
    alertWindowCutoff("7d", now).toISOString(),
    "2026-08-21T12:00:00.000Z",
  );
});

test("a timestamp at the cutoff is inside, before it is outside", () => {
  const cutoff = new Date("2026-08-28T11:00:00.000Z");
  assert.equal(withinAlertWindow("2026-08-28T11:00:00.000Z", cutoff), true);
  assert.equal(withinAlertWindow("2026-08-28T12:00:00.000Z", cutoff), true);
  assert.equal(withinAlertWindow("2026-08-28T10:59:59.999Z", cutoff), false);
  assert.equal(withinAlertWindow("not-a-date", cutoff), false);
});

test("relative times round to the coarsest unit that still reads at a glance", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-09-02T11:59:40.000Z", now), "just now");
  assert.equal(formatRelativeTime("2026-09-02T11:49:00.000Z", now), "11m ago");
  assert.equal(formatRelativeTime("2026-09-02T09:40:00.000Z", now), "2h ago");
  assert.equal(formatRelativeTime("2026-08-31T12:00:00.000Z", now), "2d ago");
  // Beyond a month the relative form stops being useful, so the date returns.
  assert.match(formatRelativeTime("2026-07-01T12:00:00.000Z", now), /Jul 1/);
  assert.equal(formatRelativeTime("not-a-date", now), "not-a-date");
});
