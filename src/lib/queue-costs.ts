// AWS on-demand pricing per hour (us-west-2) by queue name.
// Queues with confirmed instance types carry exact rates.
// Self-hosted / partner hardware (AMD, H200 slices, TPU, Intel, ...) has no
// AWS price; where a defensible market rate exists we add it with
// `estimated: true` and a source comment. Queues with neither stay unpriced
// and are surfaced by the "Unpriced Queues" card on the Cost page.

export interface QueuePricing {
  instanceType: string;
  costPerHour: number;
  /** True when the rate is an estimate rather than a confirmed instance price. */
  estimated?: boolean;
  /** Human-readable basis for an estimated rate (shown in the UI/docs). */
  source?: string;
}

export const QUEUE_COSTS: Record<string, QueuePricing> = {
  // GPU queues — g6 instances with NVIDIA L4
  gpu_1_queue: { instanceType: "g6.4xlarge", costPerHour: 1.3232 },
  gpu_4_queue: { instanceType: "g6.12xlarge", costPerHour: 4.602 },

  // CPU queues — r6in instances
  cpu_queue_premerge: { instanceType: "r6in.16xlarge", costPerHour: 5.579 },
  cpu_queue_premerge_us_east_1: { instanceType: "r6in.16xlarge", costPerHour: 5.579 },
  cpu_queue_postmerge: { instanceType: "r6in.16xlarge", costPerHour: 5.579 },
  cpu_queue_postmerge_us_east_1: { instanceType: "r6in.16xlarge", costPerHour: 5.579 },
  cpu_queue_release: { instanceType: "r6in.16xlarge", costPerHour: 5.579 },
  small_cpu_queue_premerge: { instanceType: "r6in.large", costPerHour: 0.1743 },
  small_cpu_queue_postmerge: { instanceType: "r6in.large", costPerHour: 0.1743 },
  small_cpu_queue_release: { instanceType: "r6in.large", costPerHour: 0.1743 },
  // Assumed midpoint between small_cpu (r6in.large) and cpu (r6in.16xlarge).
  medium_cpu_queue_premerge: {
    instanceType: "r6in.4xlarge",
    costPerHour: 1.3948,
    estimated: true,
    source: "AWS on-demand r6in.4xlarge, us-west-2 (assumed instance size)",
  },

  // H200 queues. h200_18gb is a known fractional-GPU slice at $0.30/hr.
  h200_18gb: { instanceType: "h200_18gb", costPerHour: 0.30 },
  // Scaled from the known h200_18gb slice price ($0.30/hr * 35/18 GB).
  h200_35gb: {
    instanceType: "h200_35gb",
    costPerHour: 0.5833,
    estimated: true,
    source: "Scaled from h200_18gb slice ($0.30/hr * 35/18)",
  },
  // Full H200 GPU: 8 x the $0.30/hr 18GB slice (141GB HBM3e / 18GB slice).
  H200: {
    instanceType: "H200 SXM",
    costPerHour: 2.4,
    estimated: true,
    source: "8x h200_18gb slice price ($0.30/hr)",
  },

  // ARM64 queues — r7g Graviton instances
  arm64_cpu_queue_postmerge: { instanceType: "r7g.16xlarge", costPerHour: 4.3546 },
  arm64_cpu_queue_release: { instanceType: "r7g.16xlarge", costPerHour: 4.3546 },
  // Same AWS ARM64 pool as the postmerge/release queues.
  arm64_cpu_queue_premerge: {
    instanceType: "r7g.16xlarge",
    costPerHour: 4.3546,
    estimated: true,
    source: "Assumed same instance as arm64_cpu_queue_postmerge",
  },

  // AMD queues — partner-hosted AMD GPUs. Queue suffix is GPUs per agent.
  // Market rental rates per GPU/hr (TensorWave / Lambda / RunPod list, 2026):
  // MI300X ~$2.50, MI355X ~$3.00, MI250 ~$1.80.
  amd_mi300_1: {
    instanceType: "MI300X x1",
    costPerHour: 2.5,
    estimated: true,
    source: "MI300X market rental ~$2.50/GPU/hr",
  },
  amd_mi300_2: {
    instanceType: "MI300X x2",
    costPerHour: 5.0,
    estimated: true,
    source: "MI300X market rental ~$2.50/GPU/hr",
  },
  amd_mi300_4: {
    instanceType: "MI300X x4",
    costPerHour: 10.0,
    estimated: true,
    source: "MI300X market rental ~$2.50/GPU/hr",
  },
  amd_mi300_8: {
    instanceType: "MI300X x8",
    costPerHour: 20.0,
    estimated: true,
    source: "MI300X market rental ~$2.50/GPU/hr",
  },
  amd_mi355_1: {
    instanceType: "MI355X x1",
    costPerHour: 3.0,
    estimated: true,
    source: "MI355X market rental ~$3.00/GPU/hr",
  },
  amd_mi355_2: {
    instanceType: "MI355X x2",
    costPerHour: 6.0,
    estimated: true,
    source: "MI355X market rental ~$3.00/GPU/hr",
  },
  amd_mi355_4: {
    instanceType: "MI355X x4",
    costPerHour: 12.0,
    estimated: true,
    source: "MI355X market rental ~$3.00/GPU/hr",
  },
  amd_mi250_1: {
    instanceType: "MI250 x1",
    costPerHour: 1.8,
    estimated: true,
    source: "MI250 market rental ~$1.80/GPU/hr",
  },
  amd_mi250_2: {
    instanceType: "MI250 x2",
    costPerHour: 3.6,
    estimated: true,
    source: "MI250 market rental ~$1.80/GPU/hr",
  },
  amd_mi250_4: {
    instanceType: "MI250 x4",
    costPerHour: 7.2,
    estimated: true,
    source: "MI250 market rental ~$1.80/GPU/hr",
  },

  // Other accelerator pools — per-GPU/hr market rental estimates (2026).
  "mithril-h100-pool": {
    instanceType: "H100",
    costPerHour: 2.5,
    estimated: true,
    source: "H100 market rental ~$2.50/GPU/hr (Mithril cloud)",
  },
  "b200-k8s": {
    instanceType: "B200",
    costPerHour: 5.0,
    estimated: true,
    source: "B200 market rental ~$5.00/GPU/hr",
  },
  "l4-k8s": {
    instanceType: "L4",
    costPerHour: 0.8,
    estimated: true,
    source: "L4 market rental ~$0.80/GPU/hr",
  },
  a100_queue: {
    instanceType: "A100 80GB",
    costPerHour: 2.25,
    estimated: true,
    source: "A100 80GB market rental ~$2.25/GPU/hr",
  },
  gh200_queue: {
    instanceType: "GH200",
    costPerHour: 3.75,
    estimated: true,
    source: "GH200 market rental ~$3.75/GPU/hr",
  },
};

export function getQueueCost(queue: string): QueuePricing | null {
  return QUEUE_COSTS[queue] ?? null;
}

export interface PricingCoverage {
  totalHours: number;
  /** Hours on queues with confirmed (non-estimated) rates. */
  pricedHours: number;
  /** Hours on queues with estimated rates. */
  estimatedHours: number;
  /** Hours on queues with no rate at all. */
  unpricedHours: number;
  /** pricedHours / totalHours, 0-1 (0 when there are no hours). */
  pricedHoursShare: number;
  /** estimatedHours / totalHours, 0-1 (0 when there are no hours). */
  estimatedHoursShare: number;
}

export function computePricingCoverage(
  rows: { queue: string; total_hours: number }[],
): PricingCoverage {
  let totalHours = 0;
  let pricedHours = 0;
  let estimatedHours = 0;
  for (const row of rows) {
    const pricing = getQueueCost(row.queue);
    totalHours += row.total_hours;
    if (!pricing) continue;
    if (pricing.estimated) estimatedHours += row.total_hours;
    else pricedHours += row.total_hours;
  }
  return {
    totalHours,
    pricedHours,
    estimatedHours,
    unpricedHours: totalHours - pricedHours - estimatedHours,
    pricedHoursShare: totalHours > 0 ? pricedHours / totalHours : 0,
    estimatedHoursShare: totalHours > 0 ? estimatedHours / totalHours : 0,
  };
}
