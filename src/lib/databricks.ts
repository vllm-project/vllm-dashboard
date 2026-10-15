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

type Disposition = "INLINE" | "EXTERNAL_LINKS";

// INLINE results are capped at 25 MiB; past that the statement fails with
// this message and must be rerun with EXTERNAL_LINKS.
const INLINE_LIMIT_ERROR = /Inline byte limit exceeded/i;

async function submitStatement(
  config: DatabricksConfig,
  sql: string,
  params: { name: string; value: string; type?: string }[] | undefined,
  disposition: Disposition
) {
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
        disposition,
        format: "JSON_ARRAY",
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Databricks query failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function fetchChunk(config: DatabricksConfig, link: string) {
  const chunkResponse = await fetch(`${config.host}${link}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!chunkResponse.ok) {
    const text = await chunkResponse.text();
    throw new Error(`Databricks chunk fetch failed (${chunkResponse.status}): ${text}`);
  }
  return chunkResponse.json();
}

// EXTERNAL_LINKS chunks are presigned cloud-storage URLs. They must be fetched
// without the Databricks token, which the storage service would reject.
async function fetchExternalRows(links: { external_link: string }[]) {
  const rows: unknown[][] = [];
  for (const link of links) {
    const response = await fetch(link.external_link);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Databricks external chunk fetch failed (${response.status}): ${text}`);
    }
    rows.push(...((await response.json()) as unknown[][]));
  }
  return rows;
}

export async function queryDatabricks<T = Record<string, unknown>>(
  sql: string,
  params?: { name: string; value: string; type?: string }[]
): Promise<T[]> {
  const config = getConfig();

  let disposition: Disposition = "INLINE";
  let data = await submitStatement(config, sql, params, disposition);
  if (data.status?.state === "FAILED" &&
      INLINE_LIMIT_ERROR.test(data.status.error?.message ?? "")) {
    disposition = "EXTERNAL_LINKS";
    data = await submitStatement(config, sql, params, disposition);
  }

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
  const rows: unknown[][] = [];

  // Results larger than one chunk arrive as a linked list of chunks.
  // Follow it so callers get every row, e.g. the job roster for 50 builds.
  if (disposition === "INLINE") {
    rows.push(...(data.result?.data_array ?? []));
    let nextLink: string | undefined = data.result?.next_chunk_internal_link;
    while (nextLink) {
      const chunk = await fetchChunk(config, nextLink);
      rows.push(...(chunk.data_array ?? []));
      nextLink = chunk.next_chunk_internal_link;
    }
  } else {
    let links: { external_link: string; next_chunk_internal_link?: string }[] =
      data.result?.external_links ?? [];
    while (links.length > 0) {
      rows.push(...(await fetchExternalRows(links)));
      const nextLink = links[links.length - 1].next_chunk_internal_link;
      links = nextLink ? (await fetchChunk(config, nextLink)).external_links ?? [] : [];
    }
  }

  // Never let callers cache a partial result as a complete history. INLINE
  // disposition truncates past its byte limit, and a chunk list without links
  // would silently drop rows.
  if (data.manifest?.truncated === true ||
      (typeof data.manifest?.total_row_count === "number" &&
        data.manifest.total_row_count > rows.length)) {
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
