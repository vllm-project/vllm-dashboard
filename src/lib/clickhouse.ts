/**
 * ClickHouse Cloud client for the dashboard's analytical reads.
 *
 * The `buildkite` database holds the same Fivetran Buildkite tables the
 * dashboard used to read from Databricks. Fivetran writes them as
 * ReplacingMergeTree tables, so reads must use `FINAL` (or an equivalent
 * dedupe) and filter `_fivetran_deleted`.
 *
 * Rows come back in the shape the Databricks client returned, so callers can
 * keep their parsing: every non-null scalar is a string, booleans are
 * "true"/"false", and timestamps are millisecond ISO-8601 strings ending in
 * "Z". Arrays, maps and tuples come back in ClickHouse's text syntax, not JSON;
 * wrap them in toJSONString() in SQL when the caller parses them.
 */

export type ClickHouseParam = string | number | boolean | readonly string[] | readonly number[];

export class ClickHouseQueryError extends Error {}

interface ClickHouseConfig {
  url: string;
  user: string;
  password: string;
}

function readConfig(): ClickHouseConfig {
  const url = process.env.CLICKHOUSE_URL;
  const user = process.env.CLICKHOUSE_READ_USER;
  const password = process.env.CLICKHOUSE_READ_PASSWORD;
  if (!url || !user || !password) {
    throw new Error(
      "Missing ClickHouse configuration. Set CLICKHOUSE_URL, CLICKHOUSE_READ_USER, and CLICKHOUSE_READ_PASSWORD.",
    );
  }
  return { url: url.replace(/\/+$/, ""), user, password };
}

export function writeConfig(): ClickHouseConfig | null {
  const url = process.env.CLICKHOUSE_URL;
  const user = process.env.CLICKHOUSE_WRITE_USER;
  const password = process.env.CLICKHOUSE_WRITE_PASSWORD;
  if (!url || !user || !password) return null;
  return { url: url.replace(/\/+$/, ""), user, password };
}

const NULL_MARKER = "ᴺᵁᴸᴸ";
const ISO_NANOS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/;

/** Normalize ClickHouse ISO timestamps (up to 9 fractional digits) to ms. */
export function normalizeValue(value: string): string | null {
  if (value === NULL_MARKER) return null;
  const match = ISO_NANOS.exec(value);
  if (match) {
    const millis = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
    return `${match[1]}.${millis}Z`;
  }
  return value;
}

function escapeArrayItem(item: string | number): string {
  if (typeof item === "number") return String(item);
  return `'${item.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Encode a value for the HTTP interface's `param_<name>` query parameters. */
export function encodeParam(value: ClickHouseParam): string {
  if (Array.isArray(value)) {
    return `[${(value as (string | number)[]).map(escapeArrayItem).join(",")}]`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function buildQueryUrl(
  baseUrl: string,
  params: Record<string, ClickHouseParam> | undefined,
  settings: Record<string, string>,
): string {
  const search = new URLSearchParams(settings);
  for (const [name, value] of Object.entries(params ?? {})) {
    search.set(`param_${name}`, encodeParam(value));
  }
  return `${baseUrl}/?${search.toString()}`;
}

const READ_SETTINGS: Record<string, string> = {
  date_time_output_format: "iso",
  max_execution_time: "50",
  enable_http_compression: "1",
  // FINAL on the Fivetran tables is the dominant cost; let it use every core.
  do_not_merge_across_partitions_select_final: "1",
};

/**
 * Run a read query. Use ClickHouse's typed placeholders in `sql`
 * (`{name:String}`, `{ids:Array(String)}`) and pass values in `params`.
 * Do not add a FORMAT clause; the client picks the output format.
 */
export async function queryClickHouse<T = Record<string, unknown>>(
  sql: string,
  params?: Record<string, ClickHouseParam>,
  settings?: Record<string, string>,
): Promise<T[]> {
  const config = readConfig();
  const response = await fetch(buildQueryUrl(config.url, params, { ...READ_SETTINGS, ...settings }), {
    method: "POST",
    headers: {
      "X-ClickHouse-User": config.user,
      "X-ClickHouse-Key": config.password,
      "X-ClickHouse-Format": "JSONStringsEachRow",
      "Accept-Encoding": "gzip",
    },
    body: sql,
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ClickHouseQueryError(`ClickHouse query failed (${response.status}): ${text.slice(0, 2000)}`);
  }
  const rows: T[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    // ClickHouse can fail after streaming started; it then appends an
    // exception line to an otherwise 200 response. Never return a partial set.
    if (!line.startsWith("{")) {
      throw new ClickHouseQueryError(`ClickHouse query failed mid-stream: ${line.slice(0, 2000)}`);
    }
    const raw = JSON.parse(line) as Record<string, string>;
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      row[key] = typeof value === "string" ? normalizeValue(value) : value;
    }
    rows.push(row as T);
  }
  return rows;
}

/** Insert rows as JSONEachRow with the write user. */
export async function insertClickHouse(
  table: string,
  rows: readonly Record<string, unknown>[],
  options: { asyncInsert?: boolean } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const config = writeConfig();
  if (!config) throw new Error("Missing ClickHouse write configuration.");
  const settings: Record<string, string> = {
    query: `INSERT INTO ${table} FORMAT JSONEachRow`,
    date_time_input_format: "best_effort",
    input_format_skip_unknown_fields: "1",
  };
  if (options.asyncInsert) {
    settings.async_insert = "1";
    settings.wait_for_async_insert = "1";
  }
  const response = await fetch(buildQueryUrl(config.url, undefined, settings), {
    method: "POST",
    headers: {
      "X-ClickHouse-User": config.user,
      "X-ClickHouse-Key": config.password,
      "Content-Type": "application/x-ndjson",
    },
    body: rows.map((row) => JSON.stringify(row)).join("\n"),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new ClickHouseQueryError(
      `ClickHouse insert into ${table} failed (${response.status}): ${(await response.text()).slice(0, 2000)}`,
    );
  }
}
