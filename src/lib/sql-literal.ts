/**
 * Escape a value for a single-quoted Databricks (Spark) SQL string literal.
 *
 * Spark reads backslash escapes inside string literals, so doubling quotes
 * ('' → ') is not enough: `\'` would close the literal and let the rest of
 * the value run as SQL. Escape the backslash first, then the quote, so the
 * literal always holds exactly `value`. Prefer bound parameters
 * (`queryDatabricks(sql, params)`) for new queries.
 */
export function escapeSqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
