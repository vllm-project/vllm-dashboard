# Preview queue traffic locally

Use Node.js 22 or later. From the repository root, run `npm ci` if dependencies are not installed. This preview uses public queue data without database or Buildkite credentials.

Start the app:

```bash
QUEUE_PREVIEW=1 npm run dev -- --hostname 0.0.0.0
```

Open [Queue details](http://localhost:3000/queue), the default view, or [Traffic & utilization](http://localhost:3000/queue?view=traffic). Traffic starts with **All queues**; use the [CUDA](http://localhost:3000/queue?view=traffic&group=cuda) or [ROCm](http://localhost:3000/queue?view=traffic&group=rocm) filter to narrow it. Stop the app with Ctrl+C.

All queues and CUDA default to waiting-job counts. Queues with no connected agents are listed separately and excluded from waiting summaries. A P95 wait view is available when percentile readings exist. P95 describes sampled waiting age per queue; idle queues, missing readings, and valid zero-second readings remain distinct.

The CUDA filter includes L4 queues (`l4`, `l4-k8s`, `gpu1`/`gpu4`/`gpu8`, and `gpu_1_queue`/`gpu_4_queue`/`gpu_8_queue`) and GH200 queues, alongside the other known NVIDIA GPU families.

Current summaries use readings no more than 20 minutes old. Missing or stale readings stay unknown. History retains partially observed buckets, shows their queue coverage, and leaves buckets with no observations empty. ROCm utilization divides observed running jobs by the configured limits for those same observed queues; history uses current limits. In the ROCm stacked Jobs chart, the yellow band's upper edge is running plus waiting jobs.

History uses five-minute polls for ranges up to six hours, 15-minute buckets up to 24 hours, hourly buckets up to seven days, and six-hour buckets beyond that. Aggregated P95 values are averages of saved readings; displayed means and peaks describe those reported buckets.

With `QUEUE_PREVIEW=1` in development, Next.js rewrites `/api/metrics` and `/api/queue/jobs` directly to `https://ci.vllm.ai`. Only the app process is needed. Data includes upstream polling and cache delays. Omit the flag to use the normal local API.
