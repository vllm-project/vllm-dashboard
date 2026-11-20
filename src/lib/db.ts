import postgres from "postgres";

let sql: postgres.Sql;

export function webDatabaseUrl(url: string): string {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  if (
    parsed.hostname.endsWith(".pooler.supabase.com") &&
    (!parsed.port || parsed.port === "5432")
  ) {
    parsed.port = "6543";
    return parsed.toString();
  }
  return url;
}

type WebPostgresOptions = postgres.Options<Record<string, never>> & {
  // Supported at runtime by postgres.js (src/index.js) but omitted from its .d.ts.
  max_pipeline?: number;
};

export function getDb() {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set");
    }
    const options: WebPostgresOptions = {
      ssl: "require",
      // Supabase shared-pooler URLs use transaction mode in the web app. Named
      // prepared statements are connection-local and can disappear when the
      // pooler hands a later request to a different backend connection.
      prepare: false,
      // Disable postgres.js query pipelining (default 100): Supavisor
      // transaction mode (:6543) can desync on pipelined unnamed-prepared
      // queries, leaving the backend wedged in active/ClientRead forever.
      max_pipeline: 1,
      // Keep the per-instance pool small for serverless, while covering the
      // triage page's concurrent fan-out (/api/triage/stats + items +
      // maintainers) without queueing behind a single slow query.
      max: 6,
      connect_timeout: 10,
      idle_timeout: 20,
      max_lifetime: 10 * 60,
    };
    sql = postgres(webDatabaseUrl(url), options);
  }
  return sql;
}
