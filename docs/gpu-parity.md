# NVIDIA to AMD gating parity

The Parity page (`/parity`) answers one question: of the gating test jobs
vLLM runs on NVIDIA GPUs and includes in AMD parity, how many declare an AMD mirror?
The page shows gating jobs only, with no all-jobs scope selector.

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
- **Gating**, for this view, means `optional` is absent or false. A step with
  `soft_fail: true` remains included, although its failure does not fail the
  build. A mirror inherits both flags unless its block overrides them.
  `soft_fail` and `autorun_on_main` are shown as badges but do not change this
  classification.

Only eligible NVIDIA steps count toward parity. CPU-only steps (some of which
also have AMD mirrors) are excluded and their count is reported so the totals
reconcile with the YAML.

## Parity exclusions

NVIDIA jobs without a declared AMD mirror are excluded when their labels contain
the whole word `FlashInfer` or `DeepGEMM` (case-insensitive). A declared
`mirror.amd` always takes precedence.

The unmirrored A100 Batch Invariance job is also excluded: its AMD coverage is
tracked on the H100 job. Other NVIDIA steps count independently, even if a
similarly named job on another GPU has a mirror.
Fusion, Fault Tolerance, NIXL-EP, Humming and AsyncTP remain eligible. Rules do
not inspect test commands or infer coverage from other CI pipelines.

The page uses gating counts for area totals, missing mirrors, coverage and
history. Its job filter switches between all eligible gating jobs and those
missing a mirror. The expandable exclusions section also lists only gating jobs.
Every history sample uses the same current rules, so the trend and current
snapshot measure the same population.

## Metric

For any set of eligible NVIDIA jobs:

```
coverage = jobs with a mirror.amd block / eligible NVIDIA jobs
```

The page displays `gating` counts using the definition above. An optional or
soft-fail AMD mirror still counts as a declared mirror; each flag is marked
separately alongside its device in the job list. This measures declared
coverage, not passing test results or whether an AMD failure blocks a build.

The APIs retain `all`, `gating` and `nonGating` snapshot counts, plus `all` and
`gating` area/history counts, for compatibility with existing clients.

## APIs

- `GET /api/parity` returns `{ source, summary, groups, jobs, excluded, skipped }`.
  `source` names the commit the snapshot was read at. `jobs` lists every eligible
  NVIDIA job with its device, shard count, flags, and mirror (or `null`).
  `excluded` contains `{ job, reason }` for each NVIDIA job removed by a label
  exclusion, preserving its source metadata for inspection.
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
