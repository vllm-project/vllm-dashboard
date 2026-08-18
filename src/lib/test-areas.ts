import yaml from "js-yaml";

export interface TestStep {
  label: string;
  parallelism?: number;
  optional?: boolean;
}

export interface TestArea {
  group: string;
  steps: TestStep[];
}

export interface TestAreaMapping {
  jobToGroup: Map<string, string>;
  patterns: { regex: RegExp; group: string }[];
  groups: string[];
}

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

const GITHUB_RAW_BASE =
  "https://raw.githubusercontent.com/vllm-project/vllm/main/.buildkite/test_areas";
const GITHUB_API_URL =
  "https://api.github.com/repos/vllm-project/vllm/contents/.buildkite/test_areas";

// Pipeline groups that are not defined in .buildkite/test_areas.  Keep these
// local rather than relying on the remote test-area refresh: that endpoint
// intentionally only describes the main CUDA test matrix.
const PIPELINE_GROUP_DATA: [string, string[]][] = [
  ["Abuild", [
    ":docker: Build image",
    ":docker: :smoking: Non-root smoke tests",
    ":docker: Build CPU image",
    ":docker: Build HPU image",
    ":docker: Build CPU arm64 image",
    ":docker: Build arm64 image",
  ]],
  ["CPU", [
    "Arm CPU Test",
    "CPU-Kernel Tests",
    "CPU-Language Generation and Pooling Model Tests",
    "CPU-ModelRunnerV2 Tests",
    "CPU-Quantization Model Tests",
    "CPU-Distributed Tests (PP+TP)",
    "CPU-Distributed Tests (DP+TP)",
    "CPU-Multi-Modal Model Tests %N",
    "CPU-Qwen2.5-VL Multimodal Tests",
  ]],
  ["Hardware", ["Ascend NPU Test", "GH200 Test", "Intel HPU Test"]],
  ["Hardware - AMD Build", [
    "AMD: :docker: refresh ROCm base",
    "AMD: :docker: ensure ci_base",
    "AMD: :docker: build test image and artifacts",
  ]],
  ["Intel", [
    ":docker: Build XPU image",
    "XPU V1 test",
    "XPU example Test",
    "XPU server test",
  ]],
];

// Static seed mapping so the first request is instant.
// Background refresh from GitHub picks up new/renamed tests within 1 hour.
// Format: [group, [...labels]] — labels with %N are treated as patterns.
const SEED_DATA: [string, string[]][] = [
  ["Attention", ["V1 attention (H100)", "V1 attention (B200)"]],
  ["Basic Correctness", ["Basic Correctness"]],
  ["Benchmarks", ["Benchmarks", "Benchmarks CLI Test", "Attention Benchmarks Smoke Test (B200)"]],
  ["Compile", [
    "Sequence Parallel Correctness Tests (2 GPUs)", "Sequence Parallel Correctness Tests (2xH100)",
    "AsyncTP Correctness Tests (2xH100)", "AsyncTP Correctness Tests (B200)",
    "Distributed Compile Unit Tests (2xH100)", "Distributed Compile + RPC Tests (2 GPUs)",
    "Fusion and Compile Unit Tests (B200)", "Fusion and Compile Unit Tests (2xB200)",
    "Fusion E2E Quick (H100)", "Fusion E2E Config Sweep (H100)", "Fusion E2E Config Sweep (B200)",
    "Fusion E2E TP2 Quick (H100)", "Fusion E2E TP2 AR-RMS Config Sweep (H100)",
    "Fusion E2E TP2 AsyncTP Config Sweep (H100)", "Fusion E2E TP2 (B200)",
  ]],
  ["CUDA", ["Platform Tests (CUDA)", "Cudagraph"]],
  ["Distributed", [
    "Distributed Comm Ops", "Distributed (2 GPUs)", "Distributed Tests (4 GPUs)",
    "Distributed Torchrun + Examples (4 GPUs)", "Distributed Torchrun + Shutdown Tests (2 GPUs)",
    "Distributed DP Tests (2 GPUs)", "Distributed DP Tests (4 GPUs)",
    "Distributed Compile + Comm (4 GPUs)", "Distributed Tests (8 GPUs)(H100)",
    "Distributed Tests (4 GPUs)(A100)", "Distributed Tests (2 GPUs)(H100)",
    "Distributed Tests (2 GPUs)(B200)", "2 Node Test (4 GPUs)",
    "Distributed NixlConnector PD accuracy (4 GPUs)",
    "DP EP Distributed NixlConnector PD accuracy tests (4 GPUs)",
    "CrossLayer KV layout Distributed NixlConnector PD accuracy tests (4 GPUs)",
    "Hyrbid SSM NixlConnector PD accuracy tests (4 GPUs)",
    "NixlConnector PD + Spec Decode acceptance (2 GPUs)",
    "Pipeline + Context Parallelism (4 GPUs)",
    "MessageQueue TCP Multi-Node (2 GPUs)",
  ]],
  ["E2E Integration", [
    "DeepSeek V2-Lite Accuracy", "DeepSeek V2-Lite Async EPLB Accuracy",
    "Qwen3-30B-A3B-FP8-block Accuracy", "Qwen3-30B-A3B-FP8-block Accuracy (B200)",
    "Qwen3-30B-A3B-FP8-block Accuracy (H100)",
    "DeepSeek V2-Lite Prefetch Offload Accuracy (H100)",
    "Qwen3-Next-80B-A3B-Instruct MTP Async EPLB Accuracy",
  ]],
  ["Engine", [
    "Engine", "Engine (1 GPU)", "e2e Scheduling (1 GPU)", "e2e Core (1 GPU)",
    "V1 e2e (2 GPUs)", "V1 e2e (4 GPUs)", "V1 e2e (4xH100)", "V1 e2e + engine (1 GPU)",
  ]],
  ["Entrypoints", [
    "Entrypoints Unit Tests", "Entrypoints Integration (LLM)",
    "Entrypoints Integration (API Server 1)", "Entrypoints Integration (API Server 2)",
    "Entrypoints Integration (API Server openai - Part 1)",
    "Entrypoints Integration (API Server openai - Part 2)",
    "Entrypoints Integration (API Server openai - Part 3)",
    "Entrypoints Integration (Pooling)", "Entrypoints Integration (Responses API)",
    "Entrypoints V1", "OpenAI API Correctness",
  ]],
  ["Expert Parallelism", ["EPLB Algorithm", "EPLB Execution", "Elastic EP Scaling Test"]],
  ["Kernels", [
    "vLLM IR Tests", "Kernels Core Operation Test",
    "Kernels Attention Test %N", "Kernels Quantization Test %N", "Kernels MoE Test %N",
    "Kernels Mamba Test", "Kernels DeepGEMM Test (H100)", "Kernels (B200)",
    "Kernels Helion Test", "Kernels FP8 MoE Test (1 H100)",
    "Kernels FP8 MoE Test (2 H100s)", "Kernels Fp4 MoE Test (B200)",
  ]],
  ["LM Eval", [
    "LM Eval Small Models", "LM Eval Large Models (4 GPUs)(H100)",
    "LM Eval Small Models (B200)", "LM Eval Large Models (H200)",
    "LM Eval Qwen3.5 Models (B200)",
    "MoE Refactor Integration Test (H100 - TEMPORARY)",
    "MoE Refactor Integration Test (B200 - TEMPORARY)",
    "MoE Refactor Integration Test (B200 DP - TEMPORARY)",
    "GPQA Eval (GPT-OSS) (H100)", "GPQA Eval (GPT-OSS) (B200)",
  ]],
  ["LoRA", ["LoRA %N", "LoRA TP (Distributed)"]],
  ["Miscellaneous", [
    "V1 Core + KV + Metrics", "V1 Sample + Logits", "V1 Spec Decode",
    "V1 Others", "V1 Others (CPU)", "Regression", "Examples",
    "Metrics, Tracing (2 GPUs)", "Python-only Installation",
    "Async Engine, Inputs, Utils, Worker", "Async Engine, Inputs, Utils, Worker, Config (CPU)",
    "Batch Invariance (H100)", "Batch Invariance (B200)",
    "Acceptance Length Test (Large Models)",
  ]],
  ["Model Executor", ["Model Executor"]],
  ["Model Runner V2", [
    "Model Runner V2 Core Tests", "Model Runner V2 Examples",
    "Model Runner V2 Distributed (2 GPUs)", "Model Runner V2 Pipeline Parallelism (4 GPUs)",
    "Model Runner V2 Spec Decode",
  ]],
  ["Models - Basic", [
    "Basic Models Tests (Initialization)", "Basic Models Tests (Extra Initialization) %N",
    "Basic Models Tests (Other)", "Basic Models Test (Other CPU)", "Transformers Nightly Models",
  ]],
  ["Models - Distributed", ["Distributed Model Tests (2 GPUs)"]],
  ["Models - Language", [
    "Language Models Tests (Standard)", "Language Models Tests (Extra Standard) %N",
    "Language Models Tests (Hybrid) %N", "Language Models Test (Extended Generation)",
    "Language Models Test (PPL)", "Language Models Test (Extended Pooling)",
    "Language Models Test (MTEB)",
  ]],
  ["Models - Multimodal", [
    "Multi-Modal Models (Standard)",
    "Multi-Modal Models (Standard) 1: qwen2", "Multi-Modal Models (Standard) 2: qwen3 + gemma",
    "Multi-Modal Models (Standard) 3: llava + qwen2_vl", "Multi-Modal Models (Standard) 4: other + whisper",
    "Multi-Modal Processor (CPU)", "Multi-Modal Processor",
    "Multi-Modal Accuracy Eval (Small Models)",
    "Multi-Modal Models (Extended) %N",
    "Multi-Modal Models (Extended Generation %N)",
    "Multi-Modal Models (Extended Pooling)",
  ]],
  ["Plugins", ["Plugin Tests (2 GPUs)"]],
  ["PyTorch", [
    "PyTorch Compilation Unit Tests", "PyTorch Compilation Unit Tests (H100)",
    "PyTorch Compilation Passes Unit Tests",
    "PyTorch Fullgraph Smoke Test", "PyTorch Fullgraph",
    "Pytorch Nightly Dependency Override Check",
  ]],
  ["Quantization", ["Quantization", "Quantized MoE Test (B200)", "Quantized Models Test"]],
  ["Ray Compatibility", ["Ray Dependency Compatibility Check", "RayExecutorV2 (4 GPUs)"]],
  ["Samplers", ["Samplers Test"]],
  ["Spec Decode", [
    "Spec Decode Eagle", "Spec Decode Speculators + MTP",
    "Spec Decode Ngram + Suffix", "Spec Decode Draft Model",
  ]],
  ["Weight Loading", ["Weight Loading Multiple GPU"]],
];

function buildMapping(areas: { group: string; labels: string[] }[]): TestAreaMapping {
  const jobToGroup = new Map<string, string>();
  const patterns: { regex: RegExp; group: string }[] = [];
  const groupSet = new Set<string>();

  for (const area of areas) {
    groupSet.add(area.group);
    for (const label of area.labels) {
      if (label.includes("%N")) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = escaped.replace("%N", "\\d+");
        patterns.push({ regex: new RegExp(`^${pattern}$`), group: area.group });
      } else {
        jobToGroup.set(label, area.group);
      }
    }
  }

  // AMD test jobs are distinguished by their Buildkite prefix. They do not
  // live in test_areas, so keep the group available across remote refreshes.
  groupSet.add("Hardware-AMD Tests");

  const groups = Array.from(groupSet).sort();
  return { jobToGroup, patterns, groups };
}

export function buildTestAreaMapping(areas: TestArea[]): TestAreaMapping {
  return buildMapping([
    ...SEED_DATA.map(([group, labels]) => ({ group, labels })),
    ...areas.map((area) => ({
      group: area.group,
      labels: area.steps.map((step) => step.label),
    })),
    ...PIPELINE_GROUP_DATA.map(([group, labels]) => ({ group, labels })),
  ]);
}

// Build static mapping immediately — no async, no network
const STATIC_MAPPING = buildTestAreaMapping([]);

let cachedMapping: TestAreaMapping = STATIC_MAPPING;
let cacheExpiry = 0;
let refreshPromise: Promise<void> | null = null;

async function fetchTestAreas(): Promise<TestArea[]> {
  const listRes = await fetch(GITHUB_API_URL, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!listRes.ok) {
    throw new Error(`GitHub API error: ${listRes.status}`);
  }
  const files = (await listRes.json()) as { name: string }[];
  const yamlFiles = files
    .filter((f) => f.name.endsWith(".yaml"))
    .map((f) => f.name);

  const areas: TestArea[] = [];
  const results = await Promise.allSettled(
    yamlFiles.map(async (name) => {
      const res = await fetch(`${GITHUB_RAW_BASE}/${name}`);
      if (!res.ok) return null;
      const text = await res.text();
      return yaml.load(text) as TestArea;
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value?.group && result.value?.steps) {
      areas.push(result.value);
    }
  }

  return areas;
}

function refreshMapping(): Promise<void> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const areas = await fetchTestAreas();
      cachedMapping = buildTestAreaMapping(areas);
      cacheExpiry = Date.now() + CACHE_TTL;
    } catch (error) {
      console.error("Failed to refresh test areas from GitHub:", error);
      // Keep using existing mapping (static or previously fetched)
      cacheExpiry = Date.now() + 5 * 60 * 1000; // retry in 5 min
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

export function getTestAreaMapping(): TestAreaMapping {
  // Always returns immediately — never blocks on network
  if (Date.now() >= cacheExpiry) {
    // Trigger background refresh, don't await
    refreshMapping();
  }
  return cachedMapping;
}

export async function ensureTestAreaMapping(): Promise<TestAreaMapping> {
  if (Date.now() >= cacheExpiry) {
    await refreshMapping();
  }
  return cachedMapping;
}
