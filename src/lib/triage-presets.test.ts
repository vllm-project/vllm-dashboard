import assert from "node:assert/strict";
import test from "node:test";
import {
  QUEUE_PRESETS,
  activeFilterCount,
  activePreset,
  inPlateView,
  parsePlateView,
  parseQueueLocation,
  presetFilters,
  presetQuery,
} from "./triage-presets";
import { parseQueueFilters } from "./triage-query";

const parse = (query: string) => parseQueueFilters(new URLSearchParams(query));

test("each preset maps to its query string", () => {
  assert.equal(presetQuery("needs-triage"), "");
  assert.equal(presetQuery("not-acked"), "status=open");
  assert.equal(presetQuery("review"), "kind=pr&review=ready");
  assert.equal(presetQuery("merge"), "bands=page%2Croute%2Cwatch%2Cignore%2Cunscored&kind=pr&review=merge");
  assert.equal(presetQuery("cleanup"), "bands=page%2Croute%2Cwatch%2Cignore%2Cunscored&kind=pr&review=cleanup");
  assert.equal(presetQuery("all"), "bands=page%2Croute%2Cwatch%2Cignore%2Cunscored");
});

test("the presets mean what their names say", () => {
  const needs = parse(presetQuery("needs-triage"));
  assert.deepEqual([needs.bands, needs.owner, needs.state], [["page", "route"], "none", "open"]);
  const notAcked = parse(presetQuery("not-acked"));
  assert.deepEqual([notAcked.status, notAcked.owner], ["open", null]);
  const all = parse(presetQuery("all"));
  assert.deepEqual([all.bands.length, all.owner, all.state], [5, null, "open"]);
});

test("every preset round-trips through the URL and is recognised", () => {
  for (const preset of QUEUE_PRESETS) {
    assert.equal(activePreset(parse(presetQuery(preset.id))), preset.id, preset.id);
  }
});

test("existing links keep landing sensibly", () => {
  // Slack and the My-list empty state link here; it was "Unowned P0/P1", now "Needs triage".
  assert.equal(activePreset(parse("bands=page,route&owner=none")), "needs-triage");
  assert.equal(activePreset(parse("owner=none&bands=route,page")), "needs-triage");
  // The old default ("/triage") is the new default.
  assert.equal(activePreset(parse("")), "needs-triage");
  // The old "All" link.
  assert.equal(activePreset(parse("bands=page,route,watch,ignore,unscored")), "all");
  // ?view= with old and new preset ids.
  const view = (id: string) => activePreset(parseQueueLocation(new URLSearchParams(`view=${id}&q=moe`)));
  assert.equal(view("unowned"), "needs-triage");
  assert.equal(view("needs-triage"), "needs-triage");
  assert.equal(view("not-acked"), "not-acked");
  assert.equal(view("review"), "review");
  assert.equal(view("merge"), "merge");
  assert.equal(view("ready-to-merge"), "merge");
  assert.equal(view("cleanup"), "cleanup");
  assert.equal(view("dupes"), "cleanup");
  assert.equal(view("all"), "all");
  assert.equal(parseQueueLocation(new URLSearchParams("view=unowned&q=moe")).q, "moe");
  assert.equal(activePreset(parseQueueLocation(new URLSearchParams("view=bogus"))), "needs-triage");
  // Search, sort and paging don't change which preset is active.
  assert.equal(activePreset(parse("bands=page,route&owner=none&q=moe&sort=age&page=2")), "needs-triage");
  // Anything else is a custom view.
  assert.equal(activePreset(parse("bands=page,route&owner=none&area=moe")), null);
  assert.equal(activePreset(parse("owner=alice")), null);
  assert.equal(activePreset(parse("state=all")), null);
});

test("switching preset keeps search and sort, resets the rest", () => {
  const current = parse("area=moe&owner=bob&q=deepseek&sort=updated&page=4");
  const next = presetFilters("needs-triage", current);
  assert.equal(next.area, null);
  assert.equal(next.owner, "none");
  assert.equal(next.q, "deepseek");
  assert.equal(next.sort, "updated");
  assert.equal(next.page, 1);
  assert.equal(presetQuery("needs-triage", current), "q=deepseek&sort=updated");
  assert.equal(presetQuery("not-acked", current), "status=open&q=deepseek&sort=updated");
});

test("review filter parses and serialises ready, merge, and cleanup", () => {
  assert.equal(parse("review=ready").review, "ready");
  assert.equal(parse("review=merge").review, "merge");
  assert.equal(parse("review=cleanup").review, "cleanup");
  assert.equal(parse("review=bogus").review, null);
});

test("filter badge counts what goes beyond the view", () => {
  assert.equal(activeFilterCount(parse("")), 0);
  assert.equal(activeFilterCount(parse("q=moe")), 0);
  assert.equal(activeFilterCount(parse("status=open")), 0);
  assert.equal(activeFilterCount(parse("area=moe&hardware=B200")), 2);
  // On a preset, only what goes beyond it counts.
  assert.equal(activeFilterCount(parse("bands=page,route&owner=none")), 0);
  assert.equal(activeFilterCount(parse("bands=page,route&owner=none&sort=age")), 1);
  assert.equal(activeFilterCount(parse("bands=page,route&owner=none&area=moe")), 3);
  assert.equal(activeFilterCount(parse("sort=age&state=all")), 2);
});

test("My list quick filters", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    kind: "pr" as const,
    state: "open",
    draft: false,
    waitingOn: "reviewer" as const,
    assignment: { status: "open" },
    ...overrides,
  });
  assert.equal(parsePlateView("needs-ack"), "needs-ack");
  assert.equal(parsePlateView("bogus"), "all");
  assert.equal(parsePlateView(null), "all");
  assert.ok(inPlateView(entry(), "all"));
  assert.ok(inPlateView(entry(), "needs-ack"));
  assert.ok(!inPlateView(entry(), "acked"));
  assert.ok(inPlateView(entry({ assignment: { status: "acked" } }), "acked"));
  assert.ok(inPlateView(entry(), "review"));
  assert.ok(!inPlateView(entry({ waitingOn: "author" }), "review"));
  assert.ok(!inPlateView(entry({ draft: true }), "review"));
  assert.ok(!inPlateView(entry({ state: "merged" }), "review"));
  assert.ok(!inPlateView(entry({ kind: "issue", waitingOn: null }), "review"));
  assert.ok(inPlateView(entry({ kind: "issue" }), "issues"));
  assert.ok(!inPlateView(entry(), "issues"));
});

test("quick views round-trip and reset owner/status constraints", async () => {
  const { focusFilters } = await import("./triage-presets");
  const { queueFiltersToParams } = await import("./triage-query");
  for (const focus of ["fires", "has-fix", "stale"] as const) {
    const filters = { ...parse("owner=alice&status=acked"), ...focusFilters(focus) };
    assert.equal(filters.owner, null);
    assert.equal(filters.status, "any");
    assert.deepEqual(parse(queueFiltersToParams(filters).toString()), filters);
    assert.equal(activePreset(filters), null);
    assert.ok(activeFilterCount(filters) > 0);
    assert.equal(presetFilters("review", filters).focus, null);
  }
  assert.equal(parse("focus=bogus&review=bogus").focus, null);
  assert.equal(parse("review=merge").review, "merge");
  assert.equal(parse("review=blocked").review, "blocked");
});
