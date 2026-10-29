import type { ObservedStep } from "@/lib/automatic-sharding-query";
import type { TestArea } from "@/lib/test-areas";

// How far vLLM CI has moved onto runtime sharding (`automatic_shard: true`,
// see job-shards.ts). A CI job here is one step of the test-area YAML on main,
// or that step's AMD mirror: each runs as its own Buildkite job (or shards).

/** The windows, in days, the report can look back over. */
export const SHARDING_WINDOWS = [7, 14, 30] as const;

export type ShardingStatus =
  /** Flagged, and ran as runtime shards in the window. */
  | "sharding"
  /** Flagged, but every run in the window was one job: the generator declined
   * it (multi-node, dind, non-pytest commands) or planned a single shard. */
  | "flagged-one-job"
  /** Flagged, and did not run on main in the window. */
  | "flagged-not-run"
  /** Not flagged, with a fixed `%N` / `parallelism` split. */
  | "fixed-split"
  /** Not flagged. */
  | "not-flagged";

export type Platform = "nvidia" | "amd" | "other";

export interface ShardingJob {
  label: string;
  group: string;
  platform: Platform;
  /** The AMD mirror of a step rather than the step itself. */
  mirror: boolean;
  status: ShardingStatus;
  /** `num_nodes >= 2`: the generator never shards it. */
  multiNode: boolean;
  observed: ObservedStep | null;
}

export interface ShardingSummary {
  jobs: number;
  flagged: number;
  sharding: number;
  byPlatform: Record<Platform, { jobs: number; flagged: number; sharding: number }>;
}

function platformOf(label: string, mirror: boolean): Platform {
  if (mirror || label.startsWith(":amd:")) return "amd";
  if (label.startsWith(":nvidia:")) return "nvidia";
  return "other";
}

function statusOf(
  flagged: boolean,
  fixedSplit: boolean,
  observed: ObservedStep | null,
): ShardingStatus {
  if (flagged) {
    if (observed && observed.shardedBuilds > 0) return "sharding";
    if (observed && observed.unshardedBuilds > 0) return "flagged-one-job";
    return "flagged-not-run";
  }
  return fixedSplit ? "fixed-split" : "not-flagged";
}

/** One row per CI job in the YAML, with how it ran in `observed`. */
export function classifyShardingJobs(
  areas: TestArea[],
  observed: ObservedStep[],
): ShardingJob[] {
  const observedByStep = new Map(observed.map((step) => [step.step, step]));
  const jobs: ShardingJob[] = [];
  const seen = new Set<string>();
  const add = (
    label: string,
    group: string,
    mirror: boolean,
    flagged: boolean,
    fixedSplit: boolean,
    multiNode: boolean,
  ) => {
    // The same label can sit in more than one YAML file (e.g. per-pipeline
    // copies); count the job once.
    if (seen.has(label)) return;
    seen.add(label);
    // A fixed split runs as "<label> 1", "<label> 2", …: no single step name.
    const stepObserved = label.includes("%N")
      ? null
      : (observedByStep.get(label) ?? null);
    jobs.push({
      label,
      group,
      platform: platformOf(label, mirror),
      mirror,
      status: statusOf(flagged, fixedSplit, stepObserved),
      multiNode,
      observed: stepObserved,
    });
  };
  for (const area of areas) {
    for (const step of area.steps) {
      const fixedSplit =
        step.label.includes("%N") || (step.parallelism ?? 1) > 1;
      const multiNode = (step.numNodes ?? 1) >= 2;
      add(
        step.label,
        area.group,
        false,
        step.automaticShard === true,
        fixedSplit,
        multiNode,
      );
      if (step.amdMirrorLabel) {
        add(
          step.amdMirrorLabel,
          area.group,
          true,
          step.automaticShard === true && step.amdMirrorAutomaticShard === true,
          step.amdMirrorLabel.includes("%N") || (step.parallelism ?? 1) > 1,
          multiNode,
        );
      }
    }
  }
  return jobs;
}

export function summarizeSharding(jobs: ShardingJob[]): ShardingSummary {
  const empty = () => ({ jobs: 0, flagged: 0, sharding: 0 });
  const summary: ShardingSummary = {
    ...empty(),
    byPlatform: { nvidia: empty(), amd: empty(), other: empty() },
  };
  for (const job of jobs) {
    const flagged = job.status.startsWith("flagged") || job.status === "sharding";
    for (const bucket of [summary, summary.byPlatform[job.platform]]) {
      bucket.jobs += 1;
      if (flagged) bucket.flagged += 1;
      if (job.status === "sharding") bucket.sharding += 1;
    }
  }
  return summary;
}
