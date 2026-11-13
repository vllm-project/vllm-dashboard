import { queryClickHouse } from "@/lib/clickhouse";
import { SHARD_SUFFIX_SQL, SHARD_TOTAL_SQL } from "@/lib/job-shards";

/** How one CI step ran on main recently, rolled up per build. */
export interface ObservedStep {
  step: string;
  /** Builds where the step ran as runtime shards ("<step> Shard N/M"). */
  shardedBuilds: number;
  /** Builds where it ran as one job. */
  unshardedBuilds: number;
  /** M in its most recent build, or null when that run was not sharded. */
  latestShards: number | null;
  maxShards: number | null;
  lastSeen: string;
  /** Median over builds of its slowest job's run time (one shard, if sharded). */
  p50WallSecs: number | null;
}

/**
 * Every script step that ran on the main branch of the CI pipeline in the last
 * `days` days, with a step's runtime shards rolled into it (see job-shards.ts).
 */
export async function queryObservedSteps(days: number): Promise<ObservedStep[]> {
  // Builds are filtered first: build_job is sorted by build_id, so the IN
  // list prunes it before FINAL deduplicates the Fivetran versions. argMax
  // over a tuple keeps the latest build's NULL (unsharded) instead of skipping
  // to an older sharded build; quantileExactLow returns a value that occurred,
  // as Databricks' PERCENTILE_APPROX did.
  const rows = await queryClickHouse<Record<string, string | null>>(`
    WITH builds AS (
      SELECT id, created_at
      FROM buildkite.build FINAL
      WHERE NOT _fivetran_deleted
        AND pipeline_id IN (
          SELECT id FROM buildkite.pipeline FINAL WHERE NOT _fivetran_deleted AND name = 'CI')
        AND branch = 'main'
        AND created_at >= toStartOfDay(now('UTC')) - INTERVAL {days:UInt32} DAY
    ),
    runs AS (
      SELECT
        j.build_id AS build_id,
        b.created_at AS created_at,
        replaceRegexpOne(j.name, '${SHARD_SUFFIX_SQL}', '') AS step,
        match(j.name, '${SHARD_SUFFIX_SQL}') AS sharded,
        toInt32OrNull(extract(j.name, '${SHARD_TOTAL_SQL}')) AS shard_total,
        intDiv(toUnixTimestamp64Milli(j.finished_at) - toUnixTimestamp64Milli(j.started_at), 1000) AS secs
      FROM buildkite.build_job AS j FINAL
      INNER JOIN builds AS b ON j.build_id = b.id
      WHERE j.build_id IN (SELECT id FROM builds)
        AND NOT j._fivetran_deleted
        AND j.type = 'script'
        AND j.name IS NOT NULL
        AND j.started_at IS NOT NULL
    ),
    per_build AS (
      SELECT
        step,
        build_id,
        max(created_at) AS build_created_at,
        max(sharded) AS build_sharded,
        max(shard_total) AS shards,
        max(secs) AS wall_secs
      FROM runs
      GROUP BY step, build_id
    )
    SELECT
      step,
      countIf(build_sharded) AS sharded_builds,
      countIf(NOT build_sharded) AS unsharded_builds,
      argMax(tuple(shards), build_created_at).1 AS latest_shards,
      max(shards) AS max_shards,
      max(build_created_at) AS last_seen,
      quantileExactLow(0.5)(wall_secs) AS p50_wall_secs
    FROM per_build
    GROUP BY step
  `, { days: Math.trunc(days) });
  const num = (value: string | null) => (value == null ? null : Number(value));
  return rows.map((row) => ({
    step: row.step ?? "",
    shardedBuilds: num(row.sharded_builds) ?? 0,
    unshardedBuilds: num(row.unsharded_builds) ?? 0,
    latestShards: num(row.latest_shards),
    maxShards: num(row.max_shards),
    lastSeen: row.last_seen ?? "",
    p50WallSecs: num(row.p50_wall_secs),
  }));
}
