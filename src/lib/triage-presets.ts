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
export type QueuePresetId = "needs-triage" | "not-acked" | "review" | "all";

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
    label: "Not acked yet",
    title: "Open items whose owner hasn't acked them yet",
    filters: { status: "open" },
  },
  {
    id: "review",
    label: "PRs ready to review",
    title: "Open PRs whose next move is a reviewer's: not a draft, CI not failing on its own account, no conflicts",
    filters: { kind: "pr", review: "ready" },
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
const PRESET_FIELDS = ["bands", "kind", "area", "hardware", "model", "owner", "status", "review", "state", "includeOutOfScope"] as const;

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
  for (const field of ["kind", "area", "hardware", "model", "owner", "status", "review", "state", "sort"] as const) {
    if (!sameValue(filters[field], base[field])) count++;
  }
  return count;
}

// --- My list (/triage/me) quick filters --------------------------------------

export const PLATE_VIEWS = [
  { id: "all", label: "All" },
  { id: "needs-ack", label: "Needs ack" },
  { id: "acked", label: "Acked" },
  { id: "review", label: "PRs ready to review" },
  { id: "issues", label: "Issues" },
] as const;

export type PlateView = (typeof PLATE_VIEWS)[number]["id"];

export function parsePlateView(value: string | null): PlateView {
  return PLATE_VIEWS.some((view) => view.id === value) ? (value as PlateView) : "all";
}

export interface PlateEntryLike {
  kind: "issue" | "pr";
  state: string;
  draft: boolean;
  waitingOn?: "author" | "reviewer" | null;
  assignment: { status: string };
}

/** Does a My list entry belong in this quick filter? */
export function inPlateView(entry: PlateEntryLike, view: PlateView): boolean {
  switch (view) {
    case "needs-ack":
      return entry.assignment.status === "open";
    case "acked":
      return entry.assignment.status === "acked";
    case "review":
      return entry.kind === "pr" && entry.state === "open" && !entry.draft && entry.waitingOn === "reviewer";
    case "issues":
      return entry.kind === "issue";
    default:
      return true;
  }
}
