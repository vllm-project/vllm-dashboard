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
}
