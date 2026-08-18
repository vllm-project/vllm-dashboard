import assert from "node:assert/strict";
import test from "node:test";

import { getTestGroup } from "./test-groups";
import { buildTestAreaMapping } from "./test-areas";

const mapping = buildTestAreaMapping([
  {
    group: "Models - Language",
    steps: [
      {
        label:
          ":nvidia: (H200) Language Models (Extended Pooling) Shard %N",
      },
    ],
  },
]);

test("groups device-first labels without a device count", () => {
  assert.equal(
    getTestGroup(
      ":nvidia: (H200) Language Models (Extended Pooling) Shard 3",
      mapping,
    ),
    "Models - Language",
  );
});

test("keeps historical seed labels after a remote mapping refresh", () => {
  assert.equal(
    getTestGroup("Language Models Test (Extended Pooling)", mapping),
    "Models - Language",
  );
});

test("groups explicit and legacy AMD mirror labels", () => {
  assert.equal(
    getTestGroup(
      ":amd: (MI300) Language Models (Extended Pooling) Shard 3",
      mapping,
    ),
    "Hardware-AMD Tests",
  );
  assert.equal(
    getTestGroup(
      "AMD: Language Models Test (Extended Pooling) 3",
      mapping,
    ),
    "Hardware-AMD Tests",
  );
});
