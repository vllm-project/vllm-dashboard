/**
 * Plain words for the codes the triage tables store (action, source,
 * extraction status, relevance, scope). Score factors have their own module,
 * triage-factors.ts.
 */

const ACTION_WORDS: Record<string, string> = {
  ack: "acknowledged it",
  not_mine: "said “not mine”",
  reassign: "reassigned it",
  drop: "dropped it",
  slop: "marked it as slop",
  done: "marked it done",
  reopen: "reopened it",
};

/** "khluu reassigned it to gau-nernst" (actor is rendered separately). */
export function actionText(action: string, target: string | null): string {
  const words = ACTION_WORDS[action] ?? action.replace(/_/g, " ");
  return action === "reassign" && target ? `reassigned it to ${target}` : words;
}

const SOURCE_WORDS: Record<string, string> = {
  dashboard: "on the dashboard",
  slack: "from Slack",
  cli: "from the command line",
  router: "by the router",
};

export function sourceText(source: string): string {
  return SOURCE_WORDS[source] ?? source;
}

const EXTRACTION_WORDS: Record<string, string> = {
  pending: "waiting for the LLM to read it",
  running: "the LLM is reading it now",
  done: "read by the LLM",
  failed: "the LLM read failed; it will be retried",
  skipped: "skipped: not something triage covers",
};

export function extractionText(status: string): string {
  return EXTRACTION_WORDS[status] ?? status;
}

/** One line per relevance level, for tooltips and the "Who it's for" list. */
export const RELEVANCE_MEANING: Record<string, string> = {
  high: "Strong match: their recent PRs touch this code or feature. Routed.",
  medium: "Related: they work close to this and are a reasonable owner. Routed.",
  low: "Weak link only. Never routed.",
  none: "Unrelated to their recent work. Never routed.",
};

const SCOPE_WORDS: Record<string, string> = {
  issue: "an issue",
  pr_external: "a PR from an outside contributor",
  pr_linked_issue: "a PR that fixes a tracked issue",
  pr_maintainer_unlinked: "a maintainer's PR with no linked issue (not triaged)",
  bot: "opened by a bot (not triaged)",
};

export function scopeText(reason: string | undefined): string | null {
  if (!reason) return null;
  return SCOPE_WORDS[reason] ?? reason.replace(/_/g, " ");
}

export function yesNo(value: boolean | null | undefined): string {
  return value === true ? "yes" : value === false ? "no" : "unknown";
}

/** 0.82 → "82%"; anything else → "—". */
export function percentText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}
