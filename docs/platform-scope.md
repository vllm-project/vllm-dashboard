# Platform scope

The Platform Scope page (`/platforms`, formerly `/parity`) sorts every GPU
job in vLLM's CI into three buckets:

- **Common**: on the common path; both NVIDIA and AMD should run it.
- **NVIDIA only**: depends on something CUDA-only (FlashInfer, DeepGEMM,
  DeepEP, NVFP4, cuda-checkpoint, SM100-only kernels, ...).
- **ROCm only**: depends on something ROCm-only (monokernels, MoRI-IO, UMBP,
  ROCm Octave attention, ROCm-native quantization kernels, ...).

It replaces the old NVIDIA-to-AMD parity percentage, which counted every
NVIDIA job against AMD, including jobs AMD can never run, and ignored
AMD-only jobs. The page tracks the gaps on the common path instead: common
jobs that have no step on one of the two platforms.

## Source

Jobs come from `.buildkite/test_areas/*.yaml` on `vllm-project/vllm` `main`,
read with the parity loader (`gpu-parity-source.ts`) and its vendor rules
(`classifyStep`). Each NVIDIA or AMD GPU step is one job. CPU and other
hardware steps are left out and counted.

Scope is decided in this order:

1. An NVIDIA step with a `mirror.amd` block is **common** and runs on both.
   Nothing overrides a declared mirror.
2. A rule for the step's `key` (or label, when it has no key) in
   `STEP_RULES`.
3. A rule for the step's file in `FILE_RULES` (all of `monokernels.yaml` is
   ROCm-only).
4. A label pattern in `LABEL_RULES`, matched only against steps on that
   pattern's vendor (e.g. `FlashInfer` on an NVIDIA step, `AITER` on an AMD
   step).
5. Otherwise the job is **unclassified**, and the page asks for a mirror or a
   rule.

All rules live in `src/lib/platform-scope-rules.ts`, each with the reason the
job is single-platform or why a common job is missing on one side. Changing a
classification is a PR to that file.

A common rule can name a `counterpart`: the key of the step on the other
platform that runs the same tests (e.g. `(H100) FP8 MoE Kernels` and
`(MI355 DPX) FP8 MoE Kernels`). With a counterpart the job runs on both;
without one it is a gap on the platform it lacks.

The snapshot reports `staleRules`: a key no GPU step has any more, a rule on a
step that has since gained a mirror, or a counterpart that is gone. The page
shows them so the rules file can be pruned.

## Classification at introduction

At `vllm-project/vllm` `efe12305f0` (2026-11-12), 280 GPU jobs:

| Scope | All | Non-optional |
| --- | ---: | ---: |
| Common, on both | 238 | 152 |
| Common, missing on AMD | 6 | 2 |
| Common, missing on NVIDIA | 3 | 2 |
| NVIDIA only | 17 | 6 |
| ROCm only | 16 | 16 |

227 of the common jobs are NVIDIA steps with a `mirror.amd` block. The rest
are classified by rule; see the rules file for each job and its evidence.

## API

`GET /api/platforms` returns
`{ source, summary: { all, gating }, groups, jobs, staleRules, skipped }`.
`gating` counts only steps that are not `optional: true`. Each job carries its
`scope`, the `source` that decided it, a `reason`, an `nvidia` and an `amd`
side (`via: "step" | "mirror" | "counterpart"`, or `null`), and `missingOn` for
common jobs. Cached one hour at the origin and served stale from the CDN for a
day. GitHub failures return `502`, or `503` with `Retry-After` when the rate
limit is exhausted.

There is no weekly history: rules are keyed by today's step keys, so applying
them to old commits would mislabel renamed steps.

## Code

- `src/lib/platform-scope-rules.ts`: the classification rules.
- `src/lib/platform-scope.ts`: pure classification and counting, tested in
  `platform-scope.test.ts`.
- `src/lib/platform-scope-source.ts`, `src/app/api/platforms/route.ts`.
- `src/app/platforms/page.tsx`.
