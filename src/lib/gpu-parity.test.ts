import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDevice,
  computeParity,
  countParity,
  parityJobFromStep,
  parseTestAreaFile,
  type TestAreaFile,
} from "./gpu-parity";

test("classifies devices by the generator's device names first", () => {
  assert.equal(classifyDevice("h200_35gb", "anything"), "nvidia");
  assert.equal(classifyDevice("b200-k8s", ":computer: mislabelled"), "nvidia");
  assert.equal(classifyDevice("L4", ""), "nvidia");
  assert.equal(classifyDevice("cpu-small", ":nvidia: mislabelled"), "cpu");
  assert.equal(classifyDevice("mi300_2", ""), "amd");
  assert.equal(classifyDevice("intel_hpu", ""), "other");
});

test("falls back to the label shortcode for unknown devices", () => {
  assert.equal(classifyDevice("gb300", ":nvidia: (GB300) New Kernels"), "nvidia");
  assert.equal(classifyDevice(undefined, ":amd: (MI400) Something"), "amd");
  assert.equal(classifyDevice(null, ":computer: (CPU) Lint"), "cpu");
  assert.equal(classifyDevice("tpu_v6", "TPU Smoke"), "unknown");
});

test("legacy steps without a device ran on the default NVIDIA queue", () => {
  // Pre-2026-06 test_areas files had neither `device` nor a shortcode.
  assert.equal(classifyDevice(undefined, "Kernels Core Operation Test"), "nvidia");
  assert.equal(
    classifyDevice(undefined, "Acceptance Length Test", { gpu: "h100" }),
    "nvidia",
  );
  assert.equal(
    classifyDevice(undefined, "Python-only Installation", { noGpu: true }),
    "cpu",
  );
  assert.equal(classifyDevice(undefined, ":docker: Build image"), "cpu");
  assert.equal(classifyDevice(undefined, "Documentation Build"), "cpu");
  // A device the generator does not know is still surfaced, not defaulted.
  assert.equal(classifyDevice("tpu_v6", "TPU Smoke", { gpu: "h100" }), "nvidia");
  assert.equal(classifyDevice("tpu_v6", "TPU Smoke", { noGpu: true }), "cpu");
});

test("parses a test area file and drops steps without labels", () => {
  const file = parseTestAreaFile(".buildkite/test_areas/x.yaml", {
    group: " Kernels ",
    steps: [{ label: "a" }, { nope: true }, null, { label: "b" }],
  });
  assert.equal(file?.group, "Kernels");
  assert.equal(file?.steps.length, 2);
  assert.equal(parseTestAreaFile("x", { steps: [] }), null);
  assert.equal(parseTestAreaFile("x", { group: "G" }), null);
  assert.equal(parseTestAreaFile("x", "group: G"), null);
});

const kernels: TestAreaFile = {
  path: ".buildkite/test_areas/kernels.yaml",
  group: "Kernels",
  steps: [
    {
      label: ":nvidia: (L4) Attention Kernels Shard %N",
      key: "kernels-attention-test",
      device: "l4",
      parallelism: 7,
      mirror: {
        amd: { label: ":amd: (MI300) Attention Kernels Shard %N", device: "mi300_1" },
      },
    },
    {
      label: ":nvidia: (H100) DeepGEMM Kernels",
      key: "kernels-deepgemm-test-h100",
      device: "h100",
      num_devices: 1,
    },
    {
      label: ":nvidia: (H100) FP8 MoE Kernels",
      key: "kernels-fp8-moe-test-1xh100",
      device: "h100",
      optional: true,
    },
    {
      label: ":nvidia: (B200) Soft Kernels",
      key: "kernels-soft",
      device: "b200-k8s",
      soft_fail: true,
      mirror: { amd: { label: ":amd: (MI355) Soft Kernels", device: "mi355_1" } },
    },
    {
      label: ":computer: (CPU) Kernel Lint",
      key: "kernel-lint",
      device: "cpu-small",
    },
  ],
};

const misc: TestAreaFile = {
  path: ".buildkite/test_areas/misc.yaml",
  group: "Miscellaneous",
  steps: [
    {
      label: ":nvidia: (H200 MIG 35GB) LM Eval Small Models",
      key: "lm-eval-small",
      device: "h200_35gb",
      optional: true,
      autorun_on_main: true,
      mirror: {
        amd: {
          label: ":amd: (MI300) LM Eval Small Models",
          device: "mi300_1",
          optional: false,
        },
      },
    },
    { label: "Mystery Hardware", key: "mystery", device: "tpu_v6" },
    // Legacy shape: no device, no shortcode, so it ran on the default GPU queue.
    { label: "Regression", key: "regression" },
    { label: "Python-only Installation", key: "python-only", no_gpu: true },
  ],
};

test("a mirror inherits optional and soft_fail from its parent unless overridden", () => {
  const soft = parityJobFromStep(kernels, kernels.steps[3]);
  assert.equal(soft.gating, false);
  assert.equal(soft.mirror?.softFail, true);
  assert.equal(soft.mirror?.gating, false);

  const overridden = parityJobFromStep(misc, misc.steps[0]);
  assert.equal(overridden.optional, true);
  assert.equal(overridden.autorunOnMain, true);
  assert.equal(overridden.mirror?.optional, false);
  assert.equal(overridden.mirror?.gating, true);

  const plain = parityJobFromStep(kernels, kernels.steps[0]);
  assert.equal(plain.parallelism, 7);
  assert.equal(plain.numDevices, 1);
  assert.equal(plain.mirror?.device, "mi300_1");
});

test("a mirror block without a label gets the generator's default label", () => {
  const job = parityJobFromStep(kernels, {
    label: ":nvidia: (L4) Bare Mirror",
    device: "l4",
    mirror: { amd: { device: "mi250_1" } },
  });
  assert.equal(job.mirror?.label, "AMD: :nvidia: (L4) Bare Mirror");
});

test("counts coverage and reports null coverage with no NVIDIA jobs", () => {
  assert.deepEqual(countParity([]), {
    nvidiaJobs: 0,
    mirroredJobs: 0,
    coverage: null,
  });
});

test("computes overall, gating, and per-group parity", () => {
  const snapshot = computeParity([misc, kernels]);

  // 4 NVIDIA jobs in Kernels + 2 in Miscellaneous (LM Eval and the legacy
  // device-less Regression step); CPU, no_gpu, and unknown are skipped.
  assert.equal(snapshot.summary.all.nvidiaJobs, 6);
  assert.equal(snapshot.summary.all.mirroredJobs, 3);
  assert.equal(snapshot.summary.all.coverage, 0.5);

  // Gating: attention (mirrored), deepgemm and Regression (not).
  assert.equal(snapshot.summary.gating.nvidiaJobs, 3);
  assert.equal(snapshot.summary.gating.mirroredJobs, 1);
  assert.equal(snapshot.summary.gating.coverage, 1 / 3);

  assert.equal(snapshot.summary.nonGating.nvidiaJobs, 3);
  assert.equal(snapshot.summary.nonGating.mirroredJobs, 2);

  assert.deepEqual(
    snapshot.groups.map((group) => group.group),
    ["Kernels", "Miscellaneous"],
  );
  const kernelGroup = snapshot.groups[0];
  assert.equal(kernelGroup.file, kernels.path);
  assert.equal(kernelGroup.all.nvidiaJobs, 4);
  assert.equal(kernelGroup.gating.nvidiaJobs, 2);

  assert.equal(snapshot.skipped.cpuJobs, 2);
  assert.deepEqual(snapshot.skipped.unknown, [
    { label: "Mystery Hardware", device: "tpu_v6", file: misc.path },
  ]);

  // Jobs are ordered by file path so output is stable across refreshes.
  assert.equal(snapshot.jobs[0].file, kernels.path);
});
