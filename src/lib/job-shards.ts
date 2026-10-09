// Runtime-sharded steps (`automatic_shard: true` in vLLM's test areas) run as
// Buildkite parallel jobs labelled "<step label> shard N/M". The pipeline
// generator re-plans the shards from recent timings on every build, so shard N
// runs different tests from build to build, and M can change too. A shard
// label is not a stable job: job history rolls the shards of one build back
// up into one run of the step.
//
// Legacy parallel steps ("Language Models Test 3", "... Shard 3") keep a fixed
// pytest shard per index and are left alone: only the "shard N/M" form the
// generator renders is folded.

/** The shard suffix, for SQL: POSIX and Java regex alike, no escapes. */
export const SHARD_SUFFIX_SQL = " shard [0-9]+/[0-9]+$";
/** Captures M, the build's shard count. */
export const SHARD_TOTAL_SQL = " shard [0-9]+/([0-9]+)$";

const SHARD_SUFFIX = / shard (\d+)\/(\d+)$/;

/** The step a job belongs to: its label without a runtime shard suffix. */
export function stepName(jobName: string): string {
  return jobName.replace(SHARD_SUFFIX, "");
}

/** The runtime shard of a job, or null for a job that is the whole step. */
export function runtimeShard(jobName: string): { index: number; total: number } | null {
  const match = jobName.match(SHARD_SUFFIX);
  return match ? { index: Number(match[1]), total: Number(match[2]) } : null;
}
