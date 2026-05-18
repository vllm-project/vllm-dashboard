const store = new Map<string, { data: unknown; expiry: number }>();

export function getCached<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data as T;
  return undefined;
}

export function setCache(key: string, data: unknown, ttlMs: number): void {
  store.set(key, { data, expiry: Date.now() + ttlMs });
}
