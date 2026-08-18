import assert from "node:assert/strict";
import test from "node:test";
import {
  sectionForPathname,
  TOP_LEVEL_NAV_ITEMS,
} from "./dashboard-navigation";

test("CI Health owns builds, jobs, queue, tests, and nightly routes", () => {
  for (const pathname of ["/", "/jobs", "/queue", "/tests", "/nightly"]) {
    assert.equal(sectionForPathname(pathname)?.label, "CI Health");
  }

  assert.deepEqual(TOP_LEVEL_NAV_ITEMS[0].routes, [
    "/",
    "/jobs",
    "/queue",
    "/tests",
    "/nightly",
  ]);
});

test("Infrastructure owns GPU and Cost routes", () => {
  assert.equal(sectionForPathname("/gpu")?.label, "Infrastructure");
  assert.equal(sectionForPathname("/cost")?.label, "Infrastructure");
  assert.deepEqual(TOP_LEVEL_NAV_ITEMS[1].routes, ["/gpu", "/cost"]);
});

test("standalone destinations do not render a section nav", () => {
  for (const pathname of ["/perf", "/eval", "/compare"]) {
    assert.equal(sectionForPathname(pathname), undefined);
  }
});
