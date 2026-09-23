export interface DatabricksConfig {
  host: string;
  token: string;
  warehouseId: string;
}

export class DatabricksIncompleteResultError extends Error {}

function getConfig(): DatabricksConfig {
  const host = process.env.DATABRICKS_HOST;
  const token = process.env.DATABRICKS_TOKEN;
  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;

  if (!host || !token || !warehouseId) {
    throw new Error(
      "Missing Databricks configuration. Set DATABRICKS_HOST, DATABRICKS_TOKEN, and DATABRICKS_WAREHOUSE_ID."
    );
  }

  return { host, token, warehouseId };
}

export async function queryDatabricks<T = Record<string, unknown>>(
  sql: string,
  params?: { name: string; value: string; type?: string }[]
): Promise<T[]> {
  const config = getConfig();

  const response = await fetch(
    `${config.host}/api/2.0/sql/statements`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        warehouse_id: config.warehouseId,
        statement: sql,
        parameters: params,
        wait_timeout: "50s",
        disposition: "INLINE",
        format: "JSON_ARRAY",
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Databricks query failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  if (data.status?.state === "FAILED") {
    throw new Error(
      `Query failed: ${data.status.error?.message ?? "unknown error"}`
    );
  }
  if (data.status?.state !== "SUCCEEDED") {
    throw new Error(
      `Databricks query did not complete (state: ${data.status?.state ?? "unknown"})`
    );
  }

  // Map column names to row values
  const columns: { name: string }[] = data.manifest?.schema?.columns ?? [];
  const rows: unknown[][] = data.result?.data_array ?? [];

  // This helper consumes only the inline first chunk. Never let callers cache
  // that chunk as a complete history when the warehouse has more rows.
  if (data.manifest?.truncated === true || data.manifest?.total_chunk_count > 1 ||
      data.manifest?.chunks?.length > 1 || data.result?.next_chunk_index != null ||
      data.result?.next_chunk_internal_link || data.manifest?.total_row_count > rows.length) {
    throw new DatabricksIncompleteResultError(
      "Databricks returned an incomplete result. Choose a narrower time range and try again."
    );
  }

  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col.name] = row[i];
    });
    return obj as T;
  });
}
