// Keys include request parameters, so an unbounded map would let anyone
// grow server memory with distinct URLs. Least recently used goes first.
const MAX_ENTRIES = 500;
const store = new Map<string, { data: unknown; expiry: number }>();
const inFlight = new Map<string, Promise<unknown>>();

/** Share a cache fill across concurrent callers in this server instance. */
export async function getOrLoadCached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<{ data: T; status: "HIT" | "MISS" | "COALESCED" }> {
  const cached = getCached<T>(key);
  if (cached !== undefined) return { data: cached, status: "HIT" };
  const pending = inFlight.get(key);
  if (pending) return { data: await pending as T, status: "COALESCED" };

  const promise = Promise.resolve().then(load);
  inFlight.set(key, promise);
  try {
    const data = await promise;
    setCache(key, data, ttlMs);
    return { data, status: "MISS" };
  } finally {
    // Failed loads must be retryable; never retain a rejected promise.
    inFlight.delete(key);
  }
}

export function getCached<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  store.delete(key);
  if (Date.now() >= entry.expiry) return undefined;
  store.set(key, entry); // most recently used
  return entry.data as T;
}

export function setCache(key: string, data: unknown, ttlMs: number): void {
  store.delete(key);
  store.set(key, { data, expiry: Date.now() + ttlMs });
  while (store.size > MAX_ENTRIES) {
    store.delete(store.keys().next().value as string);
  }
}

/** Entries currently cached (for tests). */
export function cacheSize(): number {
  return store.size;
}
