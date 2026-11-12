# Maintainers

One file per maintainer: `<your-github-login>.yaml`. Edit yours however you
like and open a PR. It takes effect about 5 minutes after the PR merges.

## How items reach you

You don't need to write matching rules. For each important item (score 40+),
Claude reads:

- **your recent vLLM work:** the PRs you authored and reviewed in the last
  6 months, refreshed daily, and
- **your `notes`:** anything you write in your file,

and decides whether the item is **high**, **medium**, **low** or **none**
for you, citing your PRs as evidence. You get it if:

1. you're already **involved**: you wrote a PR the item names (e.g. the
   commit a regression was bisected to) or you've commented on it; or
2. it's **high** or **medium** for you; or
3. it matches a **rule** you wrote (optional, for "always send me X").

The dashboard shows why, e.g. `relevance:high (like #61343)`.

## Your file

```yaml
github_login: your-login          # must match the file name
min_score: 40                     # only items scoring at least this (route band 40+, page 70+)
capacity_per_week: 10             # new page-band items (last 3 days) may exceed it
notify_mode: digest               # immediate | digest | off  (Slack is off for now)
away:                             # optional
  - {start: 2026-12-20, end: 2027-01-03}

notes: |
  Write anything in plain words: what you own, what to send you, what not
  to send you. Claude reads this when judging relevance.

rules:                            # optional
  exclude: {hardware: [MI300X], types: [question]}   # hard limits
  areas: [moe]                    # "always send me" overrides (any one matches)
  models: ["deepseek*"]
  keywords: ["expert parallel"]
```

To stop getting items, delete your file, or set `active: false` to pause.
Check it locally with
`cd triage && uv run python -m triage.maintainers check config/maintainers`.

## Allowed values (for `rules`)

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
