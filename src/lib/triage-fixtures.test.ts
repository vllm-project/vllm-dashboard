import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueFilters } from "./triage-query";
import {
  fixtureActiveMaintainers,
  fixtureItemDetail,
  fixtureMyPlate,
  fixtureQueue,
  fixtureStats,
  triageDevFixturesEnabled,
} from "./triage-fixtures";

test("triageDevFixturesEnabled is strictly off in production", () => {
  assert.equal(triageDevFixturesEnabled({ NODE_ENV: "production", TRIAGE_DEV_FIXTURES: "1" }), false);
  assert.equal(triageDevFixturesEnabled({ NODE_ENV: "development", TRIAGE_DEV_FIXTURES: "0" }), false);
  assert.equal(triageDevFixturesEnabled({ NODE_ENV: "development" }), false);
  assert.equal(triageDevFixturesEnabled({ NODE_ENV: "development", TRIAGE_DEV_FIXTURES: "1" }), true);
});

test("fixtureQueue filters by owner, kind, bands, and search", () => {
  const all = fixtureQueue(parseQueueFilters(new URLSearchParams("bands=page,route,watch")));
  assert.ok(all.total >= 6);

  const unowned = fixtureQueue(parseQueueFilters(new URLSearchParams("bands=page,route&owner=none")));
  assert.ok(unowned.items.length >= 2);
  assert.ok(unowned.items.every((item) => item.assignments.length === 0));

  const readyPrs = fixtureQueue(parseQueueFilters(new URLSearchParams("kind=pr&review=ready&bands=page,route,watch")));
  assert.ok(readyPrs.items.length >= 2);
  assert.ok(readyPrs.items.every((item) => item.kind === "pr" && item.waitingOn === "reviewer"));

  const stats = fixtureStats();
  assert.equal(stats.unowned, unowned.total);
  assert.ok(fixtureActiveMaintainers().length >= 3);
  assert.ok(fixtureMyPlate("khluu").open.length >= 2);
  assert.equal(fixtureItemDetail("vllm-project/vllm#65364")?.item.number, 65364);
  assert.equal(fixtureItemDetail("vllm-project/vllm#999999"), null);
});
