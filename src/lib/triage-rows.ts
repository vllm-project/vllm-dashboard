import { ciLine, type CiTone, type TriageCi } from "@/lib/triage-ci";
import { humanizeTag } from "@/lib/triage-factors";
import { formatAge } from "@/lib/triage-format";
import { groupBand, type NestedRow } from "@/lib/triage-groups";
import { severityFlags, type SeverityFlag } from "@/lib/triage-style";
import type { TriageCleanupInfo, TriageFacets, TriageQueueItem } from "@/lib/triage-types";

/**
 * What a queue / My list row shows, as plain data (item-row.tsx draws it).
 *
 * Two calm lines per row. Line 1: kind ("Issue", "PR", or "↳ Fix PR" for a
 * fix nested under its issue), title, muted "#123 ↗". Line 2: at most one
 * impact badge (the single worst symptom), CI only when actionable, then
 * plain muted context (hardware · model · area) and "Fixes #N". Everything
 * else is in the drawer.
 */

// --- symptom chip -------------------------------------------------------------

/** Worst first. Keys come from `severityFlags` (triage-style.ts). */
export const SYMPTOM_RANK: readonly string[] = [
  "serving_broken",
  "crash",
  "wrong_output",
  "security",
  "hang",
  "regression",
  "perf",
  "memory",
];

/** The one symptom a row shows, and the rest for its tooltip. */
export function worstSymptom(
  facets: Pick<TriageFacets, "severity" | "type"> | null | undefined,
): { flag: SeverityFlag; others: SeverityFlag[] } | null {
  const flags = severityFlags(facets);
  if (flags.length === 0) return null;
  const rank = (flag: SeverityFlag) => {
    const index = SYMPTOM_RANK.indexOf(flag.key);
    return index === -1 ? SYMPTOM_RANK.length : index;
  };
  const sorted = [...flags].sort((a, b) => rank(a) - rank(b));
  return { flag: sorted[0], others: sorted.slice(1) };
}

// --- CI chip ------------------------------------------------------------------

export interface RowCiChip {
  label: string;
  tone: CiTone;
  title: string;
}

/**
 * CI on a row only when it's actionable: "2 CI failed" (red; amber with
 * "(main)" when every failure also fails on main), "CI ✓", "CI running".
 * Not run or canceled: nothing (the drawer has it).
 */
export function rowCiChip(ci: TriageCi | null | undefined): RowCiChip | null {
  if (!ci) return null;
  const title = `CI: ${ciLine(ci)}`;
  const failed = ci.jobs_failed > 0;
  const mainOnly = ci.main_known && failed && ci.jobs_failed_pr_only === 0;
  const failedLabel = `${ci.jobs_failed} CI failed${mainOnly ? " (main)" : ""}`;
  switch (ci.state) {
    case "passed":
      return { label: "CI ✓", tone: "pass", title };
    case "failed":
      return { label: failed ? failedLabel : "CI failed", tone: mainOnly ? "main" : "fail", title };
    case "running":
      return failed
        ? { label: failedLabel, tone: mainOnly ? "main" : "fail", title }
        : { label: "CI running", tone: "running", title };
    default:
      return null;
  }
}

export interface ImpactBadge {
  label: string;
  flag: SeverityFlag;
  /** The other symptoms, for the tooltip (no "+1" on the row). */
  title: string;
}

/** The single impact badge for a row, or null. */
export function impactBadge(item: Pick<TriageQueueItem, "severity" | "type">): ImpactBadge | null {
  const symptom = worstSymptom({ severity: item.severity ?? undefined, type: item.type ?? undefined });
  if (!symptom) return null;
  return {
    label: symptom.flag.label,
    flag: symptom.flag,
    title: symptom.others.length
      ? `${symptom.flag.label}; also ${symptom.others.map((flag) => flag.label).join(", ")}`
      : symptom.flag.label,
  };
}

export interface CleanupReasonView {
  label: string;
  title: string;
  /** Other competing PRs on the same issue, clickable to open their drawer. */
  peers?: { itemKey: string; number: number; htmlUrl: string }[];
}

/** Plain-English reasons a PR is listed in Suggested to close; empty outside that view. */
export function cleanupReasons(cleanup: TriageCleanupInfo | null | undefined): CleanupReasonView[] {
  if (!cleanup) return [];
  const out: CleanupReasonView[] = [];
  for (const group of cleanup.competesWith) {
    const nums = group.prs.map((pr) => `#${pr.number}`).join(", ");
    out.push({
      label: `Competes on #${group.issueNumber}:`,
      title: `Another open non-draft PR also fixes #${group.issueNumber}: ${nums}`,
      peers: group.prs,
    });
  }
  if (cleanup.lowEffort) {
    out.push({ label: "Low effort", title: "Flagged low effort during triage extraction" });
  }
  if (cleanup.slopSignals.length > 0) {
    const first = humanizeTag(cleanup.slopSignals[0]);
    const extra = cleanup.slopSignals.length > 1 ? ` +${cleanup.slopSignals.length - 1}` : "";
    out.push({
      label: `Slop: ${first}${extra}`,
      title: `Slop signals: ${cleanup.slopSignals.map(humanizeTag).join(", ")}`,
    });
  }
  return out;
}

/**
 * Compact scan-friendly review-effort summary for PR rows: diff size, whether
 * tests are included, and maintainer / first-time author signal.
 */
/** PR size bucket (Claude's estimate from lines changed) in plain words. */
export const PR_SIZE_WORDS: Record<string, string> = {
  XS: "tiny PR",
  S: "small PR",
  M: "medium PR",
  L: "large PR",
  XL: "very large PR",
};
export const PR_SIZE_HELP = "Size by lines changed: tiny <10, small <50, medium <250, large <1,000, very large 1,000+";

export function prEffortText(
  item: Pick<TriageQueueItem, "kind" | "prSize" | "hasTests" | "isMaintainer" | "firstTime">,
): { text: string; title: string } | null {
  if (item.kind !== "pr") return null;
  // The row shows only flags that change what a reviewer does: a first-time
  // author, a large/very large diff, or no tests on a medium+ diff. Normal PRs
  // (small/medium, with tests, by a regular contributor) show nothing; the
  // tooltip always has every fact.
  const flags: string[] = [];
  const details: string[] = [];
  const size = item.prSize?.trim().toUpperCase();
  if (size && size in PR_SIZE_WORDS) {
    const words = PR_SIZE_WORDS[size];
    if (size === "L" || size === "XL") flags.push(words);
    details.push(`${words[0].toUpperCase()}${words.slice(1)}. ${PR_SIZE_HELP}`);
  }
  if (item.hasTests === true) {
    details.push("The diff adds or changes tests");
  } else if (item.hasTests === false && (size === "M" || size === "L" || size === "XL")) {
    flags.push("no tests");
    details.push("No tests in the diff (flagged for medium or larger PRs)");
  }
  if (item.isMaintainer) {
    details.push("The author is a vLLM maintainer");
  } else if (item.firstTime) {
    flags.push("first-time contributor");
    details.push("The author's first PR to vLLM");
  }
  if (flags.length === 0) return null;
  return { text: flags.join(" · "), title: details.join("\n") };
}

/** Distills `triage_scores.unowned_reason.summary` into a 2-word hint for the Owner column. */
export function unownedHint(reason: string | null | undefined): { label: string; title: string } | null {
  const summary = reason?.trim();
  if (!summary) return null;
  const lower = summary.toLowerCase();
  if (lower.includes("nobody is a match")) return { label: "no match", title: summary };
  if (lower.includes("can't take it right now")) return { label: "at capacity", title: summary };
  if (lower.includes("assigned on github")) return { label: "assigned on GitHub", title: summary };
  if (lower.includes("waiting") || lower.includes("not judged") || lower.includes("pending")) {
    return { label: "waiting for a match", title: summary };
  }
  return { label: "no clear owner", title: summary };
}

/**
 * Fresh-activity sub-label for the Age column: shown only when an item is over
 * 2 days old but had activity within the last 24 hours, so active PRs don't
 * look abandoned.
 */
export function activityNote(
  ghCreatedAt: string,
  ghUpdatedAt: string,
  now: number = Date.now(),
): { label: string; title: string } | null {
  const created = Date.parse(ghCreatedAt);
  const updated = Date.parse(ghUpdatedAt);
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return null;
  const createdAge = now - created;
  const updatedAge = now - updated;
  if (createdAge < 48 * 3600_000 || updatedAge >= 24 * 3600_000 || updated - created < 12 * 3600_000) {
    return null;
  }
  const age = formatAge(ghUpdatedAt, now);
  return { label: `updated ${age} ago`, title: `Last activity on GitHub ${age} ago` };
}

// --- context line -------------------------------------------------------------

/** "CPU_x86" → "CPU x86", "kv_cache" → "kv cache". */
function plain(value: string): string {
  return humanizeTag(value);
}

/**
 * One muted line: hardware, then models, then areas, de-duplicated
 * case-insensitively ("CPU x86" hardware and "cpu" area both stay: they
 * differ), at most `max` shown and "+N" with the rest in a tooltip.
 */
export function contextText(
  item: Pick<TriageQueueItem, "models" | "hardware" | "areas">,
  max = 3,
): { text: string; more: number; hidden: string[] } {
  const seen = new Set<string>();
  const values: string[] = [];
  // Model names stay as written ("DeepSeek-V4-Flash"); tags read as words ("CPU_x86" → "CPU x86").
  // Most useful for "is this mine?" first: model, then area, then hardware.
  const all = [...item.models.map((m) => m.trim()), ...item.areas.map(plain), ...item.hardware.map(plain)];
  for (const value of all) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  const shown = values.slice(0, max);
  return { text: shown.join(" · "), more: values.length - shown.length, hidden: values.slice(max) };
}

// --- line 1 -----------------------------------------------------------------

/**
 * The kind tag at the start of every row's title line, same width and place
 * on every row so it reads as a column: "ISSUE" (plain) or "PR" (outlined),
 * each with its shape icon, never colour alone. A fix PR in a group card
 * adds "· fix for #65364".
 */
export interface KindTag {
  word: "Issue" | "PR";
  style: "issue" | "pr";
  /** "fix for #65364" / "fix for #1, #2" on a fix PR in a card; else null. */
  fixFor: string | null;
  /** For screen readers: "Issue", "Pull request", "Pull request, fix for #65364". */
  label: string;
}

export function kindTag(item: Pick<TriageQueueItem, "kind">, fixFor?: readonly { number: number }[] | null): KindTag {
  if (item.kind === "issue") return { word: "Issue", style: "issue", fixFor: null, label: "Issue" };
  const text = fixFor && fixFor.length ? `fix for ${fixFor.map((target) => `#${target.number}`).join(", ")}` : null;
  return { word: "PR", style: "pr", fixFor: text, label: text ? `Pull request, ${text}` : "Pull request" };
}

/** The drawer header: "Issue #65364" / "Pull request #65365". */
export function kindHeading(kind: "issue" | "pr", number: number | string): string {
  return `${kind === "pr" ? "Pull request" : "Issue"} #${number}`;
}

// --- score --------------------------------------------------------------------

/** The row's score as number + unit ("79" + "pts"); the real number, uncapped. */
export function scoreParts(score: number | null | undefined): { value: string; unit: string } {
  if (typeof score !== "number" || !Number.isFinite(score)) return { value: "—", unit: "" };
  return { value: String(Math.round(score)), unit: "pts" };
}

export const SCORE_TOOLTIP = "Impact score in points (0–100+): how it's computed";

// --- groups -------------------------------------------------------------------

export interface ListRow<T> {
  item: T;
  /** A fix PR drawn under its issue (indented in the item column only). */
  nested: boolean;
  /** For the connector line: an issue with fix PRs under it, or a fix PR that isn't the last one. */
  connectsDown: boolean;
  /** Other group members already on screen, left out of its "Fixes / Fixed by" text. */
  shownLinks: string[];
}

/**
 * The rows in drawn order (issue, then its fix PRs), which is also the j/k
 * order. Every row keeps its own stripe and priority cell; only the item
 * column of a fix PR is indented.
 */
export function listRows<T extends TriageQueueItem>(rows: readonly NestedRow<T>[]): ListRow<T>[] {
  return rows.flatMap(({ item, members }) => [
    {
      item,
      nested: false,
      connectsDown: members.length > 0,
      shownLinks: members.map((member) => member.itemKey),
    },
    ...members.map((member, index) => ({
      item: member,
      nested: true,
      connectsDown: index < members.length - 1,
      shownLinks: [item.itemKey],
    })),
  ]);
}

/** "Fixes #65568" / "Fixed by #1, #2" for links not already on screen; null when none. */
export function linkText(
  item: Pick<TriageQueueItem, "kind" | "fixes" | "fixedBy">,
  shown: readonly string[],
): { verb: "Fixes" | "Fixed by"; links: TriageQueueItem["fixes"] } | null {
  const links = (item.kind === "pr" ? item.fixes : item.fixedBy).filter((link) => !shown.includes(link.itemKey));
  return links.length ? { verb: item.kind === "pr" ? "Fixes" : "Fixed by", links } : null;
}

// --- group cards ----------------------------------------------------------------

/** "#1", "#1 and #2", "#1, #2 and #3". */
function numberList(numbers: readonly number[]): string {
  const parts = numbers.map((n) => `#${n}`);
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export type ListBlock<T> =
  | { kind: "single"; key: string; row: ListRow<T> }
  | {
      kind: "group";
      key: string;
      /** One stripe for the whole card: the most urgent member's band. */
      band: string | null;
      /** For role="group": "Issue #65364 and its fix PR #65365". */
      label: string;
      rows: ListRow<T>[];
    };

/**
 * The list as drawn: an issue with fix PRs under it becomes one card (one
 * stripe, no dividers inside); everything else stays a plain row. Rows keep
 * the `listRows` order, which is also the j/k order.
 */
export function listBlocks<T extends TriageQueueItem>(rows: readonly NestedRow<T>[]): ListBlock<T>[] {
  return rows.map((row) => {
    const shaped = listRows([row]);
    if (row.members.length === 0) return { kind: "single", key: row.item.itemKey, row: shaped[0] };
    const lead = `${row.item.kind === "issue" ? "Issue" : "PR"} #${row.item.number}`;
    const fixes = row.members.map((member) => member.number);
    return {
      kind: "group",
      key: row.item.itemKey,
      band: groupBand(row),
      label: `${lead} and its fix ${fixes.length === 1 ? "PR" : "PRs"} ${numberList(fixes)}`,
      rows: shaped,
    };
  });
}

export interface FixTarget {
  itemKey: string;
  number: number;
}

/**
 * What a nested fix PR's label names: "Fix PR for #65364", or "for #a, #b"
 * when it fixes several issues. The issue it sits under comes first.
 */
export function fixTargets(item: Pick<TriageQueueItem, "fixes">, leadKey: string, leadNumber: number): FixTarget[] {
  const targets: FixTarget[] = [{ itemKey: leadKey, number: leadNumber }];
  for (const link of item.fixes) {
    if (!targets.some((target) => target.itemKey === link.itemKey)) {
      targets.push({ itemKey: link.itemKey, number: link.number });
    }
  }
  return targets;
}

/** The label text, e.g. "PR · fix for #65364" (tests, aria). */
export function fixLabelText(targets: readonly FixTarget[]): string {
  return `PR · ${kindTag({ kind: "pr" }, targets).fixFor}`;
}

// --- one score per card -----------------------------------------------------------

export interface PriorityCellView {
  /** False for a fix PR inside a card: the card's issue row carries the score. */
  show: boolean;
  band: string | null;
  score: number | null;
  /** Set when the pill is the group's band rather than the row's own. */
  tooltip: string | null;
}

/**
 * What a row's Priority · Score cell shows. Standalone rows: their own band
 * and score. In a group card only the issue row shows one: the card's band
 * (the most urgent member's) and the issue's own score; when a fix PR is more
 * urgent the tooltip says so ("Group priority; this issue scores 55, its fix
 * PR 75"). Fix PR rows in a card show nothing (their score is in the drawer).
 */
export function priorityCell(
  item: Pick<TriageQueueItem, "band" | "score">,
  card?: { band: string | null; lead: boolean; memberScores: readonly (number | null)[] } | null,
): PriorityCellView {
  if (!card) return { show: true, band: item.band, score: item.score, tooltip: null };
  if (!card.lead) return { show: false, band: null, score: null, tooltip: null };
  if (card.band === item.band) return { show: true, band: item.band, score: item.score, tooltip: null };
  const scores = card.memberScores.map((score) => (score === null ? "—" : String(Math.round(score))));
  const own = item.score === null ? "isn't scored yet" : `scores ${Math.round(item.score)}`;
  const theirs = scores.length === 1 ? `its fix PR ${scores[0]}` : `its fix PRs ${scores.join(", ")}`;
  return { show: true, band: card.band, score: item.score, tooltip: `Group priority; this issue ${own}, ${theirs}` };
}

// --- fix PR status ------------------------------------------------------------------

/**
 * Line 2 of a fix PR inside a card: what's actionable for the PR. CI when it
 * says something (rowCiChip) and whose move it is.
 */
export function fixPrStatus(item: Pick<TriageQueueItem, "ci" | "waitingOn" | "draft" | "state">): {
  ci: RowCiChip | null;
  move: { text: string; tone: "ready" | "muted" } | null;
} {
  const ci = rowCiChip(item.ci);
  let move: { text: string; tone: "ready" | "muted" } | null = null;
  if (item.state === "open") {
    if (item.draft) move = { text: "draft", tone: "muted" };
    else if (item.waitingOn === "author") move = { text: "waiting on author", tone: "muted" };
    else if (item.waitingOn === "reviewer") move = { text: "ready for review", tone: "ready" };
  } else {
    move = { text: item.state === "merged" ? "merged" : "closed", tone: "muted" };
  }
  return { ci, move };
}
