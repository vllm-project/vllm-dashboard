import {
  LANDING_BANDS,
  parseQueueFilters,
  queueFiltersToParams,
  OWNER_NONE,
  type QueueFilters,
} from "@/lib/triage-query";
import { DEFAULT_QUEUE_BANDS, TRIAGE_BANDS } from "@/lib/triage-vocab";

/**
 * One-click views on /triage. Each preset is a set of URL filters, so links
 * stay shareable. "Needs triage" is the landing view (no params), and old
 * links land sensibly: `?bands=page,route&owner=none` (Slack, My list) is
 * "Needs triage", and `?view=<id>` accepts the preset ids, old ones too
 * (`unowned` → needs-triage). Search (`q`) and sort are kept when switching
 * presets; everything else is replaced.
 */
export type QueuePresetId = "needs-triage" | "not-acked" | "review" | "merge" | "cleanup" | "all";

export interface QueuePreset {
  id: QueuePresetId;
  label: string;
  title: string;
  /** Filters on top of the literal defaults (P0–P2, anyone, open). */
  filters: Partial<QueueFilters>;
}

export const QUEUE_PRESETS: readonly QueuePreset[] = [
  {
    id: "needs-triage",
    label: "Needs triage",
    title: "Open P0 and P1 items nobody owns yet (the default view)",
    filters: { bands: [...LANDING_BANDS], owner: OWNER_NONE },
  },
  {
    id: "not-acked",
    label: "Not acked",
    title: "Open items whose owner hasn't acked them yet",
    filters: { status: "open" },
  },
  {
    id: "review",
    label: "Ready to review",
    title: "Open PRs waiting on a reviewer: not a draft, not yet approved, CI not failing on its own account, no conflicts",
    filters: { kind: "pr", review: "ready" },
  },
  {
    id: "merge",
    label: "Ready to merge",
    title: "Approved, conflict-free PRs with successful checks and CI on the observed head, checked within the last hour. Confirm on GitHub before merging.",
    filters: { bands: [...TRIAGE_BANDS], kind: "pr", review: "merge" },
  },
  {
    id: "cleanup",
    label: "Suggested to close",
    title: "Open PRs we suggest closing: competing fixes or low-effort signals. Suggestions only; review before closing.",
    filters: { bands: [...TRIAGE_BANDS], kind: "pr", review: "cleanup" },
  },
  {
    id: "all",
    label: "All",
    title: "Every open item, including P3 and unscored",
    filters: { bands: [...TRIAGE_BANDS] },
  },
];

/** Preset ids accepted in `?view=`, including retired ones. */
const VIEW_ALIASES: Record<string, QueuePresetId> = {
  "needs-triage": "needs-triage",
  unowned: "needs-triage",
  "needs-owner": "needs-triage",
  "not-acked": "not-acked",
  review: "review",
  merge: "merge",
  "ready-to-merge": "merge",
  cleanup: "cleanup",
  close: "cleanup",
  dupes: "cleanup",
  all: "all",
};

/**
 * The queue's filters from its URL: `?view=<preset>` (any id, old or new)
 * expands to that preset; otherwise parseQueueFilters as usual.
 */
export function parseQueueLocation(params: URLSearchParams): QueueFilters {
  const view = VIEW_ALIASES[params.get("view") ?? ""];
  const parsed = parseQueueFilters(params);
  return view ? presetFilters(view, parsed) : parsed;
}

/** Filters the presets set; search, sort and paging are left alone. */
const PRESET_FIELDS = ["bands", "kind", "area", "hardware", "model", "owner", "status", "review", "focus", "state", "includeOutOfScope"] as const;

/** Literal defaults: P0–P2, anyone, open (not the landing view). */
function defaults(): QueueFilters {
  return parseQueueFilters(new URLSearchParams(`bands=${DEFAULT_QUEUE_BANDS.join(",")}`));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value) => b.includes(value));
  }
  return a === b;
}

/** The full filters a preset applies to `current` (keeps its search and sort; page 1). */
export function presetFilters(id: QueuePresetId, current: QueueFilters = defaults()): QueueFilters {
  const preset = QUEUE_PRESETS.find((candidate) => candidate.id === id) ?? QUEUE_PRESETS[0];
  return {
    ...defaults(),
    ...preset.filters,
    q: current.q,
    sort: current.sort,
    pageSize: current.pageSize,
    page: 1,
  };
}

/** The `/triage?…` query string for a preset (without the leading "?"). */
export function presetQuery(id: QueuePresetId, current?: QueueFilters): string {
  return queueFiltersToParams(presetFilters(id, current)).toString();
}

/** Which preset these filters are exactly (ignoring search, sort and paging), if any. */
export function activePreset(filters: QueueFilters): QueuePresetId | null {
  const base = defaults();
  for (const preset of QUEUE_PRESETS) {
    const expected = { ...base, ...preset.filters };
    if (PRESET_FIELDS.every((field) => sameValue(filters[field], expected[field]))) return preset.id;
  }
  return null;
}

/**
 * How many filters in the Filters popover are set beyond the view (the
 * "Filters 2" badge): 0 on an exact preset apart from a changed sort,
 * otherwise what differs from the literal defaults (P0–P2, anyone). Search has its own box and
 * is not counted.
 */
export function activeFilterCount(filters: QueueFilters): number {
  const base = defaults();
  if (activePreset(filters) !== null) return filters.sort !== base.sort ? 1 : 0;
  let count = 0;
  if (!sameValue(filters.bands, [...DEFAULT_QUEUE_BANDS])) count++;
  for (const field of ["kind", "area", "hardware", "model", "owner", "status", "review", "focus", "state", "sort"] as const) {
    if (!sameValue(filters[field], base[field])) count++;
  }
  return count;
}

// Re-export for callers with existing My list imports.
export { PLATE_VIEWS, parsePlateView, inPlateView, type PlateView, type PlateEntryLike } from "./triage-my-list";

/** Focus shortcuts start across owners/statuses; users can narrow them afterward. */
export function focusFilters(focus: QueueFilters["focus"]): Partial<QueueFilters> {
  return {
    focus, owner: null, status: "any", review: null, state: "open",
    kind: focus === "has-fix" ? "issue" : focus === "cleanup" ? "pr" : null,
    bands: focus === "has-fix" || focus === "stale" ? [...LANDING_BANDS] : [...TRIAGE_BANDS],
  };
}

export function queueViewDescription(filters: QueueFilters): string | null {
  if (filters.review === "cleanup" || filters.focus === "cleanup") return "PRs we suggest closing: a competing fix exists, or the PR shows low-effort or slop signals (all priorities). Review each one before closing; these are suggestions, not confirmed duplicates.";
  if (filters.focus === "fires") return "Open items flagged as serving broken, security, or regressions.";
  if (filters.focus === "has-fix") return "Open P0/P1 issues with an open fix PR.";
  if (filters.focus === "stale") return "Open P0/P1 items unowned for over 3 days since becoming routable, or unacked for over 3 days since assignment.";
  if (filters.review === "merge") return "Approved, conflict-free PRs with successful checks and CI on the observed head, checked within the last hour. Confirm on GitHub before merging.";
  if (filters.review === "blocked") return "PRs waiting on their author: drafts, conflicts, requested changes, or failing checks/CI.";
  return null;
}
