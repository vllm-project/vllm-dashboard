import assert from "node:assert/strict";
import test from "node:test";

import { getTestGroup } from "./test-groups";
import {
  buildTestAreaMapping,
  discoverGroupYamlPaths,
} from "./test-areas";

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
  {
    group: "Model Runner V2",
    steps: [
      {
        label: ":nvidia: (H200 MIG 35GB) Model Runner V2 Spec Decode %N",
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

test("groups a test area that exists only in a branch commit", () => {
  assert.equal(
    getTestGroup(
      ":nvidia: (H200 MIG 35GB) Model Runner V2 Spec Decode 4",
      mapping,
    ),
    "Model Runner V2",
  );
});

test("discovers group YAML recursively from every configured job directory", () => {
  assert.deepEqual(
    discoverGroupYamlPaths(
      [
        { path: ".buildkite/test_areas/engine.yaml", type: "blob" },
        {
          path: ".buildkite/hardware_tests/intel_xpu_ci/test-intel.yaml",
          type: "blob",
        },
        { path: ".buildkite/image_build/image_build.yaml", type: "blob" },
        { path: ".buildkite/lm-eval-harness/model.yaml", type: "blob" },
        { path: ".buildkite/test_areas/archive", type: "tree" },
      ],
      [
        {
          job_dirs: [
            ".buildkite/image_build",
            ".buildkite/test_areas",
            ".buildkite/hardware_tests",
          ],
        },
      ],
    ),
    [
      ".buildkite/hardware_tests/intel_xpu_ci/test-intel.yaml",
      ".buildkite/image_build/image_build.yaml",
      ".buildkite/test_areas/engine.yaml",
    ],
  );
});
