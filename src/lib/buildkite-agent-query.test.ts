import assert from "node:assert/strict";
import test from "node:test";

import { queueKeyFromAgentQueryRules } from "./buildkite-agent-query";

test("queueKeyFromAgentQueryRules extracts the Kubernetes queue tag", () => {
  assert.equal(
    queueKeyFromAgentQueryRules(["docker=true", "queue=l4-k8s"]),
    "l4-k8s",
  );
});

test("queueKeyFromAgentQueryRules ignores missing and unrelated rules", () => {
  assert.equal(queueKeyFromAgentQueryRules(undefined), null);
  assert.equal(queueKeyFromAgentQueryRules(["docker=true", "queue="]), null);
  assert.equal(queueKeyFromAgentQueryRules(["notqueue=l4-k8s"]), null);
});
