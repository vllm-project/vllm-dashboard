# Triage data model

The contract between the triage pipeline (Python, `triage/`), the extractor
host, and the dashboard (`src/app/triage`). Tables are defined in
`migrations/sql/0038_triage.sql`.

## Flow

```
GitHub ──(worker: triage-ingest, every 5 min)──► triage_items (+ prepass)
triage_items ──(extractor host: triage-extract, Claude Code)──► triage_extractions
triage_items + latest extraction ──(worker: triage-route)──► triage_scores
triage_scores ≥ route threshold ──(worker: triage-route)──► triage_assignments
                                                         └─► alerting_notification_outbox (alert_path='triage')
dashboard / Slack ──► triage_actions + triage_assignments.status
```

## `triage_items.prepass` (deterministic, recomputed on every ingest)

```json
{
  "areas": ["moe", "kernels"],          // from changed paths (PRs) and labels
  "linked_issues": [12345],             // "Fixes #N", "Closes #N", issue URLs
  "hardware_hints": ["B200"],           // regex hits in title/body
  "model_hints": ["DeepSeek-V3"],       // regex hits in title/body
  "is_maintainer": false,               // author_association in OWNER/MEMBER/COLLABORATOR
  "first_time": true,                   // FIRST_TIME_CONTRIBUTOR / FIRST_TIMER / NONE
  "template": {"has_env": true, "has_repro": true, "test_plan": false},
  "slop_hints": ["empty_test_plan"],
  "scope_reason": "issue" | "pr_external" | "pr_linked_issue" | "pr_maintainer_unlinked" | "bot"
}
```

`in_scope` is false for `pr_maintainer_unlinked` and `bot`; those items are
stored but not extracted, scored or routed.

## `triage_extractions.facets` (LLM output, prompt version `v1`)

```json
{
  "type": "bug",                 // bug | regression | perf_regression | feature | performance |
                                 // question | usage | docs | ci | refactor | other | spam
  "summary": "Server fails to start for Qwen3-235B FP8 on 8xB200 since 0.12",
  "models": [{"name": "Qwen3-235B-A22B", "family": "qwen3"}],
  "model_traits": ["moe"],       // moe | multimodal | hybrid | reasoning | embedding |
                                 // encoder_decoder | small
  "hardware": ["B200"],          // H100 H200 B200 B300 GB200 GB300 A100 L40S L4 RTX
                                 // MI300X MI325X MI355X TPU Gaudi CPU_x86 CPU_arm Apple XPU
                                 // other_nvidia other_amd other
  "serving": ["tp", "quant_fp8"],// tp pp dp ep multi_node quant_fp8 quant_fp4 quant_int4
                                 // quant_awq_gptq quant_other spec_decode lora prefix_caching
                                 // disagg_prefill kv_offload structured_output tool_calling
                                 // multimodal_input long_context cuda_graph torch_compile
                                 // chunked_prefill openai_api offline_llm embedding_api streaming
  "areas": ["moe", "quantization"],
  "severity": {
    "serving_broken": true,      // server cannot start / serve requests at all
    "crash": true,               // crash or exception during serving
    "wrong_output": false,       // garbage / incorrect results
    "hang": false,
    "perf_regression_pct": null, // e.g. 25 for a 25% slowdown, null if none/unknown
    "memory_regression": false,
    "security": false
  },
  "default_config": true,        // reproduces with defaults (no unusual flags); null = unknown
  "versions": {"good": "0.11.2", "bad": "0.12.0", "affects_main": true, "affects_latest_release": true},
  "has_repro": true,
  "pr": null,                    // PRs only:
                                 // {"fixes_issues": [123], "hot_path": true, "size": "s",
                                 //  "has_tests": true, "low_effort": false}
  "slop_signals": [],            // e.g. "generic_ai_description", "unrelated_changes", "no_testing"
  "confidence": 0.8,
  "notes": ""
}
```

`areas` vocabulary (shared by prepass, facets, and maintainer rules):
scheduler, kv_cache, attention, moe, quantization, distributed,
model_loading, models, multimodal, spec_decode, lora, frontend_api,
tool_calling, structured_output, compilation, kernels, sampling, tokenizer,
engine_core, disagg, kv_connector, rocm, tpu, cpu, xpu, build_install, ci,
docs, benchmarks, performance, memory, other.

## `triage_scores`

`score` is an integer 0–150ish, `band` one of:

| band | rule | effect |
|---|---|---|
| `page` | score ≥ `thresholds.page` | routed; immediate Slack DM |
| `route` | score ≥ `thresholds.route` | routed; daily digest |
| `watch` | score ≥ `thresholds.watch` | dashboard only |
| `ignore` | below, or spam/slop | dashboard only, hidden by default |

`breakdown` is an ordered list whose points sum to `score`:

```json
[{"factor": "severity.serving_broken", "points": 40},
 {"factor": "model_tier.tier1", "points": 20, "detail": "Qwen3-235B-A22B"},
 {"factor": "social.reactions", "points": 3, "detail": "12 reactions"}]
```

## Assignment status and actions

`triage_assignments.status`: `open` → `acked` → `done`, or closed as
`not_mine` / `reassigned` / `dropped` / `slop`. At most one `open`/`acked`
row per (item, role).

Every action inserts a `triage_actions` row in the same transaction as the
status change:

| action | assignment change | router follow-up |
|---|---|---|
| `ack` | open → acked | none |
| `not_mine` | → not_mine, closed_at=now | re-routes the item excluding this maintainer |
| `reassign` (target) | → reassigned, closed_at=now; new row for target, same role, `assigned_by`=actor | none |
| `drop` | → dropped, closed_at=now | never re-routes this item |
| `slop` | → slop, closed_at=now | never re-routes; counts as scorer feedback |
| `done` | → done, closed_at=now | none |
| `reopen` | latest closed row → open, closed_at=null | none |

The router never re-opens an item that has a `drop` or `slop` action, and
never routes an item to a maintainer who said `not_mine` for it.

## `triage_maintainers.rules`

Source of truth: `triage/config/maintainers.yaml`, changed by PR. The route
consumer reads the file from `main` every run, validates it
(`triage/maintainers.py`) and syncs it: listed maintainers are upserted with
`updated_by = 'repo'`, and file-owned rows no longer listed are deactivated.
An invalid file is rejected whole and the last good rules stay. The dashboard
only drafts and previews rules; it never writes them. Rows the dashboard
creates for unlisted people who ack an item carry `updated_by = <login>`, have
no rules, and are never touched by the sync.

```json
{
  "areas": ["moe", "kernels"],
  "hardware": ["B200", "GB200"],
  "models": ["DeepSeek-*", "Qwen3-*"],       // glob, case-insensitive, against facets.models[].name
  "paths": ["vllm/model_executor/layers/fused_moe/**"],
  "keywords": ["expert parallel"],            // case-insensitive substring of title/summary
  "types": ["bug", "regression", "perf_regression"],  // empty = any
  "exclude": {"types": ["question", "docs"], "areas": [], "hardware": []},
  "natural_language": "anything about EP load balancing"  // informational in v1
}
```

An item matches a maintainer when at least one positive criterion matches
and no exclude matches. Each matched criterion is recorded in
`triage_assignments.reason.matched` as `"area:moe"`, `"hardware:B200"`, …
