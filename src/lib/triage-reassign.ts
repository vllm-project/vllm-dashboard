import type { TriageRelevance } from "@/lib/triage-types";

/**
 * The "Reassign…" choices for one item, best first: Claude's relevance for
 * that item (high, then medium), then everyone else alphabetically. Current
 * owners are left out (reassigning to them is refused anyway).
 */
export interface ReassignCandidate {
  githubLogin: string;
  /** Their open or acked primary assignments right now. */
  openPrimaries: number;
}

export interface ReassignOption {
  login: string;
  relevance: "high" | "medium" | null;
  openPrimaries: number;
  /** "alice · high match · 3 open". */
  label: string;
}

const RANK = { high: 0, medium: 1 } as const;

export function reassignOptions(
  candidates: readonly ReassignCandidate[],
  relevance: readonly Pick<TriageRelevance, "maintainer" | "relevance">[],
  exclude: readonly string[],
): ReassignOption[] {
  const excluded = new Set(exclude.map((login) => login.toLowerCase()));
  const level = new Map<string, "high" | "medium">();
  for (const judgement of relevance) {
    if (judgement.relevance === "high" || judgement.relevance === "medium") {
      level.set(judgement.maintainer.toLowerCase(), judgement.relevance);
    }
  }
  const seen = new Set<string>();
  const options: ReassignOption[] = [];
  for (const candidate of candidates) {
    const key = candidate.githubLogin.toLowerCase();
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    const match = level.get(key) ?? null;
    const open = Number.isFinite(candidate.openPrimaries) ? candidate.openPrimaries : 0;
    options.push({
      login: candidate.githubLogin,
      relevance: match,
      openPrimaries: open,
      label: [candidate.githubLogin, match ? `${match} match` : null, `${open} open`].filter(Boolean).join(" · "),
    });
  }
  return options.sort((a, b) => {
    const rankA = a.relevance ? RANK[a.relevance] : 2;
    const rankB = b.relevance ? RANK[b.relevance] : 2;
    if (rankA !== rankB) return rankA - rankB;
    // Within a match level, the less loaded person first; then by name.
    if (rankA < 2 && a.openPrimaries !== b.openPrimaries) return a.openPrimaries - b.openPrimaries;
    return a.login.toLowerCase().localeCompare(b.login.toLowerCase());
  });
}
