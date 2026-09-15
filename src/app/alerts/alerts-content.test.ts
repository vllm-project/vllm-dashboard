import assert from "node:assert/strict";
import test from "node:test";
import { resolveAlertTab } from "./alerts-content";

test("Failures is the default alert tab", () => {
  assert.equal(resolveAlertTab(null), "main-ci");
  assert.equal(resolveAlertTab("unknown"), "main-ci");
});

test("explicit alert tabs remain selected", () => {
  assert.equal(resolveAlertTab("main-ci"), "main-ci");
  assert.equal(resolveAlertTab("fast-ci"), "fast-ci");
  assert.equal(resolveAlertTab("infra"), "infra");
});
