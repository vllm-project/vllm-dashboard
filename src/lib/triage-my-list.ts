import { formatAge } from "./triage-format";
import type { TriageQueueItem } from "./triage-types";

export type PlateEntryLike = Pick<TriageQueueItem, "kind" | "state" | "draft" | "waitingOn" | "reviewDecision" | "mergeReady" | "mergeCheckedAt"> & {
  assignment: { status: string; role?: string; assignedAt?: string; reason?: Record<string, unknown> };
};

export const PLATE_VIEWS = [
  { id: "attention", label: "Needs attention" },
  { id: "waiting", label: "Waiting on author" },
  { id: "all", label: "All" },
] as const;
export type PlateView = (typeof PLATE_VIEWS)[number]["id"];
// Preserve old shared links; the page converts these to the new filter controls.
export type LegacyPlateView = "needs-ack" | "acked" | "review" | "issues";
export function parsePlateView(value: string | null): PlateView | LegacyPlateView {
  return ["attention", "waiting", "all", "needs-ack", "acked", "review", "issues"].includes(value ?? "")
    ? value as PlateView | LegacyPlateView : "attention";
}

export function readyForReview(entry: PlateEntryLike): boolean {
  return entry.kind === "pr" && entry.state === "open" && !entry.draft
    && entry.waitingOn === "reviewer" && entry.reviewDecision !== "APPROVED";
}

/** Mirrors Queue's merge predicate, including its one-hour snapshot expiry. */
export function readyForMerge(entry: PlateEntryLike, now = Date.now()): boolean {
  return entry.kind === "pr" && entry.state === "open" && !entry.draft
    && entry.waitingOn === "reviewer" && entry.mergeReady === true
    && Date.parse(entry.mergeCheckedAt ?? "") > now - 3600_000;
}

export function plateNextAction(entry: PlateEntryLike, now = Date.now()) {
  if (entry.state !== "open") return "Closed on GitHub";
  if (entry.assignment.status === "open") return "Needs your ack";
  if (entry.kind === "issue") return "Follow up";
  if (entry.waitingOn === "author" || entry.draft) return "Waiting on author";
  if (readyForMerge(entry, now)) return "Ready to merge";
  if (readyForReview(entry)) return "Ready for review";
  return "Check PR status";
}

export function inPlateView(entry: PlateEntryLike, view: PlateView | LegacyPlateView): boolean {
  switch (view) {
    case "attention":
      return entry.state === "open" && plateNextAction(entry) !== "Waiting on author";
    case "waiting":
      return entry.kind === "pr" && entry.state === "open" && (entry.waitingOn === "author" || entry.draft);
    case "needs-ack": return entry.assignment.status === "open";
    case "acked": return entry.assignment.status === "acked";
    case "review": return readyForReview(entry);
    case "issues": return entry.kind === "issue";
    default: return true;
  }
}

export function overdueAck(entry: PlateEntryLike, now = Date.now()): boolean {
  return entry.state === "open" && entry.assignment.status === "open"
    && Date.parse(entry.assignment.assignedAt ?? "") < now - 3 * 86400_000;
}

export interface PlateFilters {
  view: PlateView;
  kind: "issue" | "pr" | null;
  role: "primary" | "backup" | null;
  status: "open" | "acked" | null;
  readiness: "review" | "merge" | null;
}

export function parsePlateFilters(params: URLSearchParams): PlateFilters {
  const view = parsePlateView(params.get("view"));
  return {
    view: view === "attention" || view === "waiting" || view === "all" ? view : "all",
    kind: params.get("kind") === "pr" ? "pr" : params.get("kind") === "issue" || view === "issues" ? "issue" : null,
    role: params.get("role") === "primary" ? "primary" : params.get("role") === "backup" ? "backup" : null,
    status: params.get("status") === "open" || view === "needs-ack" ? "open"
      : params.get("status") === "acked" || view === "acked" ? "acked" : null,
    readiness: params.get("readiness") === "merge" ? "merge"
      : params.get("readiness") === "review" || view === "review" ? "review" : null,
  };
}

export function plateFilterParams(filters: PlateFilters, item: string | null): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.view !== "attention") params.set("view", filters.view);
  for (const key of ["kind", "role", "status", "readiness"] as const) {
    if (filters[key]) params.set(key, filters[key]);
  }
  if (item) params.set("item", item);
  return params;
}

export function matchesPlateFilters(entry: PlateEntryLike, filters: PlateFilters, now = Date.now()): boolean {
  return inPlateView(entry, filters.view)
    && (!filters.kind || entry.kind === filters.kind)
    && (!filters.role || entry.assignment.role === filters.role)
    && (!filters.status || entry.assignment.status === filters.status)
    && (filters.readiness === "merge" ? readyForMerge(entry, now)
      : filters.readiness === "review" ? readyForReview(entry) : true);
}

export interface PlateStatus {
  /** "Needs your ack", "✓ Acked · follow up", "Done", "Closed on GitHub (merged)". */
  text: string;
  /** Not acked within 3 days: "ack overdue" follows the text, in amber. */
  overdue: boolean;
  /** Shown as a "Backup" tag; primary is the default and goes unsaid. */
  backup: boolean;
  /** Tooltip: "Assigned 4d ago", plus how it was acked or why it's flagged. */
  title: string;
}

const CLOSED_STATUS: Record<string, string> = {
  done: "Done",
  not_mine: "Not mine",
  reassigned: "Reassigned",
  // Drop and slop are one thing to users now: hidden for everyone.
  dropped: "Hidden for everyone",
  slop: "Hidden for everyone",
};

/** The status that starts line 2 of a My list row. */
export function plateStatus(entry: PlateEntryLike, now = Date.now()): PlateStatus {
  const { status, assignedAt, reason = {} } = entry.assignment;
  const assigned = assignedAt ? `Assigned ${formatAge(assignedAt, now)} ago` : "";
  const tip = (...extra: string[]) => [assigned, ...extra].filter(Boolean).join(" · ");
  const backup = entry.assignment.role === "backup";
  if (status !== "open" && status !== "acked") {
    const text = status === "done" && reason.closed_by === "github"
      ? `Closed on GitHub (${String(reason.item_state ?? "closed")})`
      : CLOSED_STATUS[status] ?? status.replace("_", " ");
    return { text, overdue: false, backup, title: tip() };
  }
  const next = plateNextAction(entry, now);
  if (status === "open") {
    const overdue = overdueAck(entry, now);
    return { text: next, overdue, backup, title: tip(overdue ? "not acked within 3 days" : "") };
  }
  const acked = reason.acked_by === "github_comment" ? "acked when you commented on GitHub" : "";
  const merge = next === "Ready to merge" ? "fresh observed readiness; confirm on GitHub before merging" : "";
  const text = next === "Closed on GitHub" ? `✓ Acked · closed on GitHub` : `✓ Acked · ${next.charAt(0).toLowerCase()}${next.slice(1)}`;
  return { text, overdue: false, backup, title: tip(acked, merge) };
}

/** The whole status as one string ("Needs your ack · ack overdue · Backup"), for labels and tests. */
export function plateStatusLabel(status: PlateStatus): string {
  return [status.text, status.overdue ? "ack overdue" : "", status.backup ? "Backup" : ""].filter(Boolean).join(" · ");
}
