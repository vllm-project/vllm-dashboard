import { ciLine, type CiTone, type TriageCi } from "@/lib/triage-ci";
import { humanizeTag } from "@/lib/triage-factors";
import { groupBand, type NestedRow } from "@/lib/triage-groups";
import { severityFlags, type SeverityFlag } from "@/lib/triage-style";
import type { TriageFacets, TriageQueueItem } from "@/lib/triage-types";

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
  const all = [...item.hardware.map(plain), ...item.models.map((m) => m.trim()), ...item.areas.map(plain)];
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

/** The kind label before the title: "Issue", "PR", or "Fix PR" (drawn "↳ Fix PR") under its issue. */
export function kindLabel(item: Pick<TriageQueueItem, "kind">, nested: boolean): "Issue" | "PR" | "Fix PR" {
  if (item.kind === "issue") return "Issue";
  return nested ? "Fix PR" : "PR";
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

/** The label text, e.g. "Fix PR for #65364" or "Fix PR for #1, #2". */
export function fixLabelText(targets: readonly FixTarget[]): string {
  return `Fix PR for ${targets.map((target) => `#${target.number}`).join(", ")}`;
}
