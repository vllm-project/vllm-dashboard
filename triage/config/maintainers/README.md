# Maintainer rules

One file per maintainer: `<your-github-login>.yaml`. It decides which vLLM
issues and PRs the triage system routes to you.

## Changing your rules

1. Edit your file, or add one, and open a PR. CI checks it.
2. It takes effect about 5 minutes after the PR merges, when the triage
   worker reads this folder from `main`.

To try a change first, use **Rules** on [ci.vllm.ai/triage](https://ci.vllm.ai/triage).
It previews what a draft would have matched over the last 30 days, then
gives you the YAML or opens this file on GitHub for you.

Check locally: `cd triage && uv run python -m triage.maintainers check config/maintainers`

To stop getting items, delete your file, or set `active: false` to pause.

## Format

```yaml
github_login: your-login          # must match the file name
min_score: 40                     # only items scoring at least this (route band is 40+, page 70+)
capacity_per_week: 8              # page-band items ignore this
notify_mode: digest               # immediate | digest | off  (Slack is off for now)
away:                             # optional
  - {start: 2026-12-20, end: 2027-01-03}
rules:
  areas: [moe, kernels]
  hardware: [B200, GB200]
  models: ["deepseek*", "qwen3*"]          # lowercase globs on extracted model names
  paths: ["vllm/model_executor/layers/fused_moe/**"]   # globs on files a PR changes
  keywords: ["expert parallel"]            # case-insensitive, in the title or summary
  types: [bug, regression]                 # optional: only these types
  exclude: {types: [question], hardware: [MI300X]}
  natural_language: "One sentence about what you own (for humans)."
```

## How matching works

- An item matches you if **any** of `areas`, `hardware`, `models`, `paths`
  or `keywords` matches, and nothing in `exclude` does.
- `types` only narrows the match. If you set it, the item must be one of
  those types.
- If several people match, the one with more matching criteria wins. A tie
  goes to whoever has the most room under `capacity_per_week`.

## Allowed values

- **areas:** scheduler, kv_cache, attention, moe, quantization, distributed,
  model_loading, models, multimodal, spec_decode, lora, frontend_api,
  tool_calling, structured_output, compilation, kernels, sampling,
  tokenizer, engine_core, disagg, kv_connector, rocm, tpu, cpu, xpu,
  build_install, ci, docs, benchmarks, performance, memory, other
- **hardware:** H100, H200, B200, B300, GB200, GB300, A100, L40S, L4, RTX,
  MI300X, MI325X, MI355X, TPU, Gaudi, CPU_x86, CPU_arm, Apple, XPU,
  other_nvidia, other_amd, other
- **types:** bug, regression, perf_regression, feature, performance,
  question, usage, docs, ci, refactor, other, spam
