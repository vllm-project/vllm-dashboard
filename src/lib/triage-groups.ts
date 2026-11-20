import type { TriageLinkedItem } from "@/lib/triage-types";

/**
 * Issue + fix PR groups, the dashboard side of triage/groups.py.
 *
 * A PR "fixes" an issue when GitHub lists it among the PR's closing
 * references, the PR says "Fixes/Closes/Resolves #N" (both in
 * prepass.fixes_issues), or Claude's label says so (facets.pr.fixes_issues).
 * Plain mentions don't count. `groupLinks` in triage-data.ts reads the links;
 * this file has the pure parts: nesting list rows and the group reason codes.
 */

/** Router reason codes on an assignment that followed its group: "fixes #N" / "fixed by #N". */
export const GROUP_REASON = /^(fixes|fixed by) #(\d+)$/;

export function isGroupReason(code: string): boolean {
  return GROUP_REASON.test(code);
}

export interface Groupable {
  itemKey: string;
  kind: "issue" | "pr";
  score: number | null;
  band: string | null;
  fixes?: readonly TriageLinkedItem[];
}

export interface NestedRow<T> {
  item: T;
  /** Fix PRs shown indented under this issue, highest score first. */
  members: T[];
}

/**
 * List rows with each fix PR nested under the issue it fixes when that issue
 * is in the same list (the highest-scored one when it fixes several). A
 * group keeps the position of its first row; the rest stand alone.
 */
export function nestGroups<T extends Groupable>(items: readonly T[]): NestedRow<T>[] {
  const issues = new Map(items.filter((item) => item.kind === "issue").map((item) => [item.itemKey, item]));
  const parent = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "pr") continue;
    let best: T | undefined;
    for (const target of item.fixes ?? []) {
      const issue = issues.get(target.itemKey);
      if (issue && (!best || (issue.score ?? -1) > (best.score ?? -1))) best = issue;
    }
    if (best) parent.set(item.itemKey, best.itemKey);
  }
  const rows = new Map<string, NestedRow<T>>();
  const byKey = new Map(items.map((item) => [item.itemKey, item]));
  for (const item of items) {
    const main = parent.get(item.itemKey) ?? item.itemKey;
    let row = rows.get(main);
    if (!row) {
      row = { item: byKey.get(main)!, members: [] };
      rows.set(main, row);
    }
    if (main !== item.itemKey && !row.members.includes(item)) row.members.push(item);
  }
  for (const row of rows.values()) row.members.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return [...rows.values()];
}

const BAND_RANK: Record<string, number> = { page: 0, route: 1, watch: 2, ignore: 3 };

/** A group is as urgent as its most urgent member (a P0 fix PR makes its P1 issue's row a P0 row). */
export function groupBand<T extends Groupable>(row: NestedRow<T>): string | null {
  let band = row.item.band;
  for (const member of row.members) {
    if ((BAND_RANK[member.band ?? ""] ?? 9) < (BAND_RANK[band ?? ""] ?? 9)) band = member.band;
  }
  return band;
}

/** "#67812 (merged)", or "#67812" while it's open. */
export function linkLabel(link: Pick<TriageLinkedItem, "number" | "state">): string {
  return link.state === "open" ? `#${link.number}` : `#${link.number} (${link.state})`;
}

/** Item keys in the order the list draws them: each row, then its nested fix PRs. */
export function rowOrder(rows: readonly { item: { itemKey: string }; members: readonly { itemKey: string }[] }[]): string[] {
  return rows.flatMap(({ item, members }) => [item.itemKey, ...members.map((member) => member.itemKey)]);
}
