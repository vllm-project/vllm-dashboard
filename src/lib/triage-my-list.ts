import type { TriageQueueItem } from "./triage-types";

export type PlateEntryLike = Pick<TriageQueueItem, "kind" | "state" | "draft" | "waitingOn" | "reviewDecision" | "mergeReady" | "mergeCheckedAt"> & {
  assignment: { status: string; role?: string; assignedAt?: string };
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
