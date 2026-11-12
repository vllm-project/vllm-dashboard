/**
 * Shared triage vocabularies. These mirror triage/docs/data-model.md and the
 * Python pipeline; keep the three in step.
 */

export const TRIAGE_AREAS = [
  "scheduler",
  "kv_cache",
  "attention",
  "moe",
  "quantization",
  "distributed",
  "model_loading",
  "models",
  "multimodal",
  "spec_decode",
  "lora",
  "frontend_api",
  "tool_calling",
  "structured_output",
  "compilation",
  "kernels",
  "sampling",
  "tokenizer",
  "engine_core",
  "disagg",
  "kv_connector",
  "rocm",
  "tpu",
  "cpu",
  "xpu",
  "build_install",
  "ci",
  "docs",
  "benchmarks",
  "performance",
  "memory",
  "other",
] as const;

export const TRIAGE_HARDWARE = [
  "H100",
  "H200",
  "B200",
  "B300",
  "GB200",
  "GB300",
  "A100",
  "L40S",
  "L4",
  "RTX",
  "MI300X",
  "MI325X",
  "MI355X",
  "TPU",
  "Gaudi",
  "CPU_x86",
  "CPU_arm",
  "Apple",
  "XPU",
  "other_nvidia",
  "other_amd",
  "other",
] as const;

export const TRIAGE_SERVING = [
  "tp",
  "pp",
  "dp",
  "ep",
  "multi_node",
  "quant_fp8",
  "quant_fp4",
  "quant_int4",
  "quant_awq_gptq",
  "quant_other",
  "spec_decode",
  "lora",
  "prefix_caching",
  "disagg_prefill",
  "kv_offload",
  "structured_output",
  "tool_calling",
  "multimodal_input",
  "long_context",
  "cuda_graph",
  "torch_compile",
  "chunked_prefill",
  "openai_api",
  "offline_llm",
  "embedding_api",
  "streaming",
] as const;

export const TRIAGE_TYPES = [
  "bug",
  "regression",
  "perf_regression",
  "feature",
  "performance",
  "question",
  "usage",
  "docs",
  "ci",
  "refactor",
  "other",
  "spam",
] as const;

/** Real score bands plus `unscored` for items the router has not scored yet. */
export const TRIAGE_BANDS = ["page", "route", "watch", "ignore", "unscored"] as const;
export const DEFAULT_QUEUE_BANDS = ["page", "route", "watch"] as const;

export const TRIAGE_ACTIONS = [
  "ack",
  "not_mine",
  "reassign",
  "drop",
  "slop",
  "done",
  "reopen",
] as const;

export const ASSIGNMENT_STATUSES = [
  "open",
  "acked",
  "not_mine",
  "reassigned",
  "dropped",
  "slop",
  "done",
] as const;

export const OPEN_ASSIGNMENT_STATUSES = ["open", "acked"] as const;

export const NOTIFY_MODES = ["immediate", "digest", "off"] as const;

export type TriageArea = (typeof TRIAGE_AREAS)[number];
export type TriageHardware = (typeof TRIAGE_HARDWARE)[number];
export type TriageType = (typeof TRIAGE_TYPES)[number];
export type TriageBand = (typeof TRIAGE_BANDS)[number];
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export type NotifyMode = (typeof NOTIFY_MODES)[number];

export function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
