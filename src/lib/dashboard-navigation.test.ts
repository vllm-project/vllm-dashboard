import assert from "node:assert/strict";
import test from "node:test";
import {
  activeLinkForPathname,
  DASHBOARD_SECTIONS,
  sectionForPathname,
  TOP_LEVEL_NAV_ITEMS,
} from "./dashboard-navigation";

test("Overview is the first top-level item and owns only the root route", () => {
  assert.equal(TOP_LEVEL_NAV_ITEMS[0].label, "Overview");
  assert.deepEqual(TOP_LEVEL_NAV_ITEMS[0].routes, ["/"]);
  assert.equal(sectionForPathname("/"), undefined);
});

test("CI Health owns builds, jobs, queue, tests, and alerts routes", () => {
  for (const pathname of ["/builds", "/jobs", "/queue", "/tests", "/alerts"]) {
    assert.equal(sectionForPathname(pathname)?.label, "CI Health");
  }
  assert.deepEqual(TOP_LEVEL_NAV_ITEMS[1].routes, [
    "/builds",
    "/jobs",
    "/queue",
    "/tests",
    "/alerts",
  ]);
});

test("Infrastructure owns GPU and Cost routes", () => {
  assert.equal(sectionForPathname("/gpu")?.label, "Infrastructure");
  assert.equal(sectionForPathname("/cost")?.label, "Infrastructure");
  assert.deepEqual(TOP_LEVEL_NAV_ITEMS[2].routes, ["/gpu", "/cost"]);
});

test("Benchmarks owns perf, eval, and compare routes including nested ones", () => {
  for (const pathname of [
    "/perf",
    "/perf/benchmarks",
    "/eval",
    "/compare",
    "/compare/model/foo",
  ]) {
    assert.equal(sectionForPathname(pathname)?.label, "Benchmarks");
  }
});

test("the longest matching link is active within a section", () => {
  const benchmarks = DASHBOARD_SECTIONS[2];
  assert.equal(activeLinkForPathname(benchmarks, "/perf")?.label, "Trends");
  assert.equal(
    activeLinkForPathname(benchmarks, "/perf/benchmarks")?.label,
    "Frontier",
  );
  assert.equal(
    activeLinkForPathname(benchmarks, "/compare/a/b")?.label,
    "Compare",
  );
});
