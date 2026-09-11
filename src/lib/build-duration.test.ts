import assert from "node:assert/strict";
import test from "node:test";
import { buildDurationDisplay, formatBuildDuration } from "./build-duration";

const MIN = 60_000;
const HOUR = 60 * MIN;

test("formatBuildDuration uses hours and minutes at or above one hour", () => {
  assert.equal(formatBuildDuration(HOUR), "1h 0m");
  assert.equal(formatBuildDuration(HOUR + 12 * MIN + 30_000), "1h 12m");
  assert.equal(formatBuildDuration(3 * HOUR + 59 * MIN), "3h 59m");
});

test("formatBuildDuration uses minutes and seconds under one hour", () => {
  assert.equal(formatBuildDuration(48 * MIN + 3_000), "48m 3s");
  assert.equal(formatBuildDuration(59 * MIN + 59_000), "59m 59s");
  assert.equal(formatBuildDuration(MIN), "1m 0s");
});

test("formatBuildDuration drops the minutes part under one minute", () => {
  assert.equal(formatBuildDuration(45_000), "45s");
  assert.equal(formatBuildDuration(0), "0s");
});

test("formatBuildDuration rounds sub-second remainders and rejects bad input", () => {
  assert.equal(formatBuildDuration(59 * MIN + 59_600), "1h 0m");
  assert.equal(formatBuildDuration(-1), "—");
  assert.equal(formatBuildDuration(Number.NaN), "—");
});

const base = {
  created_at: "2026-09-11T10:00:00Z",
  started_at: "2026-09-11T10:02:00Z",
  finished_at: null as string | null,
};
const now = Date.parse("2026-09-11T11:30:00Z");

test("finished builds report start-to-finish duration regardless of state", () => {
  for (const state of ["passed", "failed", "canceled"]) {
    const display = buildDurationDisplay(
      { ...base, state, finished_at: "2026-09-11T11:14:30Z" },
      now,
    );
    assert.equal(display.kind, "finished");
    assert.equal(display.label, "1h 12m");
  }
});

test("running builds report elapsed time so far with a trailing ellipsis", () => {
  const display = buildDurationDisplay({ ...base, state: "running" }, now);
  assert.equal(display.kind, "running");
  assert.equal(display.label, "1h 28m…");
});

test("scheduled builds that have not started report queue time", () => {
  const display = buildDurationDisplay(
    { ...base, state: "scheduled", started_at: null },
    now,
  );
  assert.equal(display.kind, "queued");
  assert.equal(display.label, "queued 1h 30m");
});

test("terminal builds with missing timestamps show a dash", () => {
  const display = buildDurationDisplay(
    { ...base, state: "canceled", started_at: null },
    now,
  );
  assert.equal(display.kind, "unknown");
  assert.equal(display.label, "—");
});

test("elapsed time never goes negative when clocks disagree", () => {
  const display = buildDurationDisplay(
    { ...base, state: "running" },
    Date.parse("2026-09-11T10:01:00Z"),
  );
  assert.equal(display.label, "0s…");
});
