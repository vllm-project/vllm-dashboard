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

Claude also learns from what you do: items you mark **Not mine** count
against similar items, and items you ack or finish count for them (last 60
days, picked up once a day).

**Writing notes.** "Don't send me X" always wins. A "send me" line that names a
specific component ("HiSparse bugs", "the Anthropic Messages API") makes those
items at least medium. A broad category ("quantization crashes", "tool-call
issues", "KV connector problems") only counts for the parts of it you author
yourself, so if you want a whole category regardless, say so explicitly.

## Your file

```yaml
github_login: your-login          # must match the file name
min_score: 40                     # only items scoring at least this (route band 40+, page 70+)
capacity_per_week: 10             # new P0s, and P0s clearly yours, may exceed it
notify_mode: digest               # immediate | digest | off  (Slack is off for now)
max_notifications_per_day: 5      # optional, max immediate Slack DMs per local day (default 5; rest go in daily digest)
timezone: Europe/London           # optional, IANA name; default UTC
digest_hour: 9                    # optional, local hour 0-23 for the daily digest; default 9
away:                             # optional
  - {start: 2026-12-20, end: 2027-01-03}

notes: |
  Write anything in plain words: what you own, what to send you, what not
  to send you. Claude reads this when judging relevance.

rules:                            # optional
  exclude: {hardware: [MI300X], types: [question]}   # hard limits; hardware only excludes
                                                    # items about nothing but that hardware
  areas: [moe]                    # "always send me" overrides (any one matches)
  models: ["deepseek*"]
  keywords: ["expert parallel"]
```

## When the daily digest arrives

The digest DM goes out once a day between `digest_hour`:00 and the next hour
(default 09:00-10:00) in your `timezone`, so set `timezone` to where you are
(names like `America/Los_Angeles`, `Asia/Ho_Chi_Minh`; the list is
[here](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)). Without
one it is UTC, i.e. 09:00 UTC (the old fixed time for everyone was 15:00 UTC).
The team channel digest stays at 15:00 UTC.

The digest lists what was assigned to you since the last one, then a short
**Still waiting** section: up to 5 of your items assigned 3 or more days ago
that you haven't acked yet, oldest first. Ack or pass them on to stop the
reminders. A day with nothing new and nothing waiting sends no digest.

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
