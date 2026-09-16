/**
 * NVIDIA-to-AMD gating parity for vLLM's CI.
 *
 * Every test job in `.buildkite/test_areas/*.yaml` on vllm-project/vllm is a
 * step with a `device`. NVIDIA steps may declare a `mirror.amd` block, which
 * the pipeline generator (vllm-project/ci-infra) turns into an `amd-<key>`
 * step on AMD hardware. This module reads those parsed YAML files and counts,
 * per test area and overall, how many NVIDIA jobs exist and how many of them
 * have an AMD mirror.
 *
 * A job "gates" a build when it is neither `optional` (only runs when someone
 * unblocks it or in a nightly) nor `soft_fail` (its failure does not fail the
 * build). The AMD mirror inherits both flags from its NVIDIA parent unless
 * the mirror block overrides them, matching `_get_amd_mirror_effective_step`
 * in the generator.
 */

export type DeviceVendor = "nvidia" | "amd" | "cpu" | "other" | "unknown";

// Mirrors DeviceType in ci-infra buildkite/pipeline_generator/constants.py.
const NVIDIA_DEVICES = new Set([
  "h100",
  "h200",
  "h200_18gb",
  "h200_35gb",
  "b200",
  "b200-k8s",
  "a100",
  "l4",
  "gh200",
  "dgx-spark",
]);
const CPU_DEVICES = new Set([
  "cpu",
  "cpu-small",
  "cpu-medium",
  "intel_cpu",
  "arm_cpu",
  "amd_cpu",
  "zen5",
]);
const OTHER_DEVICES = new Set(["intel_hpu", "intel_gpu", "ascend_npu"]);
const AMD_GPU_DEVICE = /^mi\d{3}_\d+$/;

export interface StepHardware {
  device?: string | null;
  label: string;
  /** Legacy `gpu:` key that predates `device:`; any value meant an NVIDIA queue. */
  gpu?: unknown;
  /** Legacy `no_gpu: true` put a device-less step on a CPU queue. */
  noGpu?: boolean;
}

/**
 * Vendor of the hardware a step runs on. `device` wins, then the label's
 * vendor shortcode. Older test_areas files (before mid-2026) named neither:
 * the generator sent those steps to its default GPU queue unless they were
 * `no_gpu`, a `:docker:` build, or the documentation build, so a step with no
 * device at all is NVIDIA. Only a device the generator does not know, with no
 * shortcode to fall back on, is "unknown".
 */
export function classifyDevice(
  device: string | null | undefined,
  label: string,
  legacy: Pick<StepHardware, "gpu" | "noGpu"> = {},
): DeviceVendor {
  const normalized = device?.trim().toLowerCase();
  if (normalized) {
    if (NVIDIA_DEVICES.has(normalized)) return "nvidia";
    if (CPU_DEVICES.has(normalized)) return "cpu";
    if (OTHER_DEVICES.has(normalized)) return "other";
    if (AMD_GPU_DEVICE.test(normalized)) return "amd";
  }
  // Labels carry a vendor shortcode by convention (":nvidia: (H100) ...").
  const trimmed = label.trimStart();
  if (trimmed.startsWith(":nvidia:")) return "nvidia";
  if (trimmed.startsWith(":amd:")) return "amd";
  if (trimmed.startsWith(":computer:") || trimmed.startsWith(":cpu:")) {
    return "cpu";
  }
  if (typeof legacy.gpu === "string" && legacy.gpu.trim()) return "nvidia";
  if (
    legacy.noGpu === true ||
    trimmed.startsWith(":docker:") ||
    trimmed === "Documentation Build"
  ) {
    return "cpu";
  }
  return normalized ? "unknown" : "nvidia";
}

export function classifyStep(step: Record<string, unknown>): DeviceVendor {
  return classifyDevice(
    typeof step.device === "string" ? step.device : null,
    String(step.label ?? ""),
    { gpu: step.gpu, noGpu: step.no_gpu === true },
  );
}

export interface TestAreaFile {
  /** Repository path, e.g. ".buildkite/test_areas/kernels.yaml". */
  path: string;
  group: string;
  steps: Record<string, unknown>[];
}

export function parseTestAreaFile(
  path: string,
  document: unknown,
): TestAreaFile | null {
  if (!document || typeof document !== "object") return null;
  const candidate = document as { group?: unknown; steps?: unknown };
  if (typeof candidate.group !== "string" || !candidate.group.trim()) {
    return null;
  }
  if (!Array.isArray(candidate.steps)) return null;
  const steps = candidate.steps.filter(
    (step): step is Record<string, unknown> =>
      !!step &&
      typeof step === "object" &&
      typeof (step as { label?: unknown }).label === "string",
  );
  return { path, group: candidate.group.trim(), steps };
}

export interface ParityMirror {
  label: string;
  device: string | null;
  optional: boolean;
  softFail: boolean;
  /** Mirror runs and blocks: neither optional nor soft-fail after inheritance. */
  gating: boolean;
}

export interface ParityJob {
  label: string;
  key: string | null;
  group: string;
  file: string;
  device: string | null;
  numDevices: number;
  parallelism: number;
  optional: boolean;
  softFail: boolean;
  /** Optional on pull requests but auto-runs on main (test-template-amd.j2). */
  autorunOnMain: boolean;
  gating: boolean;
  mirror: ParityMirror | null;
}

export interface ParityCounts {
  nvidiaJobs: number;
  mirroredJobs: number;
  /** mirroredJobs / nvidiaJobs, or null when there are no NVIDIA jobs. */
  coverage: number | null;
}

export interface ParityGroup {
  group: string;
  file: string;
  all: ParityCounts;
  gating: ParityCounts;
}

export interface ParitySnapshot {
  summary: {
    all: ParityCounts;
    gating: ParityCounts;
    /** NVIDIA jobs that are optional or soft-fail, i.e. never block a build. */
    nonGating: ParityCounts;
  };
  groups: ParityGroup[];
  jobs: ParityJob[];
  skipped: {
    cpuJobs: number;
    amdJobs: number;
    otherJobs: number;
    /** Steps whose device and label gave no vendor; surfaced so they are not silently dropped. */
    unknown: Array<{ label: string; device: string | null; file: string }>;
  };
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseMirror(
  step: Record<string, unknown>,
  parentOptional: boolean,
  parentSoftFail: boolean,
): ParityMirror | null {
  const mirror = step.mirror;
  if (!mirror || typeof mirror !== "object") return null;
  const amd = (mirror as { amd?: unknown }).amd;
  if (!amd || typeof amd !== "object") return null;
  const block = amd as Record<string, unknown>;
  const optional =
    typeof block.optional === "boolean" ? block.optional : parentOptional;
  const softFail =
    typeof block.soft_fail === "boolean" ? block.soft_fail : parentSoftFail;
  return {
    label:
      asNullableString(block.label) ?? `AMD: ${String(step.label).trim()}`,
    device: asNullableString(block.device),
    optional,
    softFail,
    gating: !optional && !softFail,
  };
}

export function parityJobFromStep(
  file: TestAreaFile,
  step: Record<string, unknown>,
): ParityJob {
  const optional = asBoolean(step.optional);
  const softFail = asBoolean(step.soft_fail);
  return {
    label: String(step.label).trim(),
    key: asNullableString(step.key),
    group: file.group,
    file: file.path,
    device: asNullableString(step.device),
    numDevices: asPositiveInteger(
      step.num_devices ?? step.num_gpus,
      1,
    ),
    parallelism: asPositiveInteger(step.parallelism, 1),
    optional,
    softFail,
    autorunOnMain: asBoolean(step.autorun_on_main),
    gating: !optional && !softFail,
    mirror: parseMirror(step, optional, softFail),
  };
}

export function countParity(jobs: readonly ParityJob[]): ParityCounts {
  const nvidiaJobs = jobs.length;
  const mirroredJobs = jobs.filter((job) => job.mirror !== null).length;
  return {
    nvidiaJobs,
    mirroredJobs,
    coverage: nvidiaJobs > 0 ? mirroredJobs / nvidiaJobs : null,
  };
}

export function computeParity(files: readonly TestAreaFile[]): ParitySnapshot {
  const jobs: ParityJob[] = [];
  const skipped: ParitySnapshot["skipped"] = {
    cpuJobs: 0,
    amdJobs: 0,
    otherJobs: 0,
    unknown: [],
  };
  const groupFiles = new Map<string, string>();

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const step of file.steps) {
      const label = String(step.label);
      const device = asNullableString(step.device);
      switch (classifyStep(step)) {
        case "nvidia":
          jobs.push(parityJobFromStep(file, step));
          if (!groupFiles.has(file.group)) groupFiles.set(file.group, file.path);
          break;
        case "cpu":
          skipped.cpuJobs += 1;
          break;
        case "amd":
          skipped.amdJobs += 1;
          break;
        case "other":
          skipped.otherJobs += 1;
          break;
        default:
          skipped.unknown.push({ label: label.trim(), device, file: file.path });
      }
    }
  }

  const groups: ParityGroup[] = [...groupFiles.entries()]
    .map(([group, file]) => {
      const groupJobs = jobs.filter((job) => job.group === group);
      return {
        group,
        file,
        all: countParity(groupJobs),
        gating: countParity(groupJobs.filter((job) => job.gating)),
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group));

  return {
    summary: {
      all: countParity(jobs),
      gating: countParity(jobs.filter((job) => job.gating)),
      nonGating: countParity(jobs.filter((job) => !job.gating)),
    },
    groups,
    jobs,
    skipped,
  };
}

export interface ParityHistorySample {
  /** ISO date (UTC midnight) the sample stands for. */
  date: string;
  commit: string;
  commitDate: string;
  all: ParityCounts;
  gating: ParityCounts;
}

export function summarizeForHistory(
  snapshot: ParitySnapshot,
): Pick<ParityHistorySample, "all" | "gating"> {
  return { all: snapshot.summary.all, gating: snapshot.summary.gating };
}
