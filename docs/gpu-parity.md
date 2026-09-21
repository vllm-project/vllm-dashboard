# NVIDIA to AMD gating parity

The Parity page (`/parity`) and its APIs answer one question: of the test jobs
vLLM runs on NVIDIA GPUs and includes in AMD parity, how many declare an AMD mirror?

## Source

Everything is read from `.buildkite/test_areas/*.yaml` on
`vllm-project/vllm` `main`, the same files the pipeline generator in
`vllm-project/ci-infra` turns into Buildkite steps. Nothing is inferred from
Buildkite job history. Counts depend on the YAML and the dashboard's label
exclusion rules below.

Each file is one test area (`group`) with a list of `steps`. For every step:

- **Vendor** comes from `device` first, using the generator's `DeviceType`
  names (`h100`, `h200_35gb`, `l4`, `b200-k8s`, `a100`, `gh200`, `dgx-spark`
  are NVIDIA; `cpu-*`, `intel_cpu`, `amd_cpu`, `zen5` are CPU; `mi###_N` is
  AMD), then from the label shortcode (`:nvidia:`, `:amd:`, `:computer:`).
  Files written before mid-2026 often had neither; the generator sent those
  steps to its default GPU queue, so a step with no device is NVIDIA unless
  it is `no_gpu: true`, a `:docker:` build, or the documentation build (all
  CPU), and a legacy `gpu:` key is NVIDIA. This keeps the weekly history
  comparable across the format change. A device the generator does not know,
  with no shortcode to fall back on, is reported under `skipped.unknown`
  rather than dropped silently.
- **Mirrored** means the step declares a `mirror.amd` block. The generator
  emits that block as an `amd-<key>` step on the AMD device it names.
- **Gating** means the step is neither `optional: true` (only runs after a
  manual unblock or in a nightly) nor `soft_fail: true` (its failure does not
  fail the build). A mirror inherits both flags from its NVIDIA parent unless
  the block overrides them, matching `_get_amd_mirror_effective_step` in the
  generator. `autorun_on_main` is surfaced as a badge but does not change the
  gating classification, because such jobs are still optional on pull
  requests.

Only eligible NVIDIA steps count toward parity. CPU-only steps (some of which
also have AMD mirrors) are excluded and their count is reported so the totals
reconcile with the YAML.

## Parity exclusions

NVIDIA jobs without a declared AMD mirror are excluded for whole-word labels
`FlashInfer`, `DeepGEMM`, `Humming`, `AsyncTP`, `Spark`, `B200` or `NIXL-EP`
(case-insensitive). NIXL-EP also accepts space/underscore separators. Labels
containing `Fault Tolerance` and `E2E` identify the current NIXL-EP suite;
AMD DI coverage is tracked separately. Devices `b200`, `b200-k8s` and `dgx-spark`
are excluded even when the hardware is absent from the label.
Unmirrored labels containing both `Fusion` and `E2E` are also outside this plan;
compiler pass tests remain eligible.

A declared `mirror.amd` always takes precedence. B200 exclusion is a scope
decision, not a claim that every test scheduled there is incompatible with ROCm.

Hardware variants of a mirrored suite are also omitted from the missing-mirror
population. Matching requires different hardware and the same source file, area,
GPU/node counts and normalized suite label,
removing only the vendor prefix, recognized leading hardware annotation and
`Shard %N`. For example, a mirrored H100 Batch Invariance suite removes the
unmirrored A100 variant. Explicit mirrors on multiple platforms are retained.
This is a naming policy, not a proof of identical test selections or passing runs.
Scenario suffixes and topology remain significant; unmatched jobs stay visible.

Rules do not inspect test commands. Generic terms such as `fusion`, `MLA`, `CUDA`,
`DeepSeek`, `Kimi` and `H100` alone do not trigger exclusions.

Both Gating jobs and All jobs use the filtered counts, including area totals,
missing-mirror counts and coverage. The page lists excluded jobs and their reasons
in an expandable section. Every history sample uses the same current rules, so
the trend and current snapshot measure the same population.

## Metric

For any set of eligible NVIDIA jobs:

```
coverage = jobs with a mirror.amd block / eligible NVIDIA jobs
```

The snapshot reports it three ways: `all` (every eligible NVIDIA job), `gating` (the
default view, since those are the jobs a PR must pass), and `nonGating`
(optional or soft-fail jobs). Per-test-area rows carry `all` and `gating`.

## APIs

- `GET /api/parity` returns `{ source, summary, groups, jobs, excluded, skipped }`.
  `source` names the commit the snapshot was read at. `jobs` lists every eligible
  NVIDIA job with its device, shard count, flags, and mirror (or `null`).
  `excluded` contains `{ job, reason }` for each NVIDIA job removed by a scope
  or mirrored-variant rule, preserving its source metadata for inspection.
  Cached one hour at the origin and served stale from the CDN for a day.
- `GET /api/parity/history?weeks=26` returns weekly `samples`, oldest first.
  Each sample is the last commit that touched `.buildkite/test_areas` on or
  before that UTC day, with its `all` and `gating` counts. `weeks` is clamped
  to 4–52. Weeks before the directory existed produce no sample.

Both routes read GitHub with `GITHUB_TOKEN` when set. History costs one
commits-API call per week plus one contents-API call and one raw fetch per
YAML file per distinct commit; parsed files are cached by blob sha so
unchanged files are fetched once across all samples.

On a GitHub failure the routes return `502`, or `503` with `Retry-After` when
the API rate limit is exhausted, and never cache the error.

## Code

- `src/lib/gpu-parity.ts` — pure classification and counting, unit tested in
  `gpu-parity.test.ts`.
- `src/lib/gpu-parity-source.ts` — GitHub reads, blob cache, weekly sampling.
- `src/app/api/parity/route.ts`, `src/app/api/parity/history/route.ts`.
- `src/app/parity/page.tsx`, `src/components/parity-trend-chart.tsx`.
