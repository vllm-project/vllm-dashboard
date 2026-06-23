import postgres from "postgres";

let sql: postgres.Sql;

export function getDb() {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set");
    }
    sql = postgres(url, { ssl: "require" });
  }
  return sql;
}

export async function initSchema() {
  const db = getDb();
  await db`
    CREATE TABLE IF NOT EXISTS queue_snapshots (
      id             SERIAL PRIMARY KEY,
      polled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      queue          TEXT NOT NULL,
      agents_idle    INT NOT NULL DEFAULT 0,
      agents_busy    INT NOT NULL DEFAULT 0,
      agents_total   INT NOT NULL DEFAULT 0,
      jobs_scheduled INT NOT NULL DEFAULT 0,
      jobs_running   INT NOT NULL DEFAULT 0,
      jobs_waiting   INT NOT NULL DEFAULT 0,
      jobs_total     INT NOT NULL DEFAULT 0,
      p50_wait_secs  REAL,
      p90_wait_secs  REAL,
      p95_wait_secs  REAL
    )
  `;
  await db`
    CREATE INDEX IF NOT EXISTS idx_snapshots_polled_queue
    ON queue_snapshots (polled_at DESC, queue)
  `;
  await db`
    CREATE INDEX IF NOT EXISTS idx_snapshots_queue_polled
    ON queue_snapshots (queue, polled_at DESC)
  `;
  // Add wait time columns if table already exists without them
  for (const col of ["p50_wait_secs", "p90_wait_secs", "p95_wait_secs"]) {
    await db.unsafe(`
      ALTER TABLE queue_snapshots ADD COLUMN IF NOT EXISTS ${col} REAL
    `);
  }

  await db`
    CREATE TABLE IF NOT EXISTS alert_threads (
      queue        TEXT PRIMARY KEY,
      thread_ts    TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active',
      history      TEXT[] NOT NULL DEFAULT '{}',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await db.unsafe(`
    ALTER TABLE alert_threads ADD COLUMN IF NOT EXISTS history TEXT[] DEFAULT '{}'
  `);

  await db`
    CREATE TABLE IF NOT EXISTS alert_summary (
      id           TEXT PRIMARY KEY,
      message_ts   TEXT NOT NULL,
      queues       JSONB NOT NULL DEFAULT '{}',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await db`
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
  await db`
    CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_reported
    ON gpu_snapshots (reported_at DESC, hostname)
  `;
  await db`
    CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_host
    ON gpu_snapshots (hostname, reported_at DESC)
  `;
  // Supports the "latest snapshot per (hostname, gpu_index)" roster query in
  // /api/gpu over a 30-day lookback: an index-only scan to enumerate distinct
  // GPU keys, plus a per-key newest-row lookup. Without gpu_index in the index,
  // that query degrades to a full scan + sort over millions of rows and times
  // out (the cause of the /gpu page hanging).
  await db`
    CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_host_gpu_reported
    ON gpu_snapshots (hostname, gpu_index, reported_at DESC)
  `;
}
