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
  "linked_issues": [12345],             // "Fixes #N", "Closes #N", issue URLs, and (GraphQL
                                        // ingest) the PR's closing references in the sidebar
  "fixes_issues": [12345],              // PRs: only "Fixes/Closes/Resolves #N" (or the issue URL)
                                        // plus the closing references; "related to #N" is not a
                                        // fix. Issues: []. Groups an issue with its fix PRs.
  "hardware_hints": ["B200"],           // regex hits in title/body
  "model_hints": ["DeepSeek-V3"],       // regex hits in title/body
  "is_maintainer": false,               // author_association in OWNER/MEMBER/COLLABORATOR
  "first_time": true,                   // FIRST_TIME_CONTRIBUTOR / FIRST_TIMER / NONE
  "template": {"has_env": true, "has_repro": true, "test_plan": false},
  "slop_hints": ["empty_test_plan"],
  "scope_reason": "issue" | "pr_external" | "pr_linked_issue" | "pr_maintainer_unlinked" | "bot",
  "commenters": ["gau-nernst"],         // who commented, in order: the first 30 comments and
                                        // (GraphQL ingest) the latest 30; kept until comments are re-read
  "commented_at": {"gau-nernst": "2026-11-18T09:12:00+00:00"},  // latest comment per login (lower case),
                                        // same comments; kept until comments are re-read
  "gh_assignees": ["gau-nernst"],       // the item's assignees on GitHub
  // Open PRs only: whose move it is (prepass.whose_move). "author" when it is
  // a draft, pre-commit or DCO fails, its finished CI build fails jobs main
  // doesn't share (`ci_pr_failures`, see triage_pr_ci below), it has merge
  // conflicts, or changes were requested; the router holds P1 PRs waiting on
  // their author (not P0).
  "waiting_on": "author" | "reviewer",
  "waiting_reasons": ["draft", "ci_failing", "ci_pr_failures", "merge_conflict", "changes_requested"],
  "failing_checks": ["pre-run-check"],  // checks failing on the head commit (GraphQL ingest only)
  "ci_pr_only_jobs": [":github: GitHub pre-commit check"]  // with ci_pr_failures: up to 3 of those jobs
}
```

Comments are re-read only when the comment count changes (or the item comes
into scope); in between, the stored excerpt stands in for them, and the
content hash is always computed from that excerpt, so a re-read that finds
nothing new doesn't change it. `waiting_on` can change without the PR's
`updatedAt` moving (a check finishes, `main` moves under it), so each ingest
run also re-reads the status of unowned P1 PRs held back as waiting on their
author.

`in_scope` is false for `pr_maintainer_unlinked` and `bot`; those items are
stored but not extracted, scored or routed.

## `triage_pr_ci` (migration 0044, `triage/ci.py`)

CI of open in-scope P0-P2 PRs, one row per PR, for the dashboard (drawer
"CI" section, row badge), Slack item lines and whose move. The ingest run
re-reads the GitHub status of PRs that are due (P0/P1 every 10 minutes, P2
every hour; `store.CI_REFRESH`) in the same batched query as the waiting
PRs: the head commit, and the Buildkite build its `buildkite/ci/pr` status
links. No such status means `not_started` (nobody ran `/ci run` on that
commit). The build is fetched from Buildkite (one REST call, jobs embedded,
at most 15 per run) only while it is new or unfinished; a finished build is
kept and only re-marked against main.

Counts are over script jobs, latest attempt each: `passed`, `running`
(anything unfinished, including queued), `failed` (failed or timed out, not
soft-failed). Jobs that never ran (`waiting_failed`, `broken`, `skipped`,
`canceled`, ...) are not counted. Each failed job is keyed as Main CI keys it
(`step:<step key>|name:<step name>`, shards folded) and marked against
`alerting_main_ci_job_states` / `alerting_main_ci_job_alerts`: `on_main`
(failing on main now), `recent_on_main` (failed on main in the last 7 days,
not now: flaky), or neither (`jobs_failed_pr_only`, unless it lost its
agent). When Main CI hasn't scanned for an hour, or its tables can't be
read, `main_known` is false and no failure is called the PR's.

Whose move: with `CI_PR_ONLY_FAILURES_WAIT_ON_AUTHOR` (on), a finished
(`failed`) build with `jobs_failed_pr_only > 0` makes the PR the author's
move (`ci_pr_failures`). Running builds and failures main shares don't.

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

`score` is an integer 0–150ish, `band` one of the values below. People see
them as priorities: page = **P0**, route = **P1**, watch = **P2**, ignore =
**P3** (`triage.model.BAND_LABELS`, `src/lib/triage-style.ts`); the stored
values and config keys keep the original names.

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

The route consumer also follows GitHub on every run (`store.follow_github`),
without `triage_actions` rows (those are what people did):

| on GitHub | assignment change |
|---|---|
| item closed or merged | open/acked → done, closed_at=now; `reason` gains `closed_by: "github"`, `closed_from` (the old status) and `item_state` |
| that item reopened (still in the window) | back to `closed_from`, closed_at=null, those keys removed; skipped if the role was filled since |
| the assigned maintainer comments after `assigned_at` | open → acked; `reason.acked_by = "github_comment"` |

Weekly capacity does not count a primary that was closed on GitHub before it
was acked.

### Issue + fix PR groups (`triage/groups.py`)

A PR fixes an issue when `prepass.fixes_issues` or Claude's
`facets.pr.fixes_issues` names it and both are `vllm-project/vllm` items in
`triage_items` (`store.fix_links`). A group is an issue and its fix PRs.

- Routing: an item whose issue / fix PR has an open or acked primary owner
  goes to that owner (`reason.matched` starts with `"fixes #N"` or
  `"fixed by #N"`, and `reason.grouped_with` is that item's key), unless the
  owner said `not_mine` to it, excludes it, is away, or the group's highest
  score is under their `min_score`. With no owner, the highest-scored member
  is routed as usual with the group's highest score and band, and the other
  unowned candidates follow it in the same run (one P0 DM for the group).
- Capacity: rows with `reason.grouped_with` don't count, so a group takes one
  slot.
- Actions: `ack`, `not_mine`, `done` and `reassign` on an issue also apply to
  its fix PRs' open/acked assignments held by the same person (the actor, or
  for reassign the person it was taken from), each with its own
  `triage_actions` row (`note = "with #N"`). `drop`, `slop` and `reopen` stay on
  the item clicked.
- Reminders ("Still waiting") skip an issue whose fix PR is merged. An item whose GitHub assignees are all people outside the active
maintainer list is not routed (it stays on the dashboard); a GitHub assignee
who is a maintainer counts as involvement (`"assigned on GitHub"`) and ranks
above every other reason.

## `triage_maintainers.rules`

Source of truth: `triage/config/maintainers/<github_login>.yaml`, one file
per maintainer, changed by PR. The route consumer reads every file from
`main` each run, validates the set (`triage/maintainers.py`) and syncs it:
listed maintainers are upserted with `updated_by = 'repo'`, and file-owned
rows whose file is gone are deactivated. If any file is invalid or any fetch
fails, the sync is skipped and the last good rules stay. The dashboard
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

## Relevance (migration 0039)

`triage_maintainer_profiles`: per active maintainer, their recent authored
and reviewed PRs (`[{"number", "kind", "title"}]`), rebuilt daily by
`triage-route`. `feedback` (migration 0043) is a snapshot taken at the same
rebuild of what they did with items in the last 60 days, newest first, at
most 15 of each: `{"declined": [{"item_key", "title", "at"}], "took": [...]}`
(`declined` = their `not_mine` actions, `took` = their acked or done
assignments). The worker builds it because only it can read
`triage_actions` and `triage_assignments`; the relevance job reads the
snapshot. Claude sees it as "said not mine: <title>" / "took: <title>" lines.
`profile_hash` covers the PRs, the maintainer's notes
(`rules.natural_language`), their language and the feedback titles, so
feedback re-judges a maintainer at most once a day, at the rebuild.

`triage_relevance`: one row per (item, maintainer): `relevance` in high /
medium / low / none, `evidence_prs` (only PRs from that maintainer's
profile), `reason`, plus the item `content_hash` and `profile_hash` it was
judged against. A change to either re-queues the judgement. Written by the
extractor host (`vllm-triage relevance`) for open items scoring at least the
route threshold. Routing waits for every active maintainer's judgement
unless a maintainer is already involved, but only for
`pipeline.RELEVANCE_GRACE` (2 hours) from `triage_scores.routable_since`
(when the item entered the page/route band) or its first extraction,
whichever is later; after that it routes among the maintainers judged so
far and logs a warning naming who is missing. A missing judgement never
counts as a match. Judgements are recorded in `triage_assignments.reason`
(`matched`, `why`).
