import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQueueActivity,
  buildTrafficHistory,
  CUDA_FAMILIES,
  filterQueues,
  getQueueCapacity,
  getQueueWaitP95,
  isAmdQueue,
  isCudaQueue,
  QUEUE_CAPACITY,
  QUEUE_FAMILIES,
  queueFamily,
  summarizeQueues,
  type QueueMetric,
} from "./queue-capacity";

function metric(
  queue: string,
  overrides: Partial<QueueMetric> = {},
): QueueMetric {
  return {
    queue,
    agents_total: 10,
    agents_busy: 5,
    jobs_running: 5,
    jobs_scheduled: 0,
    jobs_waiting: 0,
    ...overrides,
  };
}

test("node reallocations update queue limits and conserve GPU equivalents", () => {
  for (const [queue, maxInFlight] of Object.entries({
    amd_mi300_1: 227,
    amd_mi300_2: 32,
    amd_mi355_1: 80,
    amd_mi355_2: 24,
    amd_mi355_4: 42,
    amd_mi355_8: 3,
    mi355_perf_eval: 3,
    mi300_perf_eval: 1,
  })) {
    assert.equal(getQueueCapacity(queue)!.maxInFlight, maxInFlight, queue);
  }
  const mi355 = getQueueCapacity("amd_mi355_4")!;
  assert.equal(mi355.gpuCount, 168);
  assert.equal(mi355.nodeEquivalent, 21);
  assert.equal(mi355.allocations.length, 1);

  const familyTotals = new Map<string, number>();
  for (const row of QUEUE_CAPACITY) {
    familyTotals.set(
      row.family,
      (familyTotals.get(row.family) ?? 0) + (row.nodeEquivalent ?? 0),
    );
  }
  assert.deepEqual(Object.fromEntries(familyTotals), {
    MI250: 25.75,
    "AMD CPU": 3.75,
    MI300: 47.875,
    MI355: 58,
  });
});

test("DPX records 15 eight-GPU nodes independently of its 240-job limit", () => {
  const dpx = getQueueCapacity("amd_mi355_dpx")!;
  assert.equal(dpx.family, "MI355");
  assert.equal(dpx.maxInFlight, 240);
  assert.equal(dpx.gpusPerJob, null);
  assert.equal(dpx.gpuCount, 120);
  assert.equal(dpx.nodeEquivalent, 15);
  const cpu = getQueueCapacity("amd-cpu")!;
  assert.equal(cpu.gpusPerJob, null);
  assert.equal(cpu.gpuCount, null);
  assert.equal(cpu.nodeEquivalent, 3.75);
});

test("capacity aliases and hardware families are independent of view exclusions", () => {
  assert.deepEqual(
    getQueueCapacity("mi250_1"),
    getQueueCapacity("amd_mi250_1"),
  );
  assert.deepEqual(getQueueCapacity("amd_cpu"), getQueueCapacity("amd-cpu"));
  for (const queue of [
    "amd_mi325_1",
    "amd_mi300_16",
    "mi300_perf_eval_internal",
    "router_rocm",
  ]) {
    assert.equal(getQueueCapacity(queue), null, queue);
    assert.equal(isAmdQueue(queue), true, queue);
  }
  assert.equal(queueFamily("amd_mi325_1"), "Other ROCm");
  assert.equal(queueFamily("amd_mi300_16"), "MI300");
  for (const queue of ["amd-cpu-small", "amd-cpu-medium", "amd-zen5-cpu"]) {
    assert.equal(queueFamily(queue), "AMD CPU");
    assert.equal(getQueueCapacity(queue), null);
  }
  assert.equal(queueFamily("router_rocm_mi300_2"), "MI300");
  assert.equal(getQueueCapacity("router_rocm_mi300_2"), null);
  const queues = [
    "amd_mi250_1",
    "amd_mi250_8",
    "amd-cpu",
    "amd_mi325_1",
    "router_rocm",
    "gpu_1_queue",
    "H100",
    "cpu_queue_premerge",
    "tpu_v7x_8_queue",
    "unknown",
  ].map((queue) => metric(queue));
  assert.deepEqual(filterQueues(queues), queues);
  assert.deepEqual(filterQueues(queues, "all"), queues);
  assert.deepEqual(
    filterQueues(queues, "all", "MI250").map((row) => row.queue),
    ["amd_mi250_1", "amd_mi250_8"],
  );
  assert.deepEqual(
    filterQueues(queues, "all", "H100").map((row) => row.queue),
    ["H100"],
  );
  assert.deepEqual(QUEUE_FAMILIES, [
    "L4", "A100", "H100", "H200", "B200", "B300", "GB300", "GH200",
    "DGX Spark", "MI250", "AMD CPU", "MI300", "MI355", "Other ROCm", "Other",
  ]);
  assert.deepEqual(
    filterQueues(queues, "rocm").map((row) => row.queue),
    ["amd_mi250_1", "router_rocm"],
  );
  assert.deepEqual(
    filterQueues(queues, "rocm", "MI250").map((row) => row.queue),
    ["amd_mi250_1"],
  );
});

test("CUDA includes known GPU queues without inferring capacity", () => {
  const included = [
    "gpu1", "gpu4", "gpu8", "gpu_1_queue", "gpu_4_queue", "gpu_8_queue",
    "B200", "b200-k8s",
    "mithril-h100-pool", "H200", "h200_18gb", "h200_35gb", "l4", "l4-k8s",
    "RedHat-L4-GCP", "dgx-spark",
    "H100", "moc-a100", "RedHat-H100-Frankfurt", "RedHat-L4",
    "b300-8", "gb300-slurm", "A100", "a100_queue", "RedHat-A100-WDC",
    "RedHat-H100-WDC", "gh200_queue", "gh200",
  ].map((queue) => metric(queue));
  const excluded = [
    "cpu_queue_premerge", "arm64_cpu_queue_postmerge", "amd-cpu", "intel-cpu",
    "tpu_v7x_8_queue", "Intel-XPU-B60", "intel-gpu", "intel-gpu-omni",
    "intel-hpu", "ascend", "ibm_s390x", "macmini", "bootstrap", "default",
    "default-queue", "kickoff", "kube", "packer_build_queue",
    "RedHat-ModelOpt-Util", "amd_mi300_1", "amd_mi355_dpx", "router_rocm",
    "unknown", "gpu_1_queue_cpu", "redhat-cpu-h100", "gpu",
  ].flatMap((queue) => [queue, queue.toUpperCase()]).map((queue) =>
    metric(queue, { jobs_running: 100, jobs_scheduled: 50, p95_wait_secs: 900 }),
  );
  const rows = [...included, ...excluded];
  assert.deepEqual(filterQueues(rows, "cuda"), included);
  assert.deepEqual(
    filterQueues(rows, "cuda", "B200").map((row) => row.queue),
    ["B200", "b200-k8s"],
  );
  for (const row of included) {
    assert.equal(isCudaQueue(row.queue), true, row.queue);
    assert.equal(isCudaQueue(row.queue.toUpperCase()), true, row.queue);
    assert.equal(getQueueCapacity(row.queue), null, row.queue);
  }
  for (const row of excluded) {
    assert.equal(isCudaQueue(row.queue), false, row.queue);
  }
  assert.deepEqual(
    [...new Set(included.map((row) => queueFamily(row.queue)))],
    ["L4", "B200", "H100", "H200", "DGX Spark", "A100", "B300", "GB300", "GH200"],
  );
  assert.deepEqual(CUDA_FAMILIES, [
    "L4", "A100", "H100", "H200", "B200", "B300", "GB300", "GH200", "DGX Spark",
  ]);
  for (const queue of ["gpu1", "gpu4", "gpu8", "gpu_1_queue", "gpu_4_queue", "gpu_8_queue"]) {
    assert.equal(queueFamily(queue), "L4", queue);
  }
  assert.equal(queueFamily("A100"), "A100");
  assert.equal(queueFamily("H100"), "H100");
  assert.equal(queueFamily("gh200_queue"), "GH200");
  const summary = summarizeQueues(filterQueues(rows, "cuda"));
  assert.equal(summary.running, included.length * 5);
  assert.equal(summary.waiting, 0);
  assert.equal(summary.knownQueueCount, 0);
  assert.equal(summary.maxInFlight, 0);
  assert.equal(summary.jobLimitUtilization, null);
  const history = excluded.map((row) => ({
    ...row,
    time_bucket: "2026-09-28T12:00:00Z",
  }));
  const activity = buildQueueActivity(
    history,
    1,
    filterQueues(rows, "cuda").map((row) => row.queue),
    5,
    Date.parse("2026-09-28T12:00:00Z"),
  );
  assert.ok(activity.every((row) => row.observedBuckets === 0));
  assert.ok(activity.every((row) => row.averageWaitP95 === null));
});

test("wait P95 accepts real zero and rejects missing or invalid measurements", () => {
  for (const p95_wait_secs of [undefined, null, -1, NaN, Infinity, -Infinity]) {
    assert.equal(getQueueWaitP95(metric("H200", { p95_wait_secs })), null);
  }
  for (const p95_wait_secs of [0, 0.5, 120]) {
    assert.equal(
      getQueueWaitP95(metric("H200", { p95_wait_secs })),
      p95_wait_secs,
    );
  }
  assert.equal(
    getQueueWaitP95(metric("H200", { p95_wait_secs: "120" as unknown as number })),
    null,
  );
});

test("ROCm view preserves exclusions and the reallocated 785-job limit", () => {
  const excluded = [
    "amd_gfx950",
    "amd_mi250_8",
    "amd_mi325_1",
    "amd_mi325_2",
    "amd_mi325_4",
    "amd_mi325_8",
    "amd_mi350_ainic",
    "amd_mi355_vime_rl",
    "amd_shadow",
    "amd-cpu",
    "amd-cpu-medium",
    "amd-cpu-small",
    "amd-zen5-cpu",
    "mi300_perf_eval",
    "mi355_perf_eval",
    "router_rocm_mi300_2",
    "amd_cpu",
    "mi250_8",
  ].map((queue) => metric(queue, { jobs_running: 100, jobs_scheduled: 50 }));
  const included = [
    "amd_mi250_1",
    "amd_mi300_1",
    "amd_mi355_dpx",
  ].map((queue) => metric(queue));
  const rows = [...included, ...excluded];
  const filtered = filterQueues(rows, "rocm");
  assert.deepEqual(filtered, included);
  assert.deepEqual(filterQueues(rows, "cuda"), []);
  assert.deepEqual(filterQueues(rows, "rocm", "MI300"), [included[1]]);
  assert.equal(summarizeQueues(filtered).running, 15);
  assert.equal(summarizeQueues(filtered).waiting, 0);

  const inventory = QUEUE_CAPACITY.map((row) => metric(row.queue));
  const rocm = summarizeQueues(filterQueues(inventory, "rocm"));
  assert.equal(rocm.maxInFlight, 785);
  assert.equal(summarizeQueues(inventory).maxInFlight, 821);
});

test("utilization compares running jobs with supplied queue concurrency limits", () => {
  const rows = [
    metric("amd_mi250_1", {
      jobs_running: 39,
      agents_total: 50,
      agents_busy: 40,
    }),
    metric("amd_mi250_8", { jobs_running: 2, agents_total: 3, agents_busy: 2 }),
    metric("amd-cpu", { jobs_running: 30, agents_total: 30, agents_busy: 30 }),
  ];
  const summary = summarizeQueues(rows);
  assert.equal(summary.running, 71);
  assert.equal(summary.jobLimitUtilization, (71 / 110) * 100);
  assert.equal(summary.knownQueueCount, 3);
  assert.equal(summary.nearLimitQueueCount, 2);
});

test("unknown queues contribute traffic but never dilute known capacity metrics", () => {
  const summary = summarizeQueues([
    metric("amd_mi250_8", { jobs_running: 2 }),
    metric("amd_mi325_1", { jobs_running: 100 }),
  ]);
  assert.equal(summary.running, 102);
  assert.equal(summary.knownRunning, 2);
  assert.equal(summary.jobLimitUtilization, 100);
  assert.equal(summary.maxInFlight, 2);
  assert.equal(summary.unknownQueueCount, 1);
  assert.deepEqual(summary.unknownQueues, ["amd_mi325_1"]);
});

test("unobserved queues do not enter denominators and excess demand remains visible", () => {
  const summary = summarizeQueues([
    metric("amd_mi250_8", { jobs_running: 3, agents_total: 2, agents_busy: 3 }),
  ]);
  assert.equal(summary.maxInFlight, 2);
  assert.equal(summary.jobLimitUtilization, 150);
  assert.equal(summary.nearLimitQueueCount, 1);
});

test("queues without supplied limits cannot report utilization", () => {
  const unknown = summarizeQueues([
    metric("unknown", { agents_total: 0, agents_busy: 0 }),
  ]);
  assert.equal(unknown.jobLimitUtilization, null);
  assert.equal(unknown.nearLimitQueueCount, 0);
  const cpu = summarizeQueues([metric("amd-cpu", { jobs_running: 15 })]);
  assert.equal(cpu.jobLimitUtilization, 50);
  assert.equal(summarizeQueues([]).jobLimitUtilization, null);
});

test("traffic waiting totals preserve canonical and legacy queue semantics", () => {
  const summary = summarizeQueues([
    metric("amd_mi250_1", { jobs_scheduled: 7, jobs_waiting: 0 }),
    metric("amd_mi250_2", { jobs_scheduled: 10, jobs_waiting: 3 }),
    metric("gpu_1_queue", { jobs_scheduled: 4, jobs_waiting: 100 }),
  ]);
  assert.equal(summary.waiting, 14);
  assert.equal(summary.waitingQueueCount, 3);
});

test("near-limit queues include the 90 percent boundary and exclude unknown limits", () => {
  const summary = summarizeQueues([
    metric("amd_mi355_dpx", { jobs_running: 216 }),
    metric("amd_mi355_2", { jobs_running: 17 }),
    metric("amd_mi250_8", { jobs_running: 3 }),
    metric("unknown", { jobs_running: 1000, jobs_scheduled: 4 }),
  ]);
  assert.equal(summary.nearLimitQueueCount, 2);
  assert.equal(summary.waitingQueueCount, 1);
});

test("duplicate aliases count capacity once and prefer the freshest reading", () => {
  const summary = summarizeQueues([
    metric("amd_mi250_8", {
      jobs_running: 1,
      polled_at: "2026-09-28T12:00:00Z",
    }),
    metric("mi250_8", { jobs_running: 2, polled_at: "2026-09-28T12:05:00Z" }),
  ]);
  assert.equal(summary.queueCount, 1);
  assert.equal(summary.maxInFlight, 2);
  assert.equal(summary.running, 2);
  assert.equal(summary.jobLimitUtilization, 100);
});

function snapshot(queue: string, time: string, jobs_running = 1) {
  return {
    ...metric(queue, { jobs_running }),
    time_bucket: `2026-09-28T${time}Z`,
  };
}

test("history aligns poll drift and never carries missing queue readings forward", () => {
  const history = buildTrafficHistory(
    [
      snapshot("amd_mi250_1", "12:00:02"),
      snapshot("amd_mi250_8", "12:00:45"),
      snapshot("amd_mi250_1", "12:05:02"),
      snapshot("amd_mi250_1", "12:15:02"),
      snapshot("amd_mi250_8", "12:15:45"),
    ],
    5,
    ["amd_mi250_1", "amd_mi250_8"],
  );
  assert.equal(history.length, 4);
  assert.equal(history[0].time, Date.parse("2026-09-28T12:00:00Z"));
  assert.deepEqual(
    history.map((point) => point.running),
    [2, 1, null, 2],
  );
  assert.deepEqual(
    history.map((point) => point.maxInFlight),
    [80, 78, null, 80],
  );
  assert.deepEqual(
    history.map((point) => point.limitUtilization),
    [2.5, (1 / 78) * 100, null, 2.5],
  );
  assert.deepEqual(history.map((point) => point.observedQueueCount), [2, 1, 0, 2]);
  assert.ok(history.every((point) => point.expectedQueueCount === 2));
  assert.equal(history[1].waiting, 0);
  assert.equal(history[2].waiting, null);
  assert.equal(history[2].limitUtilization, null);
});

test("history uses the latest per-queue reading and ignores unselected queues", () => {
  const history = buildTrafficHistory(
    [
      snapshot("amd_mi250_8", "12:00:02", 1),
      snapshot("mi250_8", "12:04:02", 2),
      snapshot("gpu_1_queue", "12:10:00", 100),
    ],
    5,
    ["amd_mi250_8", "mi250_8"],
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].running, 2);
  assert.equal(history[0].limitUtilization, 100);
  assert.deepEqual(buildTrafficHistory([], 5, ["amd_mi250_8"]), []);
  assert.deepEqual(
    buildTrafficHistory([snapshot("amd_mi250_8", "12:00:00")], 5, []),
    [],
  );
});

test("new, retired, and unobserved queues do not erase available traffic or inflate capacity", () => {
  const history = buildTrafficHistory(
    [
      snapshot("amd_mi250_1", "12:00:00", 39),
      snapshot("amd_mi355_4", "12:10:00", 21),
    ],
    5,
    ["amd_mi250_1", "amd_mi355_4", "amd_mi300_1"],
  );
  assert.deepEqual(history.map((point) => point.running), [39, null, 21]);
  assert.deepEqual(history.map((point) => point.maxInFlight), [78, null, 42]);
  assert.deepEqual(history.map((point) => point.limitUtilization), [50, null, 50]);
  assert.deepEqual(history.map((point) => point.observedQueueCount), [1, 0, 1]);
  assert.ok(history.every((point) => point.expectedQueueCount === 3));
});

test("waiting history ignores queues without agents and preserves their running observations", () => {
  const history = buildTrafficHistory(
    [
      {
        ...snapshot("H200", "12:00:00", 0),
        agents_total: 0,
        jobs_scheduled: 999,
      },
      { ...snapshot("gpu1", "12:00:00", 2), jobs_scheduled: 3 },
      {
        ...snapshot("H200", "12:05:00", 0),
        agents_total: 0,
        jobs_scheduled: 999,
      },
    ],
    5,
    ["H200", "gpu1"],
  );
  assert.deepEqual(history.map((point) => point.waiting), [3, null]);
  assert.deepEqual(history.map((point) => point.running), [2, 0]);
  assert.deepEqual(history.map((point) => point.observedQueueCount), [2, 1]);
});

test("history uses explicit API bucket sizes including nonstandard widths", () => {
  for (const stepMinutes of [5, 15, 30, 60, 360]) {
    const history = buildTrafficHistory(
      [
        snapshot("amd_mi250_8", "00:00:00"),
        snapshot("amd_mi250_8", "12:00:00"),
      ],
      stepMinutes,
      ["amd_mi250_8"],
    );
    assert.equal(history[1].time - history[0].time, stepMinutes * 60_000);
    assert.equal(history[1].running, null);
  }
});

test("activity distinguishes idle observations from leading, internal, and trailing gaps", () => {
  const [activity] = buildQueueActivity(
    [
      snapshot("amd_mi250_8", "12:05:02", 0),
      {
        ...snapshot("amd_mi250_8", "12:15:02", 1.8),
        jobs_scheduled: 3,
      },
    ],
    0.5,
    ["amd_mi250_8"],
    5,
    Date.parse("2026-09-28T12:25:30Z"),
  );
  assert.deepEqual(
    activity.samples.map((sample) => sample.utilization),
    [null, 0, null, 90, null, null],
  );
  assert.deepEqual(
    activity.samples.map((sample) => sample.waiting),
    [null, 0, null, 3, null, null],
  );
  assert.equal(activity.samples[0].time, Date.parse("2026-09-28T12:00:00Z"));
  assert.equal(activity.averageUtilization, 45);
  assert.equal(activity.averageRunning, 0.9);
  assert.equal(activity.nearLimitPercent, 50);
  assert.equal(activity.observedBuckets, 2);
  assert.equal(activity.expectedBuckets, 6);
  assert.equal(activity.coveragePercent, (2 / 6) * 100);
});

test("activity normalizes each queue by its own limit and deduplicates aliases", () => {
  const activity = buildQueueActivity(
    [
      { ...snapshot("amd_mi250_8", "12:00:02", 1), p95_wait_secs: 100 },
      { ...snapshot("mi250_8", "12:04:02", 2), p95_wait_secs: 20 },
      { ...snapshot("amd_mi355_dpx", "12:00:02", 120), p95_wait_secs: 300 },
      snapshot("unknown", "12:00:02", 1000),
      snapshot("gpu_1_queue", "13:00:00", 100),
    ],
    1,
    ["mi250_8", "amd_mi250_8", "amd_mi355_dpx", "unknown"],
    5,
  );
  assert.deepEqual(
    activity.map((row) => row.queue),
    ["amd_mi250_8", "amd_mi355_dpx", "unknown"],
  );
  assert.deepEqual(
    activity.map((row) => row.averageUtilization),
    [100, 50, null],
  );
  assert.deepEqual(activity.map((row) => row.nearLimitPercent), [100, 0, null]);
  assert.deepEqual(activity.map((row) => row.averageWaitP95), [20, 300, null]);
  assert.deepEqual(activity.map((row) => row.peakWaitP95), [20, 300, null]);
  for (const row of activity) {
    assert.equal(row.samples.at(-1)!.time, Date.parse("2026-09-28T12:00:00Z"));
    assert.equal(row.observedBuckets, 1);
    assert.equal(row.expectedBuckets, 12);
    assert.equal(row.coveragePercent, (1 / 12) * 100);
  }
  assert.equal(activity[0].samples.at(-1)!.running, 2);
  assert.equal(activity[2].samples.at(-1)!.running, 1000);
  assert.equal(activity[2].samples.at(-1)!.utilization, null);
  assert.equal(activity[2].averageRunning, 1000);
});

test("wait activity excludes missing measurements from means and distinguishes idle from zero", () => {
  const [activity] = buildQueueActivity(
    [
      snapshot("H200", "12:05:00", 0),
      { ...snapshot("H200", "12:10:00"), jobs_scheduled: 3 },
      {
        ...snapshot("H200", "12:15:00"),
        jobs_scheduled: 1,
        p95_wait_secs: 0,
      },
      {
        ...snapshot("H200", "12:20:00"),
        jobs_scheduled: 2,
        p95_wait_secs: 120,
      },
      {
        ...snapshot("H200", "12:25:00"),
        jobs_scheduled: 2,
        p95_wait_secs: -1,
      },
    ],
    0.5,
    ["H200"],
    5,
    Date.parse("2026-09-28T12:25:00Z"),
  );
  assert.deepEqual(
    activity.samples.map((sample) => sample.waitP95),
    [null, null, null, 0, 120, null],
  );
  assert.deepEqual(
    activity.samples.map((sample) => sample.waiting),
    [null, 0, 3, 1, 2, 2],
  );
  assert.equal(activity.averageWaitP95, 60);
  assert.equal(activity.peakWaitP95, 120);
  assert.equal(activity.waitObservedBuckets, 2);
  assert.equal(activity.waitCoveragePercent, 50);
  assert.equal(activity.coveragePercent, (5 / 6) * 100);
});

test("wait activity excludes no-agent readings from counts, P95, and coverage", () => {
  const [activity] = buildQueueActivity(
    [
      {
        ...snapshot("H200", "12:00:00"),
        agents_total: 0,
        jobs_scheduled: 999,
        p95_wait_secs: 6000,
      },
      {
        ...snapshot("H200", "12:05:00"),
        jobs_scheduled: 2,
        p95_wait_secs: 90,
      },
      {
        ...snapshot("H200", "12:10:00"),
        agents_total: 0,
        p95_wait_secs: 0,
      },
      snapshot("H200", "12:15:00"),
    ],
    0.5,
    ["H200"],
    5,
    Date.parse("2026-09-28T12:25:00Z"),
  );
  assert.deepEqual(
    activity.samples.map((sample) => sample.waiting),
    [null, 2, null, 0, null, null],
  );
  assert.deepEqual(
    activity.samples.map((sample) => sample.waitP95),
    [null, 90, null, null, null, null],
  );
  assert.equal(activity.averageWaiting, 1);
  assert.equal(activity.peakWaiting, 2);
  assert.equal(activity.waitingCoveragePercent, (2 / 6) * 100);
  assert.equal(activity.averageWaitP95, 90);
  assert.equal(activity.peakWaitP95, 90);
  assert.equal(activity.waitObservedBuckets, 1);
  assert.equal(activity.waitCoveragePercent, (2 / 6) * 100);
  assert.equal(activity.observedBuckets, 4);
});

test("activity preserves averaged API values and uses 90 percent of observed buckets", () => {
  const [activity] = buildQueueActivity(
    [
      { ...snapshot("amd_mi355_dpx", "12:00:00", 216), p95_wait_secs: 120 },
      { ...snapshot("amd_mi355_dpx", "12:15:00", 215.76), p95_wait_secs: 31 },
      snapshot("amd_mi355_dpx", "12:45:00", 240),
    ],
    24,
    ["amd_mi355_dpx"],
    15,
  );
  assert.equal(activity.observedBuckets, 3);
  assert.equal(activity.expectedBuckets, 96);
  assert.ok(
    Math.abs(activity.averageUtilization! - (90 + 89.9 + 100) / 3) < 1e-10,
  );
  assert.equal(activity.nearLimitPercent, (2 / 3) * 100);
  assert.equal(activity.coveragePercent, (3 / 96) * 100);
  assert.equal(activity.samples.at(-3)!.running, 215.76);
  assert.equal(activity.samples.at(-3)!.waiting, 0);
  assert.equal(activity.samples.at(-3)!.waitP95, 31);
  assert.equal(activity.averageWaitP95, 75.5);
  assert.equal(activity.peakWaitP95, 120);
  assert.equal(activity.waitObservedBuckets, 2);
  assert.equal(activity.waitCoveragePercent, (3 / 96) * 100);
  assert.equal(activity.samples.at(-2)!.running, null);
});

test("activity uses API bucket widths and ignores observations outside the window", () => {
  for (const [hours, stepMinutes] of [
    [6, 5],
    [24, 15],
    [168, 60],
    [720, 360],
    [24, 30],
  ]) {
    const [activity] = buildQueueActivity(
      [
        {
          ...snapshot("amd_mi250_8", "12:00:00"),
          time_bucket: "2026-01-01T00:00:00Z",
        },
        snapshot("amd_mi250_8", "12:00:00"),
        snapshot("amd_mi250_8", "18:00:00"),
        {
          ...snapshot("amd_mi250_8", "12:00:00"),
          time_bucket: "invalid",
        },
      ],
      hours,
      ["amd_mi250_8"],
      stepMinutes,
      Date.parse("2026-09-28T12:00:00Z"),
    );
    assert.equal(
      activity.samples[1].time - activity.samples[0].time,
      stepMinutes * 60_000,
    );
    assert.equal(activity.expectedBuckets, (hours * 60) / stepMinutes);
    assert.equal(activity.observedBuckets, 1);
  }
});

test("queues without history retain unknown activity and report zero coverage", () => {
  const [activity] = buildQueueActivity(
    [],
    1,
    ["amd_mi355_dpx"],
    5,
    Date.parse("2026-09-28T12:00:00Z"),
  );
  assert.equal(activity.samples.length, 12);
  assert.ok(activity.samples.every((sample) => sample.utilization === null));
  assert.equal(activity.averageUtilization, null);
  assert.equal(activity.averageRunning, null);
  assert.equal(activity.averageWaiting, null);
  assert.equal(activity.peakWaiting, null);
  assert.equal(activity.waitingCoveragePercent, 0);
  assert.ok(activity.samples.every((sample) => sample.waitP95 === null));
  assert.equal(activity.averageWaitP95, null);
  assert.equal(activity.peakWaitP95, null);
  assert.equal(activity.waitCoveragePercent, 0);
  assert.equal(activity.waitObservedBuckets, 0);
  assert.equal(activity.nearLimitPercent, null);
  assert.equal(activity.coveragePercent, 0);
  assert.equal(activity.observedBuckets, 0);
  const [unanchored] = buildQueueActivity([], 1, ["amd_mi355_dpx"], 5);
  assert.deepEqual(unanchored.samples, []);
  assert.equal(unanchored.expectedBuckets, 0);
  assert.deepEqual(buildQueueActivity([], 1, [], 5), []);
});
