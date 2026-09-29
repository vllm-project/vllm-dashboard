# Preview queue traffic locally

The queue view can read the deployed dashboard's public metrics while rendering
your local UI. This needs Node.js 22 or newer and the dashboard's npm dependencies;
it does not need database or Buildkite credentials.

From the repository root, start the data proxy in one terminal:

```bash
node scripts/preview-queue.mjs
```

In a second terminal, start Next.js with queue preview enabled:

```bash
QUEUE_PREVIEW=1 npm run dev -- --hostname 0.0.0.0
```

Open [http://localhost:3000/queue](http://localhost:3000/queue). Keep both processes
running while reviewing the page. Stop them with Ctrl+C when finished.

The traffic view opens with **All queues** selected. Its buttons are ordered
**All queues**, **CUDA**, then **ROCm**. All queues includes every queue,
including CPU, TPU, utility queues, and queues excluded from the CUDA and ROCm
groups. All queues and CUDA use history lines and a heatmap to show each queue's
reported P95 waiting-job age: elapsed time since waiting jobs became runnable.
Rankings compare current, mean, and peak reported P95 and waiting-job backlog.
P95 describes jobs still waiting at each observation, rather than the queue
latency of completed jobs. The view does not pool percentiles across queues.

All queues initially displays the top 20 ranked rows in the activity table;
expand it to see the rest. Its wait history chart shows up to 10 ranked queues
with reported historical P95 values to keep the legend readable. Use hardware
family or individual queue filters to narrow the chart and table.

CUDA includes explicitly recognized GPU queues, with CPU, TPU, ROCm, and utility
queues excluded. The additional excluded queue keys are `gpu_1_queue`, `H100`,
`moc-a100`, `RedHat-H100-Frankfurt`, `RedHat-L4`, `b300-8`, `gb300-slurm`, `A100`,
`a100_queue`, `RedHat-A100-WDC`, `RedHat-H100-WDC`, and `gh200_queue`; exclusion
matching also handles the corresponding recognized aliases. The nine currently
observed included queues are `h200_35gb`, `h200_18gb`, `l4-k8s`,
`mithril-h100-pool`, `b200-k8s`, `H200`, `dgx-spark`, `gpu_4_queue`, and
`RedHat-L4-GCP`. Hardware family and queue filters narrow the view further.

Current wait readings use the raw snapshot with the same timestamp as the fresh
queue counts. The API's latest percentile fields can contain a value from an
earlier poll, so they are not used to label a queue's current P95. If the matching
snapshot has no P95, current wait remains unavailable. An idle queue with no
waiting jobs is a separate state, and a reported zero-second P95 is valid.

Missing history stays missing. Mean P95 includes only reported P95 samples;
recorded idle observations do not supply synthetic zeroes. Wait coverage shows
the share of expected buckets with a P95 reading or a recorded idle state,
making unavailable readings visible. For ranges longer than six hours, the API
averages saved P95 values within each bucket. Historical means and peaks are
therefore summaries of the reported buckets, rather than percentiles recomputed
from individual jobs. An averaged bucket can retain a P95 even when its average
waiting-job count rounds to zero.

Select **ROCm** to review normalized utilization against configured job
limits for 12 queues, including the 785-job total and DPX's 240-job limit. All
configured queue limits total 821 concurrent jobs. The ROCm view's 16 queue
exclusions apply to filters, traffic, and inventory. Its
heatmap shows average observed utilization and the share of recorded buckets at
or above 90%. All groups show gaps and observation coverage. Historical
utilization uses current limits, and bucket averages do not measure exact time
at capacity. The capacity reference lists each queue's family and max-in-flight
job limit. MI300's 1- and 2-GPU queue limits are 227 and 32; MI355's 1-, 2-, 4-,
and 8-GPU queue limits are 80, 24, 42, and 3. MI355's 4-GPU allocation appears
as one combined row.

The family cards sum each queue's configured GPU allocation: MI250 has 190 GPUs,
MI300 has 375, and MI355 has 440. Normal queues use max-in-flight jobs times GPUs
per job. DPX has 15 nodes × 8 GPUs, contributing 120 GPUs to MI355 independently
of its 240-job concurrency limit.

ROCm history offers **Jobs** and **Wait time**. Jobs stacks running and waiting
counts against the configured limit; the yellow band's upper edge equals
running plus waiting jobs. Wait time shows each queue's reported P95 using the
wait-age semantics above. Select it with `chart=wait`; legacy
`chart=utilization` links also open Wait time. The ROCm cards, utilization
heatmap, rankings, and capacity reference apply to either history option.

Direct links for reviewing each view:

- [All queues](http://localhost:3000/queue) — also selected by `group=all`.
- [CUDA traffic](http://localhost:3000/queue?view=traffic&group=cuda).
- [ROCm traffic](http://localhost:3000/queue?view=traffic&group=rocm) — legacy
  `group=amd` traffic links also select ROCm.
- [Queue details](http://localhost:3000/queue?view=details) — preserves access
  to all queues. Existing `?queue=...` links open this view.

The proxy listens on `127.0.0.1:3101` and only forwards GET requests for
`/api/metrics` and `/api/queue/jobs` to `https://ci.vllm.ai`. Queue promotion and
other API endpoints are unavailable through the proxy. It forwards no browser
cookies, authorization headers, or local credentials. Each response identifies
the source with `previewSource` and the `X-Queue-Preview-Source` header.

The data is real public queue history, including the upstream cache and collection
delay. Check the page's sample time when interpreting current traffic. Failed
reads show an error; the preview does not substitute generated data. Transient
gateway failures receive one retry within a 20-second request deadline.

The Next.js rewrite only applies when `QUEUE_PREVIEW=1` in development. Start
`npm run dev` without that flag to use the normal local API and credentials.
