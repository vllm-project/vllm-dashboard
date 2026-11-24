# NVIDIA to AMD gating parity (API only)

> The Parity page was replaced by the Platform Scope page; see
> [platform-scope.md](platform-scope.md). `/parity` redirects to `/platforms`.
> The `/api/parity` and `/api/parity/history` routes below remain for existing
> clients.

The Parity page answered one question: of the gating test jobs
vLLM runs on NVIDIA GPUs and includes in AMD parity, how many also run on AMD?
The page shows gating jobs only, with no all-jobs scope selector.

## Source

Everything is read from `.buildkite/test_areas/*.yaml` on
`vllm-project/vllm` `main`, the same files the pipeline generator in
`vllm-project/ci-infra` turns into Buildkite steps. Nothing is inferred from
Buildkite job history. Counts depend on the YAML and the dashboard's label
exclusion rules below.

Each file is one test area (`group`) with a list of `steps`. A step is
written in one of two forms, and the dashboard reads both:

- **`devices:`** (current): the step names its hardware only as the keys of a
  `devices:` map, one job per device, plus more jobs on a device under its
  `variants:`; `same_as` copies an earlier device of the same vendor. The
  dashboard compiles it exactly as the generator does
  (`src/lib/buildkite-devices.ts`, a port of ci-infra's `step_vendors.py` and
  its device registry): the first non-AMD job is a step, the AMD job keyed
  `amd-<key>` is that step's mirror (marked `_exact`: it inherits nothing from
  the step), and every other job (a second NVIDIA device, a variant, an
  AMD-only or CPU test) is a step of its own. Labels and keys come from the
  registry: `:nvidia: (H100) V1 Attention`, `[Nightly]` from `optional: true`,
  `amd-<key>` for the first AMD device and `<key>-<key_tag>` for a further
  one. A step that does not compile is logged and left out.
- **Legacy** `device:` + `mirror.amd`: one NVIDIA (or CPU, AMD) step, whose
  `mirror.amd` block the generator emits as an `amd-<key>` step.

Each compiled or legacy step is then one job:

- **Vendor** comes from `device` first (a `devices:` job's device key),
  using the generator's `DeviceType` names (`h100`, `h200_35gb`, `l4`, `b200-k8s`, `a100`, `gh200`, `dgx-spark`
  are NVIDIA; `cpu-*`, `intel_cpu`, `amd_cpu`, `zen5` are CPU; `mi###_N` is
  AMD), then from the label shortcode (`:nvidia:`, `:amd:`, `:computer:`).
  Files written before mid-2026 often had neither; the generator sent those
  steps to its default GPU queue, so a step with no device is NVIDIA unless
  it is `no_gpu: true`, a `:docker:` build, or the documentation build (all
  CPU), and a legacy `gpu:` key is NVIDIA. This keeps the weekly history
  comparable across the format change. A device the generator does not know,
  with no shortcode to fall back on, is reported under `skipped.unknown`
  rather than dropped silently.
- **Mirrored** means the step has an AMD job: a `mirror.amd` block, or the
  AMD device of a `devices:` step keyed `amd-<key>`. The generator emits it as
  an `amd-<key>` step on that AMD device.
- **Gating**, for this view, means `optional` is absent or false. A step with
  `soft_fail: true` remains included, although its failure does not fail the
  build. A legacy mirror inherits both flags unless its block overrides
  them; the AMD job of a `devices:` step has only its own.
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
coverage = jobs with an AMD job (mirror) / eligible NVIDIA jobs
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
  NVIDIA job with its device, GPU count (an AMD device always has its
  pool's, e.g. 4 for `mi355_4`), shard count, flags, and mirror (or `null`).
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

- `src/lib/buildkite-devices.ts` — compiles `devices:` steps (registry, keys,
  labels, `same_as`, variants), tested in `buildkite-devices.test.ts`.
- `src/lib/gpu-parity.ts` — pure classification and counting, unit tested in
  `gpu-parity.test.ts`.
- `src/lib/gpu-parity-source.ts` — GitHub reads, blob cache, weekly sampling.
- `src/app/api/parity/route.ts`, `src/app/api/parity/history/route.ts`.
