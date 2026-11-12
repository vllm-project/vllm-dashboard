import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueFilters, queueFiltersToParams, safeGithubUrl } from "./triage-query";

test("defaults: page/route/watch bands, open items, score sort", () => {
  const filters = parseQueueFilters(new URLSearchParams());
  assert.deepEqual(filters.bands, ["page", "route", "watch"]);
  assert.equal(filters.state, "open");
  assert.equal(filters.sort, "score");
  assert.equal(filters.page, 1);
  assert.equal(filters.pageSize, 50);
  assert.equal(filters.includeOutOfScope, false);
});

test("valid params parse; unknown values fall back", () => {
  const filters = parseQueueFilters(
    new URLSearchParams(
      "bands=page,unscored,bogus&kind=pr&area=moe&hardware=B200&model=qwen&assignee=alice&status=acked&q=%23123&state=all&scope=all&sort=age&page=3&pageSize=999",
    ),
  );
  assert.deepEqual(filters.bands, ["page", "unscored"]);
  assert.equal(filters.kind, "pr");
  assert.equal(filters.area, "moe");
  assert.equal(filters.hardware, "B200");
  assert.equal(filters.model, "qwen");
  assert.equal(filters.assignee, "alice");
  assert.equal(filters.status, "acked");
  assert.equal(filters.q, "#123");
  assert.equal(filters.state, "all");
  assert.equal(filters.includeOutOfScope, true);
  assert.equal(filters.sort, "age");
  assert.equal(filters.page, 3);
  assert.equal(filters.pageSize, 200);

  const junk = parseQueueFilters(
    new URLSearchParams("bands=nope&kind=x&area=zzz&hardware=H9000&assignee=bad%20login&status=x&sort=x&page=-2"),
  );
  assert.deepEqual(junk.bands, ["page", "route", "watch"]);
  assert.equal(junk.kind, null);
  assert.equal(junk.area, null);
  assert.equal(junk.hardware, null);
  assert.equal(junk.assignee, null);
  assert.equal(junk.status, "any");
  assert.equal(junk.sort, "score");
  assert.equal(junk.page, 1);
});

test("filters round-trip through params, omitting defaults", () => {
  assert.equal(queueFiltersToParams(parseQueueFilters(new URLSearchParams())).toString(), "");
  const params = new URLSearchParams("bands=page&kind=issue&area=moe&page=2");
  assert.deepEqual(parseQueueFilters(queueFiltersToParams(parseQueueFilters(params))), parseQueueFilters(params));
});

test("only https vllm-project GitHub links are linkable", () => {
  assert.equal(
    safeGithubUrl("https://github.com/vllm-project/vllm/issues/1"),
    "https://github.com/vllm-project/vllm/issues/1",
  );
  assert.equal(safeGithubUrl("https://github.com/evil/vllm/issues/1"), null);
  assert.equal(safeGithubUrl("javascript:alert(1)"), null);
  assert.equal(safeGithubUrl("http://github.com/vllm-project/vllm"), null);
  assert.equal(safeGithubUrl("https://user:pw@github.com/vllm-project/vllm"), null);
});
