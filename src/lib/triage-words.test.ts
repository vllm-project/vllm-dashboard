import assert from "node:assert/strict";
import test from "node:test";
import { RELEVANCE_MEANING, actionText, extractionText, percentText, scopeText, sourceText, yesNo } from "./triage-words";

test("actions and sources read as sentences", () => {
  assert.equal(actionText("ack", null), "acknowledged it");
  assert.equal(actionText("not_mine", null), "said “not mine”");
  assert.equal(actionText("reassign", "gau-nernst"), "reassigned it to gau-nernst");
  assert.equal(actionText("drop", null), "dropped it");
  assert.equal(actionText("slop", null), "marked it as slop");
  assert.equal(actionText("done", null), "marked it done");
  assert.equal(actionText("reopen", null), "reopened it");
  assert.equal(actionText("brand_new", null), "brand new");
  assert.equal(sourceText("slack"), "from Slack");
  assert.equal(sourceText("dashboard"), "on the dashboard");
  assert.equal(sourceText("other"), "other");
});

test("statuses, relevance, scope", () => {
  assert.equal(extractionText("pending"), "waiting for the LLM to read it");
  assert.equal(extractionText("failed"), "the LLM read failed; it will be retried");
  for (const level of ["high", "medium", "low", "none"]) assert.ok(RELEVANCE_MEANING[level]);
  assert.match(RELEVANCE_MEANING.medium, /Routed/);
  assert.match(RELEVANCE_MEANING.low, /Never routed/);
  assert.equal(scopeText("pr_external"), "a PR from an outside contributor");
  assert.equal(scopeText(undefined), null);
  assert.equal(yesNo(true), "yes");
  assert.equal(yesNo(null), "unknown");
  assert.equal(percentText(0.824), "82%");
  assert.equal(percentText(undefined), "—");
});
