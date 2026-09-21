import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDevice,
  computeParity,
  countParity,
  parityJobFromStep,
  parseTestAreaFile,
  summarizeForHistory,
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
  assert.equal(plain.numNodes, 1);
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

  // 3 eligible NVIDIA jobs in Kernels + 2 in Miscellaneous. DeepGEMM is
  // excluded; CPU, no_gpu, and unknown are skipped separately.
  assert.equal(snapshot.summary.all.nvidiaJobs, 5);
  assert.equal(snapshot.summary.all.mirroredJobs, 3);
  assert.equal(snapshot.summary.all.coverage, 3 / 5);

  // Gating: attention (mirrored) and Regression (not).
  assert.equal(snapshot.summary.gating.nvidiaJobs, 2);
  assert.equal(snapshot.summary.gating.mirroredJobs, 1);
  assert.equal(snapshot.summary.gating.coverage, 1 / 2);

  assert.equal(snapshot.summary.nonGating.nvidiaJobs, 3);
  assert.equal(snapshot.summary.nonGating.mirroredJobs, 2);

  assert.deepEqual(
    snapshot.groups.map((group) => group.group),
    ["Kernels", "Miscellaneous"],
  );
  const kernelGroup = snapshot.groups[0];
  assert.equal(kernelGroup.file, kernels.path);
  assert.equal(kernelGroup.all.nvidiaJobs, 3);
  assert.equal(kernelGroup.gating.nvidiaJobs, 1);

  assert.deepEqual(snapshot.excluded, [{
    job: parityJobFromStep(kernels, kernels.steps[1]),
    reason: "DeepGEMM-specific job",
  }]);

  assert.equal(snapshot.skipped.cpuJobs, 2);
  assert.deepEqual(snapshot.skipped.unknown, [
    { label: "Mystery Hardware", device: "tpu_v6", file: misc.path },
  ]);

  // Jobs are ordered by file path so output is stable across refreshes.
  assert.equal(snapshot.jobs[0].file, kernels.path);
});

test("excludes job families case-insensitively in gating and all counts", () => {
  const file: TestAreaFile = {
    path: ".buildkite/test_areas/compile.yaml",
    group: "Compile",
    steps: [
      { label: ":nvidia: (L4) Distributed FlashInfer NixlConnector PD accuracy", device: "l4" },
      { label: ":nvidia: (H100) DEEPGEMM Kernels", device: "h100" },
      { label: ":nvidia: (H100) Fusion E2E TP2 asynctp Config Sweep", device: "h100" },
      { label: ":nvidia: (B200) AsyncTP Correctness", device: "b200", optional: true },
      { label: "flashinfer-kernels", soft_fail: true },
      { label: ":nvidia: (H100) Distributed Compile", device: "h100" },
    ],
  };
  const snapshot = computeParity([file]);
  assert.equal(snapshot.excluded.length, 5);
  assert.equal(snapshot.excluded.filter(({ job }) => job.gating).length, 3);
  assert.equal(snapshot.summary.all.nvidiaJobs, 1);
  assert.equal(snapshot.summary.gating.nvidiaJobs, 1);
  assert.deepEqual(snapshot.summary.nonGating, {
    nvidiaJobs: 0, mirroredJobs: 0, coverage: null,
  });
  assert.deepEqual(snapshot.jobs.map(({ label }) => label), [
    file.steps[5].label,
  ]);
  assert.equal(snapshot.groups[0].all.nvidiaJobs, 1);
  assert.deepEqual(summarizeForHistory(snapshot), {
    all: { nvidiaJobs: 1, mirroredJobs: 0, coverage: 0 },
    gating: { nvidiaJobs: 1, mirroredJobs: 0, coverage: 0 },
  });
});

test("retains explicit AMD mirrors even when their NVIDIA labels match exclusions", () => {
  const file: TestAreaFile = {
    path: "mirrors.yaml",
    group: "Mirrors",
    steps: ["FlashInfer", "DeepGEMM", "AsyncTP", "Humming", "Spark", "B200", "NIXL-EP", "Fault Tolerance E2E", "Fusion E2E"].map((family) => ({
      label: `:nvidia: (H100) ${family} Integration`,
      device: "h100",
      mirror: { amd: { device: "mi300_1", optional: true } },
    })),
  };
  const snapshot = computeParity([file]);
  assert.deepEqual(snapshot.excluded, []);
  assert.deepEqual(snapshot.summary.gating, {
    nvidiaJobs: 9, mirroredJobs: 9, coverage: 1,
  });
  assert.ok(snapshot.jobs.every((job) => job.mirror?.gating === false));
});

test("retains shared families and matches labels rather than areas, keys or commands", () => {
  const labels = [
    ":nvidia: (H100) Distributed Compile",
    ":nvidia: (H100) Fusion and Compile",
    ":nvidia: (H100) Fusion Passes",
    ":nvidia: (H100) MLA Kernel Test",
    ":nvidia: (H100) DeepSeek V4 Kernels",
    ":nvidia: (H100) Miscellaneous Kernels",
    ":nvidia: (H200) Kimi K3",
    ":nvidia: (H200) Inkling",
    ":nvidia: (L4) PyTorch Fullgraph CUDAGraph Compatibility",
    ":nvidia: (H100) AITER Fusion",
    ":nvidia: (H100) Fault Tolerance Unit Tests",
    ":nvidia: (H100) NixlConnector PD accuracy",
    "DeepGEMMish", // A partial word is not the family name.
    "Hummingbird",
    "Sparkling Attention",
    "AsyncTPish",
  ];
  const snapshot = computeParity([{
    path: "flashinfer.yaml",
    group: "FlashInfer / DeepGEMM / AsyncTP",
    steps: labels.map((label) => ({
      label,
      device: "h100",
      key: "deepgemm",
      commands: ["pytest tests/distributed/test_flashinfer_workspace.py"],
    })),
  }]);
  assert.deepEqual(snapshot.excluded, []);
  assert.deepEqual(snapshot.jobs.map(({ label }) => label), labels);
  assert.equal(snapshot.summary.all.nvidiaJobs, labels.length);
});

test("excludes unsupported families and hardware scope without depending on label formatting", () => {
  const snapshot = computeParity([{
    path: "scope.yaml",
    group: "Mixed",
    steps: [
      { label: "LM Eval HUMMING", device: "h100" },
      { label: "AsyncTP Correctness", device: "h100" },
      { label: "Spark GPQA", device: "h100" },
      { label: "GPQA", device: "dgx-spark" },
      { label: "Generic Kernels", device: "b200-k8s" },
      { label: "Generic Eval", device: "B200" },
      { label: ":nvidia: (2xB200) Kernels", device: "h100" },
      { label: "NIXL_EP transport", device: "h100" },
      { label: "Fault Tolerance E2E", device: "h100" },
      { label: ":nvidia: (H100) Fusion E2E TP2 AR-RMS Config Sweep", device: "h100" },
      { label: ":nvidia: (H100) E2E Fusion Quick", device: "h100" },
    ],
  }]);
  assert.equal(snapshot.excluded.length, 11);
  assert.equal(snapshot.summary.all.nvidiaJobs, 0);
  assert.deepEqual(snapshot.groups, []);
});

test("one mirrored hardware variant removes duplicate gaps regardless of input order", () => {
  const steps = [
    { label: ":nvidia: (A100) Batch Invariance", device: "a100", key: "a100" },
    { label: ":nvidia: (H100) Batch Invariance Shard %N", device: "h100", key: "h100",
      mirror: { amd: { device: "mi300_1" } } },
    { label: ":nvidia: (H200 MIG 35GB) Batch Invariance", device: "h200_35gb", key: "h200" },
  ];
  for (const ordered of [steps, [...steps].reverse()]) {
    const snapshot = computeParity([{ path: "misc.yaml", group: "Misc", steps: ordered }]);
    assert.deepEqual(snapshot.jobs.map((job) => job.key), ["h100"]);
    assert.equal(snapshot.excluded.length, 2);
    assert.ok(snapshot.excluded.every(({ reason }) => reason.includes("Hardware variant of mirrored job")));
    assert.deepEqual(summarizeForHistory(snapshot), {
      all: { nvidiaJobs: 1, mirroredJobs: 1, coverage: 1 },
      gating: { nvidiaJobs: 1, mirroredJobs: 1, coverage: 1 },
    });
  }
});

test("duplicate matching preserves topology, scenarios, areas and explicit platform choices", () => {
  const snapshot = computeParity([
    { path: "one.yaml", group: "First", steps: [
      { label: ":nvidia: (H100) Shared Test", device: "h100", mirror: { amd: { device: "mi300_1" } } },
      { label: ":nvidia: (H200) Shared Test", device: "h200", mirror: { amd: { device: "mi355_1" } } },
      { label: ":nvidia: (A100) Shared Test", device: "a100", num_devices: 2 },
      { label: ":nvidia: (A100) Shared Test", device: "a100", num_nodes: 2 },
      { label: ":nvidia: (A100) Shared Test Large Memory", device: "a100" },
    ] },
    { path: "two.yaml", group: "Second", steps: [
      { label: ":nvidia: (A100) Shared Test", device: "a100" },
      { label: ":nvidia: (H200) Unmirrored Test", device: "h200" },
      { label: ":nvidia: (A100) Unmirrored Test", device: "a100" },
    ] },
  ]);
  assert.equal(snapshot.jobs.length, 8);
  assert.deepEqual(snapshot.excluded, []);
});

test("duplicate matching requires different hardware within the same source file", () => {
  const snapshot = computeParity([
    { path: "one.yaml", group: "Same area", steps: [
      { label: ":nvidia: (H100) Shared", device: "h100", mirror: { amd: { device: "mi300_1" } } },
      { label: ":nvidia: (H100) Shared", device: "h100" },
      { label: "Shared", device: undefined },
    ] },
    { path: "two.yaml", group: "Same area", steps: [
      { label: ":nvidia: (A100) Shared", device: "a100" },
    ] },
  ]);
  assert.equal(snapshot.jobs.length, 4);
  assert.deepEqual(snapshot.excluded, []);
});

test("omits areas containing only excluded jobs and preserves vendor accounting", () => {
  const snapshot = computeParity([{
    path: "only-excluded.yaml",
    group: "Implementation tests",
    steps: [
      { label: "DeepGEMM Kernels", device: "h100" },
      { label: "FlashInfer lint", device: "cpu-small" },
      { label: "AsyncTP AMD", device: "mi300_1" },
      { label: "FlashInfer other", device: "intel_gpu" },
      { label: "DeepGEMM unknown", device: "tpu_v6" },
    ],
  }]);
  assert.deepEqual(snapshot.jobs, []);
  assert.deepEqual(snapshot.groups, []);
  assert.deepEqual(snapshot.summary.all, countParity([]));
  assert.deepEqual(snapshot.summary.gating, countParity([]));
  assert.equal(snapshot.excluded.length, 1);
  assert.equal(snapshot.skipped.cpuJobs, 1);
  assert.equal(snapshot.skipped.amdJobs, 1);
  assert.equal(snapshot.skipped.otherJobs, 1);
  assert.equal(snapshot.skipped.unknown.length, 1);
});
