import assert from "node:assert/strict";
import test from "node:test";

import {
  durationStats,
  formatMinutes,
  rangeSpanMs,
  redTime,
  type FinishedBuild,
} from "./build-stats";

const HOUR = 3_600_000;
const t0 = Date.parse("2026-10-20T00:00:00Z");
const build = (state: string, hour: number, mins = 60): FinishedBuild => ({
  state,
  created_at: new Date(t0 + hour * HOUR - mins * 60_000).toISOString(),
  finished_at: new Date(t0 + hour * HOUR).toISOString(),
  duration_mins: String(mins),
});

test("durationStats ignores canceled builds", () => {
  const stats = durationStats([
    build("passed", 1, 60),
    build("failed", 2, 120),
    build("passed", 3, 90),
    build("canceled", 4, 5),
  ]);
  assert.deepEqual(stats, { p50: 90, p90: 120 });
  assert.equal(durationStats([build("canceled", 1)]), null);
});

test("redTime: red from each failure until the next pass", () => {
  // Pass at 0h, fail at 2h, fail at 3h, pass at 6h, fail at 9h; until 10h.
  const result = redTime(
    [
      build("passed", 0),
      build("failed", 2),
      build("failing", 3),
      build("passed", 6),
      build("canceled", 7),
      build("failed", 9),
    ],
    t0 + 10 * HOUR,
  );
  // Red 2h→6h and 9h→10h: 5h of 10h; the longest stretch is 2h→6h.
  assert.deepEqual(result, { share: 0.5, longestMs: 4 * HOUR });
});

test("redTime: no outcomes, or nothing before `until`, gives null", () => {
  assert.equal(redTime([], t0), null);
  assert.equal(redTime([build("failed", 5)], t0 + 2 * HOUR), null);
});

test("rangeSpanMs reads date ends as inclusive and stops at now", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  assert.equal(rangeSpanMs("2026-10-14", "2026-10-27", now), 14 * 24 * HOUR);
  assert.equal(rangeSpanMs("2026-10-28", "2026-10-28", now), 12 * HOUR);
  assert.equal(
    rangeSpanMs("2026-10-20T10:00:00.000Z", "2026-10-20T16:00:00.000Z", now),
    6 * HOUR,
  );
  assert.equal(rangeSpanMs("", "", now), null);
});

test("formatMinutes", () => {
  assert.equal(formatMinutes(45), "45m");
  assert.equal(formatMinutes(120), "2h");
  assert.equal(formatMinutes(85), "1h 25m");
});
