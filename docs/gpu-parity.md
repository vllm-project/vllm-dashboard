# NVIDIA to AMD gating parity

The Parity page (`/parity`) and its APIs answer one question: of the test jobs
vLLM runs on NVIDIA GPUs, how many also run on AMD?

## Source

Everything is read from `.buildkite/test_areas/*.yaml` on
`vllm-project/vllm` `main`, the same files the pipeline generator in
`vllm-project/ci-infra` turns into Buildkite steps. Nothing is inferred from
Buildkite job history, so the metric moves only when a YAML file changes.

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

Only NVIDIA steps count toward parity. CPU-only steps (some of which also have
AMD mirrors) are excluded and their count is reported so the totals reconcile
with the YAML.

## Metric

For any set of NVIDIA jobs:

```
coverage = jobs with a mirror.amd block / NVIDIA jobs
```

The snapshot reports it three ways: `all` (every NVIDIA job), `gating` (the
default view, since those are the jobs a PR must pass), and `nonGating`
(optional or soft-fail jobs). Per-test-area rows carry `all` and `gating`.

## APIs

- `GET /api/parity` returns `{ source, summary, groups, jobs, skipped }`.
  `source` names the commit the snapshot was read at. `jobs` lists every
  NVIDIA job with its device, shard count, flags, and mirror (or `null`).
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
