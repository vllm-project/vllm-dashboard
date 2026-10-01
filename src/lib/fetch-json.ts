export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok || body.error) {
    throw new Error(body.error ?? `Request failed with status ${response.status}`);
  }
  return body;
}
