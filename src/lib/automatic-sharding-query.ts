import { queryDatabricks } from "@/lib/databricks";
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
  const rows = await queryDatabricks<Record<string, string | null>>(`
    WITH runs AS (
      SELECT
        j.build_id,
        b.created_at,
        regexp_replace(j.name, '${SHARD_SUFFIX_SQL}', '') AS step,
        j.name RLIKE '${SHARD_SUFFIX_SQL}' AS sharded,
        CAST(NULLIF(regexp_extract(j.name, '${SHARD_TOTAL_SQL}', 1), '') AS INT) AS shard_total,
        TIMESTAMPDIFF(SECOND, j.started_at, j.finished_at) AS secs
      FROM vllm_data_warehouse.buildkite.build_job AS j
      INNER JOIN vllm_data_warehouse.buildkite.build AS b ON j.build_id = b.id
      INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
      WHERE p.name = 'CI'
        AND b.branch = 'main'
        AND b.created_at >= DATE_SUB(CURRENT_DATE(), ${Math.trunc(days)})
        AND b._fivetran_deleted = false
        AND j._fivetran_deleted = false
        AND j.type = 'script'
        AND j.name IS NOT NULL
        AND j.started_at IS NOT NULL
    ),
    per_build AS (
      SELECT
        step,
        build_id,
        MAX(created_at) AS created_at,
        BOOL_OR(sharded) AS sharded,
        MAX(shard_total) AS shards,
        MAX(secs) AS wall_secs
      FROM runs
      GROUP BY step, build_id
    )
    SELECT
      step,
      SUM(CASE WHEN sharded THEN 1 ELSE 0 END) AS sharded_builds,
      SUM(CASE WHEN sharded THEN 0 ELSE 1 END) AS unsharded_builds,
      MAX_BY(shards, created_at) AS latest_shards,
      MAX(shards) AS max_shards,
      MAX(created_at) AS last_seen,
      PERCENTILE_APPROX(wall_secs, 0.5) AS p50_wall_secs
    FROM per_build
    GROUP BY step
  `);
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
