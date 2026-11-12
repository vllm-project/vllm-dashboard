/**
 * Which platform(s) each vLLM CI job is meant to run on.
 *
 * `.buildkite/test_areas` says where a job runs today (its `device`, and
 * whether it declares a `mirror.amd` block), but not where it *should* run.
 * These rules record that intent for the jobs the YAML cannot settle on its
 * own: NVIDIA steps without an AMD mirror and AMD-only steps. A step with a
 * `mirror.amd` block always runs on both and needs no rule.
 *
 * Rules are keyed by the step's `key` (or its label when it has no key).
 * Each reason should name the evidence: the CUDA- or ROCm-only library,
 * kernel, or test skip that makes the job single-platform, or why a common
 * job is missing on one side.
 *
 * Changing a classification is a dashboard PR to this file. A step that no
 * rule or pattern covers is shown as "unclassified" until someone adds one.
 */

export type PlatformScope = "common" | "nvidia-only" | "rocm-only";

export interface PlatformScopeRule {
  scope: PlatformScope;
  reason: string;
  /**
   * Common jobs only: the key of the step on the other platform that runs the
   * same tests. Without one, the job is common but missing on that platform.
   */
  counterpart?: string;
}

export const STEP_RULES: Readonly<Record<string, PlatformScopeRule>> = {
  // --- NVIDIA steps without an AMD mirror: NVIDIA-only ---------------------
  "flashinfer-nvfp4-xqa-dgx-spark": {
    scope: "nvidia-only",
    reason: "FlashInfer NVFP4 XQA decode kernels are CUDA-only.",
  },
  "deepseek-shardq-sequence-parallel": {
    scope: "nvidia-only",
    reason:
      "Pins the FLASHMLA_SPARSE backend and fp8_ds_mla KV cache, both CUDA-only.",
  },
  "initialized-snapshot-e2e": {
    scope: "nvidia-only",
    reason: "Snapshots the GPU process with cuda-checkpoint and CRIU's CUDA plugin.",
  },
  "minimax-m3-mega-moe-test-b200": {
    scope: "nvidia-only",
    reason: "DeepGEMM NVFP4 MegaMoE needs SM100; the test skips non-CUDA platforms.",
  },
  "kernels-minimax-m3-sparse-prefill-h100": {
    scope: "nvidia-only",
    reason:
      "Covers the Hopper query-tiled prefill kernel in minimax_m3/nvidia. The portable kernels run on AMD through the MiniMax-M3 Attention Kernels mirror.",
  },
  "lm-eval-hisparse-nightly-4xb200": {
    scope: "nvidia-only",
    reason: "Evaluates an NVFP4 HiSparse checkpoint (GLM-5.2-NVFP4).",
  },
  "moe-refactor-dp-ep-test-b200-deepep-v2": {
    scope: "nvidia-only",
    reason: "Runs the DeepEP v2 all-to-all backend, which is CUDA-only.",
  },
  "lm-eval-humming-l4": {
    scope: "nvidia-only",
    reason: "Humming kernels ship only as a CUDA wheel (requirements/cuda.txt).",
  },
  "lm-eval-humming-h100-default": {
    scope: "nvidia-only",
    reason: "Humming kernels ship only as a CUDA wheel (requirements/cuda.txt).",
  },
  "lm-eval-humming-h100-act": {
    scope: "nvidia-only",
    reason: "Humming kernels ship only as a CUDA wheel (requirements/cuda.txt).",
  },
  "lm-eval-humming-h100-deepep": {
    scope: "nvidia-only",
    reason: "Humming kernels with DeepEP; both are CUDA-only.",
  },
  "lm-eval-humming-b200-default": {
    scope: "nvidia-only",
    reason: "Humming kernels ship only as a CUDA wheel (requirements/cuda.txt).",
  },
  "lm-eval-humming-b200-act": {
    scope: "nvidia-only",
    reason: "Humming kernels ship only as a CUDA wheel (requirements/cuda.txt).",
  },
  "qwen3-5-unit-tests-b200": {
    scope: "nvidia-only",
    reason: "Every test in tests/models/qwen3_5 skips without CUDA or SM100.",
  },
  "dsv41-nvidia-kernels-4xb200": {
    scope: "nvidia-only",
    reason: "Tests the kernels under vllm/models/deepseek_v41/nvidia.",
  },
  "glm5next-nvidia-specialized-decode-4xb200": {
    scope: "nvidia-only",
    reason: "The specialized-decode tests require SM100.",
  },
  "unlimited-ocr2-generation": {
    scope: "nvidia-only",
    reason: "DASH attention is CUDA-only; the test skips ROCm.",
  },

  // --- NVIDIA steps without an AMD mirror: common, AMD side missing --------
  "nixlconnector-pd-accuracy-core-2-gpus": {
    scope: "common",
    reason: "Every other NixlConnector PD job declares an AMD mirror.",
  },
  "2-node-test-4-gpus": {
    scope: "common",
    reason:
      "Multi-node distributed is platform-neutral, but AMD CI cannot schedule num_nodes ≥ 2 yet.",
  },
  "preload-mooncake-store-2xb200": {
    scope: "common",
    reason:
      "The Mooncake store test runs on any CUDA-alike platform, and the other Mooncake jobs have AMD mirrors.",
  },
  "elastic-ep-scaling-test": {
    scope: "common",
    reason: "Elastic EP runs over NIXL; the test only skips XPU.",
  },
  "python-314-smoke-nightly": {
    scope: "common",
    reason:
      "python_only_compile.sh supports ROCm, and the Python-only Installation job is already mirrored.",
  },
  "pp-equivalence-4-gpus": {
    scope: "common",
    reason: "Pipeline-parallel equivalence has no platform gate.",
  },

  // --- Common jobs whose AMD side is a separate step -----------------------
  "kernels-fp8-moe-test-1xh100": {
    scope: "common",
    reason: "AMD runs the portable FP8 MoE kernel tests in its own step.",
    counterpart: "amd-fp8-moe-kernels-mi355",
  },
  "amd-fp8-moe-kernels-mi355": {
    scope: "common",
    reason: "AMD side of the FP8 MoE kernel tests.",
    counterpart: "kernels-fp8-moe-test-1xh100",
  },
  "fusion-e2e-tp2-ar-rms-inductor-partition-amd": {
    scope: "common",
    reason: "AMD split of the TP2 AllReduce+RMSNorm fusion sweep.",
    counterpart: "fusion-e2e-tp2-ar-rms-config-sweep-h100",
  },
  "fusion-e2e-tp2-ar-rms-dynamo-partition-amd": {
    scope: "common",
    reason: "AMD split of the TP2 AllReduce+RMSNorm fusion sweep.",
    counterpart: "fusion-e2e-tp2-ar-rms-config-sweep-h100",
  },
  "amd-kernels-mi355": {
    scope: "common",
    reason: "AMD side of the attention-selector and smoke kernel tests.",
    counterpart: "kernels-b200",
  },
  "amd-mamba-ssm-kernels-mi355": {
    scope: "common",
    reason: "Mamba SSM kernels on MI355, alongside the Mamba Kernels mirror.",
    counterpart: "kernels-mamba-test",
  },
  "amd-lm-eval-small-models-harness": {
    scope: "common",
    reason: "lm-eval-harness accuracy for small models.",
    counterpart: "lm-eval-small-models",
  },
  "amd-lm-eval-large-models": {
    scope: "common",
    reason: "GSM8K accuracy for large models on gfx950.",
    counterpart: "lm-eval-large-models-4xh100",
  },
  "amd-lm-eval-large-models-harness": {
    scope: "common",
    reason: "lm-eval-harness accuracy for large models.",
    counterpart: "lm-eval-large-models-4xh100",
  },
  "amd-lm-eval-large-models-rocm-harness": {
    scope: "common",
    reason: "lm-eval-harness accuracy for large models (ROCm model list).",
    counterpart: "lm-eval-large-models-4xh100",
  },
  "amd-batch-invariance-a100": {
    scope: "common",
    reason: "Batch invariance on MI250, alongside the H100 job's mirror.",
    counterpart: "batch-invariance-h100",
  },

  // --- AMD-only steps: common, NVIDIA side missing -------------------------
  "amd-distributed-tests-4xa100": {
    scope: "common",
    reason:
      "Custom all-reduce, CA buffer sharing and weight transfer tests. The A100 step this mirrored was retired, so no NVIDIA job runs them.",
  },
  "amd-qwen3-next-mtp-async-eplb-accuracy": {
    scope: "common",
    reason: "MTP with async EPLB is platform-neutral; no NVIDIA job runs this scenario.",
  },
  "amd-model-executor": {
    scope: "common",
    reason:
      "The NVIDIA Model Executor step is commented out in model_executor.yaml until its apt installs are pinned.",
  },

  // --- AMD-only steps: ROCm-only -------------------------------------------
  "amd-native-quantization-kernels-mi355": {
    scope: "rocm-only",
    reason: "ROCm MXFP4/MXFP8 linear and skinny-GEMM kernels.",
  },
  "amd-lm-eval-octave-mi300": {
    scope: "rocm-only",
    reason: "ROCM_OCTAVE attention backend, built only for gfx942 and gfx1100.",
  },
  "qwen4-exp-unit-tests-mi300": {
    scope: "rocm-only",
    reason: "AMD QSA kernels (test_qsa_amd.py, test_qsa_prepare_amd.py).",
  },
  "amd-moriio-connector-unit-mi355": {
    scope: "rocm-only",
    reason: "MoRI-IO KV connector, built on AMD's MoRI.",
  },
  "amd-moriio-write-dummy-e2e-mi355": {
    scope: "rocm-only",
    reason: "MoRI-IO KV connector, built on AMD's MoRI.",
  },
  "amd-moriio-write-dummy-hetero-tp-mi355": {
    scope: "rocm-only",
    reason: "MoRI-IO KV connector, built on AMD's MoRI.",
  },
  "amd-umbp-connector-unit-mi355": {
    scope: "rocm-only",
    reason: "UMBP KV connector, built on AMD's MoRI.",
  },
  "amd-umbp-connector-integration-mi355": {
    scope: "rocm-only",
    reason: "UMBP KV connector, built on AMD's MoRI.",
  },
  "amd-umbp-connector-tp2-integration-mi355": {
    scope: "rocm-only",
    reason: "UMBP KV connector, built on AMD's MoRI.",
  },
};

/** Every step in these test-area files is single-platform. */
export const FILE_RULES: Readonly<Record<string, PlatformScopeRule>> = {
  ".buildkite/test_areas/monokernels.yaml": {
    scope: "rocm-only",
    reason: "AMD monokernel (fused persistent decode kernel) steps for gfx942/gfx950.",
  },
};

/**
 * Fallbacks for steps no key or file rule covers, matched against the label.
 * Each applies only to steps on its own vendor's hardware, and never to a
 * step with an AMD mirror.
 */
export const LABEL_RULES: ReadonlyArray<{
  vendor: "nvidia" | "amd";
  pattern: RegExp;
  scope: PlatformScope;
  reason: string;
}> = [
  {
    vendor: "nvidia",
    pattern:
      /\b(?:flashinfer|deepgemm|deep ?ep|nvfp4|mega ?moe|cutlass|cute ?dsl|humming|flashmla)\b/i,
    scope: "nvidia-only",
    reason: "Label names a CUDA-only library or format.",
  },
  {
    vendor: "amd",
    pattern: /\b(?:mono ?kernel|mono decode|mori(?:io)?|umbp|aiter|rocm|gfx9\d\d|octave)\b/i,
    scope: "rocm-only",
    reason: "Label names a ROCm-only library or kernel.",
  },
];
