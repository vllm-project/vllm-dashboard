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

export function getDb() {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set");
    }
    sql = postgres(webDatabaseUrl(url), {
      ssl: "require",
      // Supabase shared-pooler URLs use transaction mode in the web app. Named
      // prepared statements are connection-local and can disappear when the
      // pooler hands a later request to a different backend connection.
      prepare: false,
      // Serverless instances should fail quickly and keep a deliberately small
      // pool. The dashboard only fans out three PostgreSQL queries at once;
      // larger per-instance pools amplify connection pressure during bursts.
      max: 3,
      connect_timeout: 10,
      idle_timeout: 20,
      max_lifetime: 10 * 60,
    });
  }
  return sql;
}
