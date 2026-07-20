import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set");
}

const sql = postgres(url, { ssl: "require", max: 1 });
const startedAt = Date.now();

try {
  await sql`
    CREATE TABLE IF NOT EXISTS gpu_snapshots (
      id             SERIAL PRIMARY KEY,
      reported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      hostname       TEXT NOT NULL,
      gpu_index      INT NOT NULL,
      gpu_name       TEXT,
      gpu_util       REAL NOT NULL,
      mem_used_mb    REAL NOT NULL,
      mem_total_mb   REAL NOT NULL,
      temperature_c  REAL,
      power_draw_w   REAL,
      power_limit_w  REAL
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_reported
    ON gpu_snapshots (reported_at DESC, hostname)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_host
    ON gpu_snapshots (hostname, reported_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_host_gpu_reported
    ON gpu_snapshots (hostname, gpu_index, reported_at DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS gpu_history_5m (
      time_bucket   TIMESTAMPTZ NOT NULL,
      hostname      TEXT NOT NULL,
      gpu_name      TEXT NOT NULL,
      mem_pct_sum   DOUBLE PRECISION NOT NULL,
      sample_count  BIGINT NOT NULL,
      PRIMARY KEY (time_bucket, hostname, gpu_name)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_gpu_history_5m_time_host
    ON gpu_history_5m (time_bucket DESC, hostname)
  `;

  await sql.begin(async (tx) => {
    // Makes reruns safe while live reporters are incrementing the same buckets.
    await tx`LOCK TABLE gpu_history_5m IN ACCESS EXCLUSIVE MODE`;
    await tx`
      INSERT INTO gpu_history_5m (
        time_bucket, hostname, gpu_name, mem_pct_sum, sample_count
      )
      SELECT
        date_bin(INTERVAL '5 minutes', reported_at, TIMESTAMPTZ 'epoch'),
        hostname,
        COALESCE(gpu_name, 'Unknown'),
        SUM(CASE
          WHEN mem_total_mb > 0 THEN mem_used_mb / mem_total_mb * 100
          ELSE 0
        END)::double precision,
        COUNT(*)::bigint
      FROM gpu_snapshots
      GROUP BY 1, hostname, COALESCE(gpu_name, 'Unknown')
      ON CONFLICT (time_bucket, hostname, gpu_name) DO UPDATE SET
        mem_pct_sum = EXCLUDED.mem_pct_sum,
        sample_count = EXCLUDED.sample_count
    `;
  });

  const [stats] = await sql`
    SELECT COUNT(*)::bigint AS rows, MIN(time_bucket) AS oldest, MAX(time_bucket) AS newest
    FROM gpu_history_5m
  `;
  console.log(
    `GPU rollup migration complete: ${stats.rows} rows in ${Date.now() - startedAt}ms ` +
      `(${stats.oldest?.toISOString() ?? "empty"} to ${stats.newest?.toISOString() ?? "empty"})`,
  );
} finally {
  await sql.end();
}
