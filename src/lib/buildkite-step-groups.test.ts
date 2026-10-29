import assert from "node:assert/strict";
import test from "node:test";
import { stepGroupsFromDeferred, stepGroupsFromPipeline } from "./buildkite-step-groups";

const PIPELINE = `
steps:
- group: ':heavy_plus_sign: Run more jobs'
  steps:
  - block: Run more jobs
    key: run-more-jobs
- label: bootstrap
  key: bootstrap
- group: Entrypoints
  steps:
  - label: ':nvidia: (H200 MIG 35GB) Entrypoints Integration (Responses API) Shard
      %N/%t'
    key: entrypoints-integration-responses-api
  - label: Unkeyed step
`;

test("maps grouped pipeline steps by key and label", () => {
  const groups = stepGroupsFromPipeline(PIPELINE);
  assert.equal(groups.byKey["entrypoints-integration-responses-api"], "Entrypoints");
  assert.equal(groups.byLabel["Unkeyed step"], "Entrypoints");
  assert.equal(groups.byKey["bootstrap"], undefined);
  assert.deepEqual(groups.order, [":heavy_plus_sign: Run more jobs", "Entrypoints"]);
});

test("adds deferred steps to an existing mapping", () => {
  const groups = stepGroupsFromDeferred(
    JSON.stringify({ steps: [{ group: "Abuild", step: { label: "Build CPU arm64 image", key: "cpu-arm64-image-build" } }] }),
    stepGroupsFromPipeline(PIPELINE),
  );
  assert.equal(groups.byKey["cpu-arm64-image-build"], "Abuild");
  assert.deepEqual(groups.order, [":heavy_plus_sign: Run more jobs", "Entrypoints", "Abuild"]);
});
