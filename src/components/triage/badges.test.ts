import assert from "node:assert/strict";
import test from "node:test";
import { kindIconStyle } from "./badges";

test("the kind icon follows GitHub's state colours", () => {
  const purple = /purple/, green = /green/, red = /red/, grey = /zinc/;
  // vllm-project/vllm#68597: an open, non-draft PR must not look merged.
  assert.deepEqual(kindIconStyle("pr", "open", false).label, "Open pull request");
  assert.match(kindIconStyle("pr", "open", false).tone, green);
  assert.match(kindIconStyle("pr", "open", true).tone, grey);
  assert.match(kindIconStyle("pr", "merged").tone, purple);
  assert.equal(kindIconStyle("pr", "merged", true).label, "Merged pull request");
  assert.match(kindIconStyle("pr", "closed").tone, red);
  assert.match(kindIconStyle("issue", "open").tone, green);
  assert.match(kindIconStyle("issue", "closed").tone, purple);
  // No state (e.g. the rules preview): reads as open.
  assert.equal(kindIconStyle("pr").label, "Open pull request");
});
