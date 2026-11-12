import type {
  AssignmentStatus,
  NotifyMode,
  TriageAction,
} from "@/lib/triage-vocab";

/** LLM facets (prompt v1). Every field is optional on read: rows are untrusted. */
export interface TriageFacets {
  type?: string;
  summary?: string;
  models?: { name?: string; family?: string }[];
  model_traits?: string[];
  hardware?: string[];
  serving?: string[];
  areas?: string[];
  severity?: {
    serving_broken?: boolean;
    crash?: boolean;
    wrong_output?: boolean;
    hang?: boolean;
    perf_regression_pct?: number | null;
    memory_regression?: boolean;
    security?: boolean;
  };
  default_config?: boolean | null;
  versions?: {
    good?: string | null;
    bad?: string | null;
    affects_main?: boolean | null;
    affects_latest_release?: boolean | null;
  };
  has_repro?: boolean;
  pr?: {
    fixes_issues?: number[];
    hot_path?: boolean;
    size?: string;
    has_tests?: boolean;
    low_effort?: boolean;
  } | null;
  slop_signals?: string[];
  confidence?: number;
  notes?: string;
}

export interface TriagePrepass {
  areas?: string[];
  linked_issues?: number[];
  hardware_hints?: string[];
  model_hints?: string[];
  is_maintainer?: boolean;
  first_time?: boolean;
  template?: Record<string, boolean>;
  slop_hints?: string[];
  scope_reason?: string;
}

export interface TriageBreakdownEntry {
  factor: string;
  points: number;
  detail?: string;
}

export interface TriageRules {
  areas: string[];
  hardware: string[];
  models: string[];
  paths: string[];
  keywords: string[];
  types: string[];
  exclude: { types: string[]; areas: string[]; hardware: string[] };
  natural_language: string;
}

export interface TriageAssignmentSummary {
  id: number;
  maintainer: string;
  role: "primary" | "backup";
  status: AssignmentStatus;
}

export interface TriageQueueItem {
  itemKey: string;
  repo: string;
  number: number;
  kind: "issue" | "pr";
  title: string;
  htmlUrl: string;
  author: string;
  state: string;
  draft: boolean;
  ghCreatedAt: string;
  ghUpdatedAt: string;
  score: number | null;
  band: string | null;
  summary: string | null;
  type: string | null;
  areas: string[];
  models: string[];
  hardware: string[];
  serving: string[];
  /** facets.severity, for the scan-for flags (serving broken, crash, …). */
  severity: NonNullable<TriageFacets["severity"]> | null;
  assignments: TriageAssignmentSummary[];
}

export interface TriageQueueResponse {
  items: TriageQueueItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TriageAssignment extends TriageAssignmentSummary {
  itemKey: string;
  reason: Record<string, unknown>;
  scoreAtAssign: number;
  assignedBy: string;
  assignedAt: string;
  notifiedAt: string | null;
  closedAt: string | null;
}

export interface TriageActionRecord {
  id: number;
  itemKey: string;
  assignmentId: number | null;
  actor: string;
  action: TriageAction;
  target: string | null;
  note: string | null;
  source: string;
  createdAt: string;
}

export interface TriageItemDetail {
  item: {
    itemKey: string;
    repo: string;
    number: number;
    kind: "issue" | "pr";
    title: string;
    htmlUrl: string;
    author: string;
    authorAssociation: string;
    state: string;
    draft: boolean;
    labels: string[];
    files: { path?: string; additions?: number; deletions?: number }[];
    reactions: number;
    commentCount: number;
    ghCreatedAt: string;
    ghUpdatedAt: string;
    prepass: TriagePrepass;
    inScope: boolean;
    extractionStatus: string;
    extractionError: string | null;
  };
  score: {
    score: number;
    band: string;
    breakdown: TriageBreakdownEntry[];
    scoringVersion: string;
    scoredAt: string;
  } | null;
  extraction: {
    id: number;
    facets: TriageFacets;
    model: string;
    promptVersion: string;
    createdAt: string;
  } | null;
  assignments: TriageAssignment[];
  actions: TriageActionRecord[];
}

export interface TriageMyPlate {
  login: string;
  open: (TriageQueueItem & { assignment: TriageAssignment })[];
  recentlyClosed: (TriageQueueItem & { assignment: TriageAssignment })[];
}

export interface TriageMaintainer {
  githubLogin: string;
  slackUserId: string | null;
  active: boolean;
  rules: TriageRules;
  minScore: number;
  capacityPerWeek: number;
  away: { start: string; end: string }[];
  notifyMode: NotifyMode;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface TriageStats {
  /** In-scope open items by band ("unscored" = no score row yet). */
  bandCounts: Record<"page" | "route" | "watch" | "ignore" | "unscored", number>;
  /** In-scope open page/route items with no open or acked assignment. */
  unowned: number;
  /** The page-band subset of `unowned`. */
  unownedPage: number;
  /** Items first seen since 00:00 UTC today. */
  newToday: number;
  ingestedLast24h: number;
  inScopeLast7d: number;
  extractedLast7d: number;
  pageUnacked: number;
  assignedLast7d: number;
  notMineLast7d: number;
}
