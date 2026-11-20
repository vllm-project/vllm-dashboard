/** Compact age like "3h", "2d", "5w" between an ISO time and now. */
export function formatAge(isoTime: string, now: number = Date.now()): string {
  const then = Date.parse(isoTime);
  if (!Number.isFinite(then)) return "—";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

export function percent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

export async function sendJson<T>(url: string, method: "POST", body: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed with ${response.status}`);
  return payload;
}

export async function triageFetcher<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed with ${response.status}`);
  return payload;
}

const REASON_LABELS: { test: RegExp; label: (m: RegExpMatchArray) => string }[] = [
  { test: /^authored #(\d+)$/, label: (m) => `wrote #${m[1]}, which this item names` },
  { test: /^commented$/, label: () => "already commented on this item" },
  { test: /^assigned on GitHub$/, label: () => "assigned to them on GitHub" },
  // Followed its issue / fix PR group (triage/groups.py).
  { test: /^fixes #(\d+)$/, label: (m) => `fixes #${m[1]}, which they own` },
  { test: /^fixed by #(\d+)$/, label: (m) => `fixed by #${m[1]}, which they own` },
  { test: /^relevance:(high|medium)/, label: (m) => `judged ${m[1]} from their recent work` },
  { test: /^(area|hardware|model|path|keyword):(.+)$/, label: (m) => `their rule: ${m[1]} ${m[2]}` },
];

/** One router `matched` token ("relevance:high", "area:moe", …) in plain words. */
export function describeReason(raw: string): string {
  for (const { test, label } of REASON_LABELS) {
    const match = raw.match(test);
    if (match) return label(match);
  }
  return raw;
}

/**
 * The item to open from `?item=`. Links must URL-encode the key
 * (`vllm-project%2Fvllm%2348071`); an unencoded `?item=vllm-project/vllm#48071`
 * arrives as `item=vllm-project/vllm` plus the `#48071` fragment, so the two
 * are put back together.
 */
export function itemFromLocation(param: string | null, hash: string): string | null {
  if (param && !param.includes("#") && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(param) && /^#\d+$/.test(hash)) {
    return `${param}${hash}`;
  }
  return param;
}
