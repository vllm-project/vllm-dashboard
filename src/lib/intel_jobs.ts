import yaml from "js-yaml";
import type { TestAreaMapping } from "./test-areas";

interface TestStep {
  label: string;
  parallelism?: number;
  optional?: boolean;
}

interface TestArea {
  group: string;
  steps: TestStep[];
}

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

const GITHUB_RAW_BASE =
  "https://raw.githubusercontent.com/vllm-project/vllm/main/.buildkite/intel_jobs";
const GITHUB_API_URL =
  "https://api.github.com/repos/vllm-project/vllm/contents/.buildkite/intel_jobs";

// Static seed mapping so the first request is instant.
// Background refresh from GitHub picks up new/renamed tests within 1 hour.
// Format: [group, [...labels]] — labels with %N are treated as patterns.
const SEED_DATA: [string, string[]][] = [
  ["Basic Correctness", [":intel: (BMG) Sleep Mode"]],
  ["Benchmarks", [":intel: (BMG) Benchmarks CLI"]],
  ["Engine Intel", [":intel: (BMG) Engine", ":intel: (BMG) V1 E2E"]],
  ["Expert Parallelism", [":intel: (BMG) EPLB Algorithm"]],
  ["Kernels Intel", [":intel: (BMG) vLLM IR Tests"]],
  ["LM Eval", ["XPU GPQA Eval (GPT-OSS)"]],
  ["LoRA Intel", [
    ":intel: (BMG) LoRA Runtime + Utils", ":intel: (BMG) LoRA Fused/MoE Kernels",
    ":intel: (BMG) LoRA Punica Kernels", ":intel: (BMG) LoRA Punica FP8/XPU Ops",
    ":intel: (BMG) LoRA Models", ":intel: (BMG) LoRA Multimodal",
  ]],
  ["Miscellaneous Intel", [
    ":intel: (BMG) V1 Core + KV + Metrics", ":intel: (BMG) V1 Sample + Logits",
    ":intel: (BMG) CPU Offload", ":intel: (BMG) NixlConnector PD accuracy",
    ":intel: (BMG) Regression", ":intel: (BMG) Metrics, Tracing",
    ":intel: (BMG) Async Engine, Inputs, Utils, Worker", ":intel: (BMG) Fusion and Compile",
    ":intel: (BMG) Basic Models Tests (Initialization)",
  ]],
  ["Model Executor Intel", [":intel: (BMG) Model Executor"]],
  ["Model Runner V2 Intel", [
    ":intel: (BMG) Model Runner V2 Core Tests", ":intel: (BMG) Model Runner V2 Examples",
    ":intel: (BMG) Model Runner V2 Distributed", ":intel: (BMG) Model Runner V2 Spec Decode",
  ]],
  ["Models - Distributed", [":intel: (BMG) Distributed Model Tests"]],
  ["Models - Multimodal", [
    ":intel: (BMG) Multi-Modal Models (Standard) 1: qwen2",
    ":intel: (BMG) Multi-Modal Models (Standard) 2: qwen3 + gemma",
    ":intel: (BMG) Multi-Modal Models (Standard) 3: llava + qwen2_vl",
    ":intel: (BMG) Multi-Modal Models (Standard) 4: other + whisper",
    ":intel: (BMG) Multi-Modal Processor Shard %N",
  ]],
  ["Quantization", [":intel: (BMG) Quantization"]],
  ["Samplers Intel", [":intel: (BMG) Samplers Test"]],
  ["Intel", [
    ":docker: Build XPU image", ":intel: (BMG) Example Test",
    ":intel: (BMG) W8A8 FP8 Linear Examples", ":intel: (BMG) V1 test",
    ":intel: (BMG) Server test", ":intel: (BMG) Quantization test",
    ":intel: (BMG) GPQA Eval (GPT-OSS)", ":intel: (BMG) Compressed tensors FP8 test",
    ":intel: (BMG) Graph",
  ]],
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

  const groups = Array.from(groupSet).sort();
  return { jobToGroup, patterns, groups };
}

const STATIC_MAPPING = buildMapping(
  SEED_DATA.map(([group, labels]) => ({ group, labels }))
);

let cachedMapping: TestAreaMapping = STATIC_MAPPING;
let cacheExpiry = 0;
let refreshing = false;

async function fetchIntelAreas(): Promise<TestArea[]> {
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

async function refreshMapping() {
  if (refreshing) return;
  refreshing = true;
  try {
    const areas = await fetchIntelAreas();
    cachedMapping = buildMapping(
      areas.map((a) => ({ group: a.group, labels: a.steps.map((s) => s.label) }))
    );
    cacheExpiry = Date.now() + CACHE_TTL;
  } catch (error) {
    console.error("Failed to refresh Intel job areas from GitHub:", error);
    cacheExpiry = Date.now() + 5 * 60 * 1000; // retry in 5 min
  } finally {
    refreshing = false;
  }
}

export function getIntelJobMapping(): TestAreaMapping {
  if (Date.now() >= cacheExpiry) {
    refreshMapping();
  }
  return cachedMapping;
}
