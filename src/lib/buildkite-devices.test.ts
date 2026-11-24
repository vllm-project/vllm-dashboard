import assert from "node:assert/strict";
import test from "node:test";

import {
  compileDeviceStep,
  defaultKeys,
  DeviceStepError,
  expandSteps,
  resolveStep,
} from "./buildkite-devices";
import { parseBuildkiteYaml } from "./test-areas";

function step(yamlText: string): Record<string, unknown> {
  return parseBuildkiteYaml(yamlText) as Record<string, unknown>;
}

function raises(code: string, raw: unknown, pattern?: RegExp) {
  assert.throws(
    () => resolveStep(raw),
    (error: unknown) =>
      error instanceof DeviceStepError &&
      error.code === code &&
      (!pattern || pattern.test(error.message)),
  );
}

const ATTENTION = `
label: V1 Attention
key: v1-attention-h100-mi300
devices:
  h100:
    timeout_in_minutes: 85
    source_file_dependencies:
      - vllm/v1/hisparse/
    commands:
      - pytest -v -s v1/attention
  mi300_1:
    timeout_in_minutes: 125
    source_file_dependencies:
      - vllm/platforms/rocm.py
    commands:
      - pytest -v -s v1/attention --ignore=v1/attention/test_mla_backends.py
automatic_shard: true
source_file_dependencies:
  - vllm/v1/attention
  - tests/v1/attention
`;

test("an NVIDIA + AMD step compiles to a step with an exact AMD mirror", () => {
  const compiled = compileDeviceStep(step(ATTENTION), ["image-build"]);
  assert.equal(compiled.length, 1);
  assert.deepEqual(compiled[0], {
    label: ":nvidia: (H100) V1 Attention",
    key: "v1-attention-h100-mi300",
    device: "h100",
    automatic_shard: true,
    source_file_dependencies: [
      "vllm/v1/attention",
      "tests/v1/attention",
      "vllm/v1/hisparse/",
    ],
    timeout_in_minutes: 85,
    commands: ["pytest -v -s v1/attention"],
    mirror: {
      amd: {
        label: ":amd: (MI300) V1 Attention",
        device: "mi300_1",
        automatic_shard: true,
        source_file_dependencies: [
          "vllm/v1/attention",
          "tests/v1/attention",
          "vllm/platforms/rocm.py",
        ],
        timeout_in_minutes: 125,
        commands: [
          "pytest -v -s v1/attention --ignore=v1/attention/test_mla_backends.py",
        ],
        depends_on: ["image-build-amd"],
        dind: false,
        num_devices: 1,
        _exact: true,
      },
    },
  });
});

test("same_as copies an earlier same-vendor sibling; further devices get key tags", () => {
  const jobs = resolveStep(
    step(`
label: Fused MoE Kernels
key: fused-moe-kernels
devices:
  h100:
    timeout_in_minutes: 40
    source_file_dependencies:
      - csrc/moe/
    env:
      A: "1"
    commands:
      - pytest -v -s kernels/moe
    variants:
      eager:
        env:
          VLLM_ENFORCE_EAGER: "1"
  b200-k8s:
    same_as: h100
    timeout_in_minutes: 30
    source_file_dependencies:
      - csrc/moe/b200/
    env:
      B: "2"
  mi355_1:
    timeout_in_minutes: 60
    commands:
      - pytest -v -s kernels/moe --ignore=kernels/moe/test_cutlass_moe.py
  mi300_1:
    same_as: mi355_1
source_file_dependencies:
  - vllm/model_executor/layers/fused_moe/
`),
  );
  assert.deepEqual(
    jobs.map((job) => [job.key, job.device, job.label]),
    [
      ["fused-moe-kernels", "h100", ":nvidia: (H100) Fused MoE Kernels"],
      [
        "fused-moe-kernels-eager",
        "h100",
        ":nvidia: (H100) Fused MoE Kernels [eager]",
      ],
      ["fused-moe-kernels-b200", "b200-k8s", ":nvidia: (B200) Fused MoE Kernels"],
      ["amd-fused-moe-kernels", "mi355_1", ":amd: (MI355) Fused MoE Kernels"],
      ["amd-fused-moe-kernels-mi300", "mi300_1", ":amd: (MI300) Fused MoE Kernels"],
    ],
  );
  const b200 = jobs[2].fields;
  // Dependencies add, env merges, written scalars replace; variants are not copied.
  assert.deepEqual(b200.source_file_dependencies, [
    "vllm/model_executor/layers/fused_moe/",
    "csrc/moe/",
    "csrc/moe/b200/",
  ]);
  assert.deepEqual(b200.env, { A: "1", B: "2" });
  assert.equal(b200.timeout_in_minutes, 30);
  assert.deepEqual(b200.commands, ["pytest -v -s kernels/moe"]);
  assert.equal(jobs.filter((job) => job.device === "b200-k8s").length, 1);
  assert.equal(jobs[4].fields.timeout_in_minutes, 60);

  // The variant starts from the resolved h100 job.
  assert.deepEqual(jobs[1].fields.env, { A: "1", VLLM_ENFORCE_EAGER: "1" });
  assert.equal(jobs[1].fields.timeout_in_minutes, 40);

  // Only h100 + mi355_1 pair; the rest are steps of their own.
  const compiled = compileDeviceStep(
    step(`
label: Fused MoE Kernels
key: fused-moe-kernels
devices:
  h100:
    commands:
      - a
    variants:
      eager:
        commands:
          - b
  b200-k8s:
    same_as: h100
  mi355_1:
    commands:
      - c
  mi300_1:
    same_as: mi355_1
`),
  );
  assert.deepEqual(
    compiled.map((entry) => [
      entry.key,
      entry.device,
      (entry.mirror as { amd?: { device?: string } } | undefined)?.amd?.device ?? null,
    ]),
    [
      ["fused-moe-kernels", "h100", "mi355_1"],
      ["fused-moe-kernels-eager", "h100", null],
      ["fused-moe-kernels-b200", "b200-k8s", null],
      ["amd-fused-moe-kernels-mi300", "mi300_1", null],
    ],
  );
  assert.deepEqual(compiled[1].commands, ["b"]);
  assert.deepEqual(compiled[3].commands, ["c"]);
});

test("variants replace what they name, add deps, and may pin a key or label", () => {
  const jobs = resolveStep(
    step(`
label: V1 Attention
key: v1-attention
devices:
  h100:
    key: v1-attention-pinned
    timeout_in_minutes: 85
    variants:
      extended:
        timeout_in_minutes: 90
        optional: true
        commands:
          - pytest -v -s --runslow v1/attention
        source_file_dependencies:
          - tests/slow/
      renamed:
        key: attention-renamed
        label: Attention Renamed
        env:
          X: "1"
commands:
  - pytest -v -s v1/attention
source_file_dependencies:
  - vllm/v1/attention
`),
  );
  assert.deepEqual(
    jobs.map((job) => [job.key, job.label]),
    [
      ["v1-attention-pinned", ":nvidia: (H100) V1 Attention"],
      [
        "v1-attention-pinned-extended",
        ":nvidia: (H100) [Nightly] V1 Attention [extended]",
      ],
      ["attention-renamed", ":nvidia: (H100) Attention Renamed"],
    ],
  );
  assert.deepEqual(jobs[1].fields.commands, ["pytest -v -s --runslow v1/attention"]);
  assert.deepEqual(jobs[1].fields.source_file_dependencies, [
    "vllm/v1/attention",
    "tests/slow/",
  ]);
  assert.equal(jobs[1].fields.timeout_in_minutes, 90);
  assert.equal(jobs[2].fields.timeout_in_minutes, 85);
});

test("an AMD-only step is a standalone step with the registry's plumbing", () => {
  const compiled = compileDeviceStep(
    step(`
label: Fusion E2E TP2 AR-RMS (Inductor Partition)
key: fusion-e2e-tp2-ar-rms-inductor-partition
devices:
  mi355_2:
    key: fusion-e2e-tp2-ar-rms-inductor-partition-amd
    optional: true
    timeout_in_minutes: 65
  mi355_dpx:
    soft_fail: true
depends_on:
  - some-other-step
working_dir: /vllm-workspace/
commands:
  - pytest -v -s tests/compile/fusions_e2e/test_tp2_ar_rms.py
`),
    ["image-build"],
  );
  assert.deepEqual(
    compiled.map((entry) => [
      entry.key,
      entry.label,
      entry.device,
      entry.num_devices,
      entry.dind,
      entry.depends_on,
      entry.mirror,
    ]),
    [
      [
        "fusion-e2e-tp2-ar-rms-inductor-partition-amd",
        ":amd: (MI355) [Nightly] Fusion E2E TP2 AR-RMS (Inductor Partition)",
        "mi355_2",
        2,
        false,
        ["image-build-amd", "some-other-step"],
        undefined,
      ],
      [
        "amd-fusion-e2e-tp2-ar-rms-inductor-partition-mi355-dpx",
        ":amd: (MI355 DPX) Fusion E2E TP2 AR-RMS (Inductor Partition)",
        "mi355_dpx",
        1,
        false,
        ["image-build-amd", "some-other-step"],
        undefined,
      ],
    ],
  );
  assert.equal(compiled[1].soft_fail, true);
});

test("a CPU step gets image-build-cpu unless the file builds no image", () => {
  const raw = step(`
label: V1 Others
key: v1-others-cpu
devices:
  cpu-small:
commands:
  - pytest -v -s v1/core
if: build.branch == "main"
`);
  const [compiled] = compileDeviceStep(raw, ["image-build"]);
  assert.deepEqual(compiled, {
    if: 'build.branch == "main"',
    label: ":computer: (CPU) V1 Others",
    key: "v1-others-cpu",
    device: "cpu-small",
    commands: ["pytest -v -s v1/core"],
    depends_on: ["image-build-cpu"],
  });
  assert.deepEqual(compileDeviceStep(raw, [])[0].depends_on, []);
  // NVIDIA jobs leave depends_on to the file unless the step adds one.
  const [nvidia] = compileDeviceStep(
    step(`
label: X
key: x
devices:
  l4:
depends_on:
  - other
commands:
  - a
`),
    ["image-build"],
  );
  assert.deepEqual(nvidia.depends_on, ["image-build", "other"]);
});

test("default keys follow map order per vendor side", () => {
  assert.deepEqual(
    [
      ...defaultKeys("k", [
        ["mi355_1", null],
        ["h200_35gb", null],
        ["mi300_dpx", null],
        ["cpu-small", null],
        ["b200-k8s", "pinned"],
      ]),
    ],
    [
      ["mi355_1", "amd-k"],
      ["h200_35gb", "k"],
      ["mi300_dpx", "amd-k-mi300-dpx"],
      ["cpu-small", "k-cpu"],
      ["b200-k8s", "pinned"],
    ],
  );
});

test("steps that break a rule raise the generator's error codes", () => {
  const base = { label: "T", key: "t" };
  raises("E1", { ...base, devices: { tpu: null } }, /not in the device registry/);
  raises("E1", {
    ...base,
    devices: { h100: { commands: ["a"], variants: { Bad_Name: { optional: true } } } },
  });
  raises("E2", { ...base, devices: { h100: { device: "h100" } } });
  raises("E2", { ...base, devices: { h100: { mirror: {} } } });
  raises("E2", { label: ":nvidia: (H100) T", key: "t", devices: { h100: null } });
  raises("E2", { ...base, depends_on: ["image-build"], devices: { h100: null } });
  raises("E2", { ...base, devices: { h100: { comands: ["a"] } } }, /unknown field/);
  raises("E3", {
    ...base,
    commands: ["a"],
    devices: { h100: { commands: ["b"] } },
  });
  raises("E3", {
    ...base,
    source_file_dependencies: ["x/"],
    devices: { h100: { source_file_dependencies: ["x/"] } },
  });
  raises("E4", { ...base, timeout_in_minutes: 5, devices: { h100: null } });
  raises("E5", {
    ...base,
    devices: { h100: { commands: ["a"] }, mi355_1: { same_as: "h100" } },
  });
  raises("E5", {
    ...base,
    devices: { b200: { same_as: "h100" }, h100: { commands: ["a"] } },
  });
  raises("E5", {
    ...base,
    devices: {
      h100: { commands: ["a"] },
      b200: { same_as: "h100" },
      l4: { same_as: "b200" },
    },
  });
  raises("E6", { ...base, devices: { h100: { variants: { eager: {} } } } });
  raises("E6", {
    ...base,
    devices: { h100: { optional: true, variants: { again: { optional: true } } } },
  });
  raises("E7", { ...base, devices: { mi355_4: { num_devices: 4 } } });
  raises("E8", { ...base, devices: { mi355_1: null, mi355_4: null } });
  raises("E8", {
    ...base,
    devices: { h100: { variants: { x: { key: "t", optional: true } } } },
  });
  // A pin resolves the key_tag collision.
  assert.equal(
    resolveStep({ ...base, devices: { mi355_1: null, mi355_4: { key: "t-4" } } })
      .length,
    2,
  );
});

test("expandSteps keeps legacy steps and drops (and reports) a broken one", () => {
  const legacy = { label: ":nvidia: (H100) Legacy", key: "legacy", device: "h100" };
  const errors: string[] = [];
  const expanded = expandSteps(
    [
      legacy,
      { label: "Broken", key: "broken", devices: { tpu: null } },
      { label: "Ok", key: "ok", devices: { "cpu-small": null } },
      { label: "Hand-written exact", key: "x", mirror: { amd: { _exact: true } } },
    ],
    ["image-build"],
    (error) => errors.push(error.code),
  );
  assert.equal(expanded.length, 2);
  assert.equal(expanded[0], legacy);
  assert.equal((expanded[1] as { key: string }).key, "ok");
  assert.deepEqual(errors, ["E1", "E2"]);
});
