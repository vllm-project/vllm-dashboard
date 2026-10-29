import assert from "node:assert/strict";
import test from "node:test";

import { pointIndexAt } from "./chart-drag-select";

const plot = { left: 100, width: 800 };

test("band axes: each of the bars owns an equal slice", () => {
  // 4 bars of 200px: [100,300) [300,500) [500,700) [700,900]
  assert.equal(pointIndexAt(100, plot, 4, "band"), 0);
  assert.equal(pointIndexAt(299, plot, 4, "band"), 0);
  assert.equal(pointIndexAt(300, plot, 4, "band"), 1);
  assert.equal(pointIndexAt(900, plot, 4, "band"), 3);
});

test("point axes: the first and last points sit on the plot's edges", () => {
  // 5 points at 100, 300, 500, 700, 900; each x picks the nearest.
  assert.equal(pointIndexAt(100, plot, 5, "point"), 0);
  assert.equal(pointIndexAt(199, plot, 5, "point"), 0);
  assert.equal(pointIndexAt(201, plot, 5, "point"), 1);
  assert.equal(pointIndexAt(900, plot, 5, "point"), 4);
});

test("positions past the plot clamp to the end points", () => {
  assert.equal(pointIndexAt(0, plot, 5, "point"), 0);
  assert.equal(pointIndexAt(2000, plot, 4, "band"), 3);
});
