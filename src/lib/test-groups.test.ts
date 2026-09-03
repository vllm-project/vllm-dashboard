import assert from "node:assert/strict";
import test from "node:test";

import {
  getTestGroup,
  groupParametrizedTests,
  matchesTestQuery,
  stripParametrizedSuffix,
  type ParametrizedTestRecord,
} from "./test-groups";
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

function makeTest(overrides: Partial<ParametrizedTestRecord>): ParametrizedTestRecord {
  return {
    id: Math.random().toString(36).slice(2),
    name: "test_example",
    scope: null,
    file_name: "tests/test_example.py",
    location: "tests/test_example.py:1",
    labels: [],
    reliability: 1,
    duration_sum: 10,
    executions_count: 10,
    executions_count_by_result: { passed: 10, failed: 0 },
    ...overrides,
  };
}

test("strips the parametrized suffix from pytest names", () => {
  assert.equal(
    stripParametrizedSuffix("test_oai_triton_moe[256-8-1-float8]"),
    "test_oai_triton_moe",
  );
  assert.equal(stripParametrizedSuffix("test_plain"), "test_plain");
  assert.equal(stripParametrizedSuffix("test_bracket[unclosed"), "test_bracket[unclosed");
  assert.equal(stripParametrizedSuffix("test_trailing[param] "), "test_trailing");
});

test("groups variants of one parametrized test", () => {
  const variants = [
    makeTest({
      name: "test_oai_triton_moe[256-8]",
      reliability: 0.9,
      duration_sum: 100,
      executions_count: 20,
      executions_count_by_result: { passed: 18, failed: 2 },
      labels: ["flaky"],
    }),
    makeTest({
      name: "test_oai_triton_moe[128-4]",
      reliability: 0.5,
      duration_sum: 50,
      executions_count: 10,
      executions_count_by_result: { passed: 5, failed: 5 },
    }),
    makeTest({ name: "test_unrelated" }),
  ];

  const groups = groupParametrizedTests(variants);
  assert.equal(groups.length, 2);

  const group = groups[0];
  assert.equal(group.name, "test_oai_triton_moe");
  assert.equal(group.parametrized, true);
  assert.equal(group.tests.length, 2);
  assert.equal(group.reliability, 0.5); // worst variant wins
  assert.equal(group.executionsCount, 30);
  assert.equal(group.failedCount, 7);
  assert.equal(group.durationAvg, 150 / 30); // weighted by executions
  assert.deepEqual(group.labels, ["flaky"]);

  const single = groups[1];
  assert.equal(single.parametrized, false);
  assert.equal(single.tests.length, 1);
});

test("does not merge tests from different files or scopes", () => {
  const groups = groupParametrizedTests([
    makeTest({ name: "test_x[1]", file_name: "tests/a.py", location: "tests/a.py:1" }),
    makeTest({ name: "test_x[2]", file_name: "tests/b.py", location: "tests/b.py:1" }),
    makeTest({ name: "test_x[3]", file_name: "tests/a.py", location: "tests/a.py:1", scope: "TestOther" }),
  ]);
  assert.equal(groups.length, 3);
  assert.ok(groups.every((group) => !group.parametrized));
});

test("a single bracketed name is not treated as parametrized", () => {
  const groups = groupParametrizedTests([makeTest({ name: "test_lonely[1]" })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].parametrized, false);
});

test("null reliabilities only win when every variant is null", () => {
  const groups = groupParametrizedTests([
    makeTest({ name: "test_x[1]", reliability: null }),
    makeTest({ name: "test_x[2]", reliability: 0.8 }),
  ]);
  assert.equal(groups[0].reliability, 0.8);

  const allNull = groupParametrizedTests([
    makeTest({ name: "test_y[1]", reliability: null }),
    makeTest({ name: "test_y[2]", reliability: null }),
  ]);
  assert.equal(allNull[0].reliability, null);
});

test("matchesTestQuery matches name, scope, file, location and labels", () => {
  const test_ = makeTest({
    name: "test_oai_triton_moe[256-8]",
    scope: "tests/kernels",
    labels: ["flaky"],
  });
  assert.equal(matchesTestQuery(test_, "triton_moe"), true);
  assert.equal(matchesTestQuery(test_, "KERNELS"), true);
  assert.equal(matchesTestQuery(test_, "test_example.py"), true);
  assert.equal(matchesTestQuery(test_, "flaky"), true);
  assert.equal(matchesTestQuery(test_, ""), true);
  assert.equal(matchesTestQuery(test_, "unrelated"), false);
});
