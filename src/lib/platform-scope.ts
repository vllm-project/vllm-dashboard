/**
 * Platform scope of vLLM's CI jobs: which jobs are on the common path that
 * both NVIDIA and AMD run, and which are NVIDIA-only or ROCm-only.
 *
 * Reads the same parsed `.buildkite/test_areas` files as the old parity view.
 * Every NVIDIA or AMD GPU step becomes one job. An NVIDIA step with a
 * `mirror.amd` block runs on both platforms and is common. Every other step
 * takes its scope from `platform-scope-rules.ts`: a rule for its key, then a
 * rule for its file, then a label pattern. A step none of them cover is
 * "unclassified". CPU and other-hardware steps are left out.
 *
 * A common job without a mirror is complete when its rule names a
 * counterpart step on the other platform; otherwise it is missing there.
 * That gap list, not a percentage of NVIDIA jobs, is what this view tracks.
 */

import {
  classifyStep,
  parityJobFromStep,
  type TestAreaFile,
} from "./gpu-parity";
import {
  FILE_RULES,
  LABEL_RULES,
  STEP_RULES,
  type PlatformScope,
  type PlatformScopeRule,
} from "./platform-scope-rules";

export type { PlatformScope } from "./platform-scope-rules";

export type Platform = "nvidia" | "amd";
export type JobScope = PlatformScope | "unclassified";
/** What decided a job's scope. */
export type ScopeSource = "mirror" | "step-rule" | "file-rule" | "label-rule" | "none";

export interface PlatformSide {
  label: string;
  key: string | null;
  device: string | null;
  optional: boolean;
  softFail: boolean;
  /** `mirror` when this side is the generator's `amd-<key>` copy of an NVIDIA step. */
  via: "step" | "mirror" | "counterpart";
}

export interface ScopedJob {
  /** The step's `key`, or its label when it has none. Rules use the same id. */
  id: string;
  label: string;
  key: string | null;
  group: string;
  file: string;
  /** Hardware vendor of the YAML step itself. */
  vendor: Platform;
  device: string | null;
  numDevices: number;
  numNodes: number;
  parallelism: number;
  /** The step itself is `optional: true` (nightly or manually unblocked). */
  optional: boolean;
  softFail: boolean;
  scope: JobScope;
  source: ScopeSource;
  reason: string;
  nvidia: PlatformSide | null;
  amd: PlatformSide | null;
  /** Common jobs only: the platform it does not run on yet. */
  missingOn: Platform | null;
}

export interface ScopeCounts {
  jobs: number;
  common: number;
  /** Common jobs running on both platforms (mirror or named counterpart). */
  commonOnBoth: number;
  /** Common jobs with no AMD step. */
  missingOnAmd: number;
  /** Common jobs with no NVIDIA step. */
  missingOnNvidia: number;
  nvidiaOnly: number;
  rocmOnly: number;
  unclassified: number;
}

export interface ScopeGroup {
  group: string;
  file: string;
  all: ScopeCounts;
  /** Jobs whose own step is not optional. */
  gating: ScopeCounts;
}

export interface PlatformScopeSnapshot {
  summary: { all: ScopeCounts; gating: ScopeCounts };
  groups: ScopeGroup[];
  jobs: ScopedJob[];
  /**
   * Rules that no longer describe the YAML: a key no step has, a rule on a
   * step that now declares a mirror, or a counterpart that does not exist.
   */
  staleRules: Array<{ id: string; problem: string }>;
  skipped: {
    cpuJobs: number;
    otherJobs: number;
    unknown: Array<{ label: string; device: string | null; file: string }>;
  };
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function stepId(step: Record<string, unknown>): string {
  return asNullableString(step.key) ?? String(step.label).trim();
}

function ruleFor(
  id: string,
  file: string,
  label: string,
  vendor: Platform,
): { rule: PlatformScopeRule; source: ScopeSource } | null {
  const stepRule = STEP_RULES[id];
  if (stepRule) return { rule: stepRule, source: "step-rule" };
  const fileRule = FILE_RULES[file];
  if (fileRule) return { rule: fileRule, source: "file-rule" };
  const labelRule = LABEL_RULES.find(
    (candidate) => candidate.vendor === vendor && candidate.pattern.test(label),
  );
  if (labelRule) return { rule: labelRule, source: "label-rule" };
  return null;
}

interface Candidate {
  file: TestAreaFile;
  step: Record<string, unknown>;
  vendor: Platform;
}

function ownSide(job: ReturnType<typeof parityJobFromStep>): PlatformSide {
  return {
    label: job.label,
    key: job.key,
    device: job.device,
    optional: job.optional,
    softFail: job.softFail,
    via: "step",
  };
}

export function emptyCounts(): ScopeCounts {
  return {
    jobs: 0,
    common: 0,
    commonOnBoth: 0,
    missingOnAmd: 0,
    missingOnNvidia: 0,
    nvidiaOnly: 0,
    rocmOnly: 0,
    unclassified: 0,
  };
}

export function countScopes(jobs: readonly ScopedJob[]): ScopeCounts {
  const counts = emptyCounts();
  for (const job of jobs) {
    counts.jobs += 1;
    switch (job.scope) {
      case "common":
        counts.common += 1;
        if (job.missingOn === "amd") counts.missingOnAmd += 1;
        else if (job.missingOn === "nvidia") counts.missingOnNvidia += 1;
        else counts.commonOnBoth += 1;
        break;
      case "nvidia-only":
        counts.nvidiaOnly += 1;
        break;
      case "rocm-only":
        counts.rocmOnly += 1;
        break;
      default:
        counts.unclassified += 1;
    }
  }
  return counts;
}

export function computePlatformScope(
  files: readonly TestAreaFile[],
): PlatformScopeSnapshot {
  const candidates: Candidate[] = [];
  const skipped: PlatformScopeSnapshot["skipped"] = {
    cpuJobs: 0,
    otherJobs: 0,
    unknown: [],
  };

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const step of file.steps) {
      const vendor = classifyStep(step);
      if (vendor === "nvidia" || vendor === "amd") {
        candidates.push({ file, step, vendor });
      } else if (vendor === "cpu") {
        skipped.cpuJobs += 1;
      } else if (vendor === "other") {
        skipped.otherJobs += 1;
      } else {
        skipped.unknown.push({
          label: String(step.label).trim(),
          device: asNullableString(step.device),
          file: file.path,
        });
      }
    }
  }

  const byId = new Map<string, Candidate>();
  for (const candidate of candidates) {
    byId.set(stepId(candidate.step), candidate);
  }

  const staleRules: PlatformScopeSnapshot["staleRules"] = [];
  const jobs: ScopedJob[] = [];

  for (const { file, step, vendor } of candidates) {
    const id = stepId(step);
    const parsed = parityJobFromStep(file, step);
    const own = ownSide(parsed);

    const base = {
      id,
      label: parsed.label,
      key: parsed.key,
      group: parsed.group,
      file: parsed.file,
      vendor,
      device: parsed.device,
      numDevices: parsed.numDevices,
      numNodes: parsed.numNodes,
      parallelism: parsed.parallelism,
      optional: parsed.optional,
      softFail: parsed.softFail,
    };

    // A declared mirror runs the job on both platforms; nothing overrides it.
    if (vendor === "nvidia" && parsed.mirror) {
      if (STEP_RULES[id]) {
        staleRules.push({
          id,
          problem: "Step now declares a mirror.amd block; its rule is unused.",
        });
      }
      jobs.push({
        ...base,
        scope: "common",
        source: "mirror",
        reason: "Declares a mirror.amd block.",
        nvidia: own,
        amd: {
          label: parsed.mirror.label,
          key: parsed.key ? `amd-${parsed.key}` : null,
          device: parsed.mirror.device,
          optional: parsed.mirror.optional,
          softFail: parsed.mirror.softFail,
          via: "mirror",
        },
        missingOn: null,
      });
      continue;
    }

    const match = ruleFor(id, file.path, parsed.label, vendor);
    if (!match) {
      jobs.push({
        ...base,
        scope: "unclassified",
        source: "none",
        reason:
          vendor === "nvidia"
            ? "No mirror.amd block and no platform rule."
            : "AMD-only step with no platform rule.",
        nvidia: vendor === "nvidia" ? own : null,
        amd: vendor === "amd" ? own : null,
        missingOn: null,
      });
      continue;
    }

    const { rule, source } = match;
    let nvidia = vendor === "nvidia" ? own : null;
    let amd = vendor === "amd" ? own : null;
    let missingOn: Platform | null = null;

    if (rule.scope === "common") {
      const other = rule.counterpart ? byId.get(rule.counterpart) : undefined;
      if (rule.counterpart && !other) {
        staleRules.push({
          id,
          problem: `Counterpart ${rule.counterpart} is not a GPU step in test_areas.`,
        });
      }
      if (other) {
        const otherJob = parityJobFromStep(other.file, other.step);
        const side: PlatformSide = { ...ownSide(otherJob), via: "counterpart" };
        if (other.vendor === "nvidia") nvidia = side;
        else amd = side;
      }
      if (!nvidia) missingOn = "nvidia";
      else if (!amd) missingOn = "amd";
    }

    jobs.push({
      ...base,
      scope: rule.scope,
      source,
      reason: rule.reason,
      nvidia,
      amd,
      missingOn,
    });
  }

  for (const id of Object.keys(STEP_RULES)) {
    if (!byId.has(id)) {
      staleRules.push({ id, problem: "No GPU step in test_areas has this key." });
    }
  }

  const groupFiles = new Map<string, string>();
  for (const job of jobs) {
    if (!groupFiles.has(job.group)) groupFiles.set(job.group, job.file);
  }
  const groups: ScopeGroup[] = [...groupFiles.entries()]
    .map(([group, file]) => {
      const groupJobs = jobs.filter((job) => job.group === group);
      return {
        group,
        file,
        all: countScopes(groupJobs),
        gating: countScopes(groupJobs.filter((job) => !job.optional)),
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group));

  return {
    summary: {
      all: countScopes(jobs),
      gating: countScopes(jobs.filter((job) => !job.optional)),
    },
    groups,
    jobs,
    staleRules,
    skipped,
  };
}
