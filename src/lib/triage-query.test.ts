import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueFilters, queueFiltersToParams, safeGithubUrl } from "./triage-query";

test("no filter params: the landing view, open P0/P1 with no owner", () => {
  for (const query of ["", "q=moe", "sort=age&page=2", "item=vllm-project%2Fvllm%231"]) {
    const filters = parseQueueFilters(new URLSearchParams(query));
    assert.deepEqual(filters.bands, ["page", "route"], query);
    assert.equal(filters.owner, "none", query);
  }
});

test("literal defaults once any filter is set: page/route/watch bands, anyone, open items, score sort", () => {
  const filters = parseQueueFilters(new URLSearchParams("bands=page,route,watch"));
  assert.deepEqual(filters.bands, ["page", "route", "watch"]);
  assert.equal(filters.owner, null);
  assert.equal(parseQueueFilters(new URLSearchParams("area=moe")).owner, null);
  assert.deepEqual(parseQueueFilters(new URLSearchParams("area=moe")).bands, ["page", "route", "watch"]);
  assert.equal(filters.state, "open");
  assert.equal(filters.sort, "score");
  assert.equal(filters.page, 1);
  assert.equal(filters.pageSize, 50);
  assert.equal(filters.includeOutOfScope, false);
});

test("valid params parse; unknown values fall back", () => {
  const filters = parseQueueFilters(
    new URLSearchParams(
      "bands=page,unscored,bogus&kind=pr&area=moe&hardware=B200&model=qwen&owner=alice&status=acked&q=%23123&state=all&scope=all&sort=age&page=3&pageSize=999",
    ),
  );
  assert.deepEqual(filters.bands, ["page", "unscored"]);
  assert.equal(filters.kind, "pr");
  assert.equal(filters.area, "moe");
  assert.equal(filters.hardware, "B200");
  assert.equal(filters.model, "qwen");
  assert.equal(filters.owner, "alice");
  assert.equal(filters.status, "acked");
  assert.equal(filters.q, "#123");
  assert.equal(filters.state, "all");
  assert.equal(filters.includeOutOfScope, true);
  assert.equal(filters.sort, "age");
  assert.equal(filters.page, 3);
  assert.equal(filters.pageSize, 200);

  const junk = parseQueueFilters(
    new URLSearchParams("bands=nope&kind=x&area=zzz&hardware=H9000&owner=bad%20login&status=x&sort=x&page=-2"),
  );
  assert.deepEqual(junk.bands, ["page", "route", "watch"]);
  assert.equal(junk.kind, null);
  assert.equal(junk.area, null);
  assert.equal(junk.hardware, null);
  assert.equal(junk.owner, null);
  assert.equal(junk.status, "any");
  assert.equal(junk.sort, "score");
  assert.equal(junk.page, 1);
});

test("filters round-trip through params, omitting defaults", () => {
  assert.equal(queueFiltersToParams(parseQueueFilters(new URLSearchParams())).toString(), "");
  // The landing view is written as no params, however it was reached.
  assert.equal(queueFiltersToParams(parseQueueFilters(new URLSearchParams("bands=route,page&owner=none"))).toString(), "");
  // Literal defaults (P0–P2, anyone) must not read back as the landing view.
  const literal = queueFiltersToParams(parseQueueFilters(new URLSearchParams("bands=page,route,watch"))).toString();
  assert.equal(literal, "bands=page%2Croute%2Cwatch");
  assert.equal(parseQueueFilters(new URLSearchParams(literal)).owner, null);
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

test("owner filter: a login, none, or the old assignee param", () => {
  const parse = (query: string) => parseQueueFilters(new URLSearchParams(query)).owner;
  assert.equal(parse("owner=khluu"), "khluu");
  assert.equal(parse("owner=none"), "none");
  assert.equal(parse("assignee=gau-nernst"), "gau-nernst");
  assert.equal(parse("owner=khluu&assignee=other"), "khluu");
  assert.equal(parse("owner=bad%20login"), null);
  assert.equal(parse(""), "none"); // the landing view
  assert.equal(queueFiltersToParams(parseQueueFilters(new URLSearchParams("owner=none"))).toString(), "owner=none");
  assert.equal(queueFiltersToParams(parseQueueFilters(new URLSearchParams("assignee=khluu"))).toString(), "owner=khluu");
});
