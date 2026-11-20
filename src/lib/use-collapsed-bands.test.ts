import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COLLAPSED, parseCollapsed, toggleCollapsed } from "./use-collapsed-bands";

const KNOWN = ["page", "route", "watch", "ignore", "unscored"];

test("only P3 starts collapsed", () => {
  assert.deepEqual(DEFAULT_COLLAPSED, ["ignore"]);
});

test("toggling collapses and expands one group", () => {
  assert.deepEqual(toggleCollapsed(["ignore"], "page"), ["ignore", "page"]);
  assert.deepEqual(toggleCollapsed(["ignore", "page"], "page"), ["ignore"]);
});

test("stored choices are parsed safely", () => {
  assert.deepEqual(parseCollapsed('["page","bogus","watch"]', KNOWN), ["page", "watch"]);
  assert.equal(parseCollapsed(null, KNOWN), null);
  assert.equal(parseCollapsed("not json", KNOWN), null);
  assert.equal(parseCollapsed('{"page":true}', KNOWN), null);
  assert.deepEqual(parseCollapsed("[]", KNOWN), []);
});
