import assert from "node:assert/strict";
import test from "node:test";

import { classifyShardingJobs } from "./automatic-sharding";
import { computeParity, parseTestAreaFile } from "./gpu-parity";
import { computePlatformScope } from "./platform-scope";
import {
  buildOptionalJobMatcher,
  buildSoftFailJobMatcher,
  buildTestAreaMapping,
  isOptionalJob,
  isSoftFailJob,
  parseBuildkiteYaml,
  parseTestArea,
  type TestArea,
} from "./test-areas";

// The same jobs, written in the legacy `device` + `mirror` form and in the
// `devices:` form. Every reader must derive the same data from both.
const LEGACY = `
group: Kernels
depends_on:
  - image-build
steps:
- label: ":nvidia: (H100) [Nightly] Fused MoE Kernels"
  key: fused-moe-kernels
  device: h100
  optional: true
  automatic_shard: true
  timeout_in_minutes: 40
  source_file_dependencies:
    - vllm/model_executor/layers/fused_moe/
    - csrc/moe/
  commands:
    - pytest -v -s kernels/moe
  mirror:
    amd:
      label: ":amd: (MI355) Fused MoE Kernels"
      device: mi355_4
      optional: false
      automatic_shard: true
      depends_on:
        - image-build-amd
      commands:
        - pytest -v -s kernels/moe --ignore=kernels/moe/test_cutlass_moe.py
- label: ":nvidia: (H100) [Nightly] Fused MoE Kernels [eager]"
  key: fused-moe-kernels-eager
  device: h100
  optional: true
  automatic_shard: true
  env:
    VLLM_ENFORCE_EAGER: "1"
  commands:
    - pytest -v -s kernels/moe
- label: ":nvidia: (B200) Fused MoE Kernels"
  key: fused-moe-kernels-b200
  device: b200-k8s
  automatic_shard: true
  commands:
    - pytest -v -s kernels/moe
- label: ":nvidia: (H200 MIG 35GB) Ray Dependency Compatibility Check"
  key: ray-dependency-compatibility-check
  device: h200_35gb
  soft_fail: true
  parallelism: 2
  commands:
    - pytest ray
  mirror:
    amd:
      label: ":amd: (MI355 DPX) Ray Dependency Compatibility Check"
      device: mi355_dpx
      depends_on:
        - image-build-amd
- label: ":amd: (MI355) [Nightly] Fusion E2E TP2 AR-RMS (Inductor Partition)"
  key: fusion-e2e-tp2-ar-rms-inductor-partition-amd
  device: mi355_2
  optional: true
  automatic_shard: true
  depends_on:
    - image-build-amd
  commands:
    - pytest -v -s tests/compile/fusions_e2e/test_tp2_ar_rms.py
- label: ":computer: (CPU) V1 Others"
  key: v1-others-cpu
  device: cpu-small
  depends_on:
    - image-build-cpu
  commands:
    - pytest -v -s v1/core
`;

const DEVICES = `
group: Kernels
depends_on:
  - image-build
steps:
- label: Fused MoE Kernels
  key: fused-moe-kernels
  devices:
    h100:
      optional: true
      timeout_in_minutes: 40
      source_file_dependencies:
        - csrc/moe/
      commands:
        - pytest -v -s kernels/moe
      variants:
        eager:
          env:
            VLLM_ENFORCE_EAGER: "1"
    b200-k8s:
      same_as: h100
      optional: false
    mi355_4:
      commands:
        - pytest -v -s kernels/moe --ignore=kernels/moe/test_cutlass_moe.py
  automatic_shard: true
  source_file_dependencies:
    - vllm/model_executor/layers/fused_moe/
- label: Ray Dependency Compatibility Check
  key: ray-dependency-compatibility-check
  devices:
    h200_35gb:
      soft_fail: true
      parallelism: 2
    mi355_dpx:
      soft_fail: true
      parallelism: 2
  commands:
    - pytest ray
- label: Fusion E2E TP2 AR-RMS (Inductor Partition)
  key: fusion-e2e-tp2-ar-rms-inductor-partition
  devices:
    mi355_2:
      key: fusion-e2e-tp2-ar-rms-inductor-partition-amd
      optional: true
  automatic_shard: true
  commands:
    - pytest -v -s tests/compile/fusions_e2e/test_tp2_ar_rms.py
- label: V1 Others
  key: v1-others-cpu
  devices:
    cpu-small:
  commands:
    - pytest -v -s v1/core
`;

const PATH = ".buildkite/test_areas/kernels.yaml";

function files(text: string) {
  return [parseTestAreaFile(PATH, parseBuildkiteYaml(text))!];
}

function area(text: string): TestArea {
  return parseTestArea(parseBuildkiteYaml(text))!;
}

/** `amdMirrorExact` records the form, which is what the readers key off. */
function withoutForm(value: TestArea): TestArea {
  return {
    ...value,
    steps: value.steps.map((step) => {
      const copy = { ...step };
      delete copy.amdMirrorExact;
      return copy;
    }),
  };
}

test("both step forms give the same test-area jobs", () => {
  const legacy = area(LEGACY);
  const devices = area(DEVICES);
  assert.deepEqual(withoutForm(devices), legacy);
  assert.deepEqual(
    devices.steps.map((step) => step.label),
    [
      ":nvidia: (H100) [Nightly] Fused MoE Kernels",
      ":nvidia: (H100) [Nightly] Fused MoE Kernels [eager]",
      ":nvidia: (B200) Fused MoE Kernels",
      ":nvidia: (H200 MIG 35GB) Ray Dependency Compatibility Check",
      ":amd: (MI355) [Nightly] Fusion E2E TP2 AR-RMS (Inductor Partition)",
      ":computer: (CPU) V1 Others",
    ],
  );
  assert.equal(devices.steps[0].amdMirrorExact, true);
  assert.equal(legacy.steps[0].amdMirrorExact, undefined);
});

test("both step forms give the same matchers, mapping and sharding rows", () => {
  const legacy = [area(LEGACY)];
  const devices = [area(DEVICES)];
  assert.deepEqual(buildOptionalJobMatcher(devices), buildOptionalJobMatcher(legacy));
  assert.deepEqual(buildSoftFailJobMatcher(devices), buildSoftFailJobMatcher(legacy));
  assert.deepEqual(buildTestAreaMapping(devices), buildTestAreaMapping(legacy));
  assert.deepEqual(classifyShardingJobs(devices, []), classifyShardingJobs(legacy, []));

  const optional = buildOptionalJobMatcher(devices);
  // The NVIDIA step is nightly, its AMD job runs on every PR.
  assert.equal(isOptionalJob(":nvidia: (H100) [Nightly] Fused MoE Kernels", optional), true);
  assert.equal(isOptionalJob(":amd: (MI355) Fused MoE Kernels", optional), false);
  // A legacy mirror inherits soft_fail, as the generator does.
  assert.equal(
    isSoftFailJob(
      ":amd: (MI355 DPX) Ray Dependency Compatibility Check",
      buildSoftFailJobMatcher(legacy),
    ),
    true,
  );
  const sharding = classifyShardingJobs(devices, []);
  const amd = sharding.find((job) => job.label === ":amd: (MI355) Fused MoE Kernels");
  assert.equal(amd?.status, "flagged-not-run");
  assert.equal(amd?.platform, "amd");
  const ray = sharding.find(
    (job) => job.label === ":amd: (MI355 DPX) Ray Dependency Compatibility Check",
  );
  assert.equal(ray?.status, "fixed-split");
});

test("both step forms give the same parity and platform scope", () => {
  const legacy = files(LEGACY);
  const devices = files(DEVICES);
  assert.deepEqual(computeParity(devices), computeParity(legacy));
  assert.deepEqual(computePlatformScope(devices), computePlatformScope(legacy));

  const parity = computeParity(devices);
  assert.deepEqual(parity.summary.all, { nvidiaJobs: 4, mirroredJobs: 2, coverage: 0.5 });
  assert.deepEqual(parity.skipped.amdJobs, 1);
  assert.deepEqual(parity.skipped.cpuJobs, 1);
  const moe = parity.jobs.find((job) => job.key === "fused-moe-kernels");
  assert.deepEqual(moe?.mirror, {
    label: ":amd: (MI355) Fused MoE Kernels",
    device: "mi355_4",
    optional: false,
    softFail: false,
    gating: true,
  });

  const scope = computePlatformScope(devices);
  const amdOnly = scope.jobs.find(
    (job) => job.key === "fusion-e2e-tp2-ar-rms-inductor-partition-amd",
  );
  assert.equal(amdOnly?.vendor, "amd");
  assert.equal(amdOnly?.numDevices, 2);
  const common = scope.jobs.find((job) => job.key === "fused-moe-kernels");
  assert.equal(common?.source, "mirror");
  assert.equal(common?.amd?.key, "amd-fused-moe-kernels");
});

test("an exact mirror does not inherit the step's optional or soft_fail", () => {
  const [file] = files(`
group: G
steps:
- label: T
  key: t
  devices:
    h100:
      optional: true
      soft_fail: true
    mi300_1:
  commands:
    - a
`);
  const [job] = computeParity([file]).jobs;
  assert.equal(job.optional, true);
  assert.equal(job.softFail, true);
  assert.deepEqual(job.mirror, {
    label: ":amd: (MI300) T",
    device: "mi300_1",
    optional: false,
    softFail: false,
    gating: true,
  });
  const [step] = parseTestArea(
    parseBuildkiteYaml(`
group: G
steps:
- label: T
  key: t
  devices:
    h100:
      optional: true
      soft_fail: true
      automatic_shard: true
    mi300_1:
      automatic_shard: true
  commands:
    - a
`),
  )!.steps;
  assert.equal(step.amdMirrorOptional, undefined);
  assert.equal(step.amdMirrorSoftFail, undefined);
  // Only the AMD job's own flag decides whether it shards.
  const [, amd] = classifyShardingJobs(
    [{ group: "G", steps: [{ ...step, automaticShard: false }] }],
    [],
  );
  assert.equal(amd.status, "flagged-not-run");
});

test("a legacy mirror's own parallelism and num_nodes win over the step's", () => {
  const [own, inherited] = parseTestArea(
    parseBuildkiteYaml(`
group: G
steps:
- label: ":nvidia: (H100) T"
  key: t
  device: h100
  parallelism: 4
  num_nodes: 2
  num_devices: 2
  commands:
    - a
  mirror:
    amd:
      device: mi300_2
      parallelism: 1
      num_nodes: 1
- label: ":nvidia: (H100) U"
  key: u
  device: h100
  parallelism: 4
  num_nodes: 2
  num_devices: 2
  commands:
    - a
  mirror:
    amd:
      device: mi300_2
`),
  )!.steps;
  assert.equal(own.amdMirrorParallelism, 1);
  assert.equal(own.amdMirrorNumNodes, 1);
  assert.equal(inherited.amdMirrorParallelism, 4);
  assert.equal(inherited.amdMirrorNumNodes, 2);
});
