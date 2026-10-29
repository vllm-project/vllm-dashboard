import assert from "node:assert/strict";
import test from "node:test";
import {
  DASHBOARD_SECTIONS,
  type DashboardSection,
  isNavGroup,
  sectionForPathname,
  sectionPages,
  TOP_LEVEL_NAV_ITEMS,
} from "./dashboard-navigation";

test("the top level is Health, Infra and Perf Eval", () => {
  assert.deepEqual(
    TOP_LEVEL_NAV_ITEMS.map((item) => [item.label, item.href]),
    [
      ["Health", "/"],
      ["Infra", "/gpu"],
      ["Perf Eval", "/perf"],
    ],
  );
});

test("Health owns builds, jobs, tests, runner queue, alerts and the Metrics pages", () => {
  const health: DashboardSection = DASHBOARD_SECTIONS[0];
  assert.deepEqual(
    health.links.map((entry) => entry.label),
    ["Builds", "Jobs", "Tests", "Runner Queue", "Alerts", "Metrics"],
  );
  const metrics = health.links.find(isNavGroup);
  assert.deepEqual(
    metrics?.links.map((link) => [link.label, link.href]),
    [
      ["AMD Parity", "/parity"],
      ["Force-merges", "/force-merges"],
      ["Automatic sharding", "/sharding"],
    ],
  );
  const routes = ["/", "/jobs", "/tests", "/queue", "/alerts", "/parity", "/force-merges", "/sharding"];
  for (const pathname of routes) {
    assert.equal(sectionForPathname(pathname)?.label, "Health");
  }
  assert.deepEqual(TOP_LEVEL_NAV_ITEMS[0].routes, routes);
});

test("Infra owns GPU and Cost; Perf Eval owns performance, evaluation and compare", () => {
  for (const pathname of ["/gpu", "/cost"]) {
    assert.equal(sectionForPathname(pathname)?.label, "Infra");
  }
  for (const pathname of ["/perf", "/perf/some-model", "/eval", "/compare"]) {
    assert.equal(sectionForPathname(pathname)?.label, "Perf Eval");
  }
  assert.deepEqual(TOP_LEVEL_NAV_ITEMS[2].routes, ["/perf", "/eval", "/compare"]);
});

test("every page is linked from exactly one section", () => {
  const pages = DASHBOARD_SECTIONS.flatMap((section) =>
    sectionPages(section).map((link) => link.href),
  );
  assert.equal(new Set(pages).size, pages.length);
});
