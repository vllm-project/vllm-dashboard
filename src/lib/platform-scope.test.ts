import assert from "node:assert/strict";
import test from "node:test";

import { classifyDevice, parseTestAreaFile, type TestAreaFile } from "./gpu-parity";
import { computePlatformScope, countScopes } from "./platform-scope";
import { FILE_RULES, STEP_RULES } from "./platform-scope-rules";

function area(path: string, group: string, steps: Record<string, unknown>[]): TestAreaFile {
  const file = parseTestAreaFile(path, { group, steps });
  assert.ok(file);
  return file;
}

const kernels = area(".buildkite/test_areas/kernels.yaml", "Kernels", [
  // Mirrored: common on both, whatever its label says.
  {
    label: ":nvidia: (H100) DeepGEMM Kernels",
    key: "kernels-deepgemm",
    device: "h100",
    mirror: { amd: { device: "mi355_1", label: ":amd: (MI355) DeepGEMM Kernels" } },
  },
  // Key rule: NVIDIA-only.
  { label: ":nvidia: (B200) MiniMax M3 MegaMoE", key: "minimax-m3-mega-moe-test-b200", device: "b200-k8s" },
  // Key rule with a counterpart: common on both through separate steps.
  {
    label: ":nvidia: (H100) [Nightly] FP8 MoE Kernels",
    key: "kernels-fp8-moe-test-1xh100",
    device: "h100",
    optional: true,
  },
  { label: ":amd: (MI355 DPX) FP8 MoE Kernels", key: "amd-fp8-moe-kernels-mi355", device: "mi355_dpx" },
  // Label fallbacks for steps no key rule names.
  { label: ":nvidia: (B200) New FlashInfer Sampler", key: "new-flashinfer", device: "b200-k8s" },
  { label: ":amd: (MI355) AITER Fused RoPE", key: "new-aiter", device: "mi355_1" },
  // Neither: unclassified.
  { label: ":nvidia: (L4) Brand New Test", key: "brand-new", device: "l4" },
  { label: ":amd: (MI300) Brand New AMD Test", key: "brand-new-amd", device: "mi300_1" },
  // CPU steps are out of scope, mirror or not.
  {
    label: ":computer: (CPU) Docker Build Metadata",
    key: "docker-metadata",
    device: "cpu-small",
    mirror: { amd: { device: "amd_cpu" } },
  },
]);

const misc = area(".buildkite/test_areas/misc.yaml", "Misc", [
  // Common, AMD side missing.
  {
    label: ":nvidia: (L4) NixlConnector PD accuracy core",
    key: "nixlconnector-pd-accuracy-core-2-gpus",
    device: "l4",
  },
  // Common, NVIDIA side missing.
  { label: ":amd: (MI300) Model Executor", key: "amd-model-executor", device: "mi300_1" },
  // A rule on a step that has since gained a mirror is reported stale.
  {
    label: ":nvidia: (L4) [Nightly] PP Equivalence",
    key: "pp-equivalence-4-gpus",
    device: "l4",
    optional: true,
    mirror: { amd: { device: "mi355_4" } },
  },
]);

const monokernels = area(".buildkite/test_areas/monokernels.yaml", "Monokernels", [
  { label: ":amd: (MI355) Some Future Mono Step", key: "future-mono", device: "mi355_4" },
]);

test("AMD partitioned devices such as mi355_dpx are AMD", () => {
  assert.equal(classifyDevice("mi355_dpx", "no shortcode"), "amd");
});

test("classifies each GPU step as common, NVIDIA-only, ROCm-only or unclassified", () => {
  const snapshot = computePlatformScope([kernels, misc, monokernels]);
  const byId = new Map(snapshot.jobs.map((job) => [job.id, job]));
  const pick = (id: string) => {
    const job = byId.get(id);
    assert.ok(job, id);
    return {
      scope: job.scope,
      source: job.source,
      missingOn: job.missingOn,
      nvidia: job.nvidia?.via ?? null,
      amd: job.amd?.via ?? null,
    };
  };

  assert.deepEqual(pick("kernels-deepgemm"), {
    scope: "common", source: "mirror", missingOn: null, nvidia: "step", amd: "mirror",
  });
  assert.equal(byId.get("kernels-deepgemm")?.amd?.key, "amd-kernels-deepgemm");
  assert.equal(byId.get("kernels-deepgemm")?.amd?.label, ":amd: (MI355) DeepGEMM Kernels");
  assert.deepEqual(pick("minimax-m3-mega-moe-test-b200"), {
    scope: "nvidia-only", source: "step-rule", missingOn: null, nvidia: "step", amd: null,
  });
  assert.deepEqual(pick("kernels-fp8-moe-test-1xh100"), {
    scope: "common", source: "step-rule", missingOn: null, nvidia: "step", amd: "counterpart",
  });
  assert.equal(byId.get("kernels-fp8-moe-test-1xh100")?.amd?.device, "mi355_dpx");
  assert.deepEqual(pick("amd-fp8-moe-kernels-mi355"), {
    scope: "common", source: "step-rule", missingOn: null, nvidia: "counterpart", amd: "step",
  });
  assert.deepEqual(pick("new-flashinfer"), {
    scope: "nvidia-only", source: "label-rule", missingOn: null, nvidia: "step", amd: null,
  });
  assert.deepEqual(pick("new-aiter"), {
    scope: "rocm-only", source: "label-rule", missingOn: null, nvidia: null, amd: "step",
  });
  assert.deepEqual(pick("brand-new"), {
    scope: "unclassified", source: "none", missingOn: null, nvidia: "step", amd: null,
  });
  assert.deepEqual(pick("brand-new-amd"), {
    scope: "unclassified", source: "none", missingOn: null, nvidia: null, amd: "step",
  });
  assert.deepEqual(pick("nixlconnector-pd-accuracy-core-2-gpus"), {
    scope: "common", source: "step-rule", missingOn: "amd", nvidia: "step", amd: null,
  });
  assert.deepEqual(pick("amd-model-executor"), {
    scope: "common", source: "step-rule", missingOn: "nvidia", nvidia: null, amd: "step",
  });
  assert.deepEqual(pick("pp-equivalence-4-gpus"), {
    scope: "common", source: "mirror", missingOn: null, nvidia: "step", amd: "mirror",
  });
  assert.deepEqual(pick("future-mono"), {
    scope: "rocm-only", source: "file-rule", missingOn: null, nvidia: null, amd: "step",
  });
  assert.equal(byId.has("docker-metadata"), false);
  assert.equal(snapshot.skipped.cpuJobs, 1);

  assert.deepEqual(snapshot.summary.all, {
    jobs: 12,
    common: 6,
    commonOnBoth: 4,
    missingOnAmd: 1,
    missingOnNvidia: 1,
    nvidiaOnly: 2,
    rocmOnly: 2,
    unclassified: 2,
  });
  // Optional steps drop out of the non-optional population.
  assert.equal(snapshot.summary.gating.jobs, 10);
  assert.equal(snapshot.summary.gating.commonOnBoth, 2);
  assert.deepEqual(
    snapshot.groups.map((group) => [group.group, group.all.jobs]),
    [["Kernels", 8], ["Misc", 3], ["Monokernels", 1]],
  );
  assert.deepEqual(
    countScopes(snapshot.jobs.filter((job) => job.group === "Misc")),
    snapshot.groups.find((group) => group.group === "Misc")?.all,
  );

  const stale = new Map(snapshot.staleRules.map((rule) => [rule.id, rule.problem]));
  assert.match(stale.get("pp-equivalence-4-gpus") ?? "", /now declares a mirror/);
  assert.match(stale.get("lm-eval-humming-l4") ?? "", /No GPU step/);
  assert.equal(stale.has("minimax-m3-mega-moe-test-b200"), false);
});

test("a common rule whose counterpart is gone reports it and the job as missing", () => {
  const snapshot = computePlatformScope([
    area(".buildkite/test_areas/kernels.yaml", "Kernels", [
      { label: ":amd: (MI355 DPX) FP8 MoE Kernels", key: "amd-fp8-moe-kernels-mi355", device: "mi355_dpx" },
    ]),
  ]);
  assert.equal(snapshot.jobs[0].missingOn, "nvidia");
  assert.ok(
    snapshot.staleRules.some(
      (rule) =>
        rule.id === "amd-fp8-moe-kernels-mi355" &&
        rule.problem.includes("kernels-fp8-moe-test-1xh100"),
    ),
  );
});

test("every rule has a reason, and only common rules name a counterpart", () => {
  for (const [id, rule] of Object.entries({ ...STEP_RULES, ...FILE_RULES })) {
    assert.ok(rule.reason.trim().length > 0, id);
    if (rule.counterpart) assert.equal(rule.scope, "common", id);
  }
});
