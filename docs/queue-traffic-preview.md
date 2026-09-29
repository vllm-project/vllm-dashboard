# Preview queue traffic locally

Use Node.js 22 or later. From the repository root, run `npm ci` if dependencies are not installed. This preview uses public queue data without database or Buildkite credentials.

Start the proxy in one terminal:

```bash
node scripts/preview-queue.mjs
```

Start the app in a second terminal:

```bash
QUEUE_PREVIEW=1 npm run dev -- --hostname 0.0.0.0
```

Open [All queues](http://localhost:3000/queue), [CUDA](http://localhost:3000/queue?view=traffic&group=cuda), or [ROCm](http://localhost:3000/queue?view=traffic&group=rocm). Keep both processes running; stop them with Ctrl+C.

Wait time shows each queue's P95 age of jobs still waiting since they became runnable. It does not measure completed-job latency or pool percentiles across queues. Missing or stale current readings stay unknown; idle queues and valid zero-second readings remain distinct.

ROCm utilization is running jobs divided by the configured limit. In its stacked Jobs chart, the yellow band's upper edge is running plus waiting jobs. History uses current limits. Ranges over six hours average saved P95 readings, so means and peaks describe reported buckets.

The proxy listens on `127.0.0.1:3101` and forwards only GET requests for `/api/metrics` and `/api/queue/jobs` to `https://ci.vllm.ai`, without cookies or credentials. Data includes upstream polling and cache delays.

The rewrite applies only in development with `QUEUE_PREVIEW=1`. Omit the flag to use the normal local API.
