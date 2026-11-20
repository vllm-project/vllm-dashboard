import type { WhyUnowned } from "@/lib/triage-why-unowned";
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
  /** GitHub logins the item is assigned to on GitHub. */
  gh_assignees?: string[];
  /** Logins that commented (older items: derived from the stored comment text). */
  commenters?: string[];
  /** Authors of PRs the item names, by PR number. */
  referenced_pr_authors?: Record<string, string>;
  /** Open PRs: whose move it is (`whose_move` in triage/prepass.py). */
  waiting_on?: "author" | "reviewer";
  /** Why it waits on the author: draft, ci_failing, merge_conflict, changes_requested. */
  waiting_reasons?: string[];
  /** Checks failing on the PR's head commit (GraphQL ingest only). */
  failing_checks?: string[];
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
  /** "vi" makes the bot write to this person in Vietnamese (a one-off; see gau-nernst.yaml). */
  language?: "vi";
  // Digest delivery (maintainer file fields); kept as-is when the file is regenerated.
  timezone?: string;
  digest_hour?: number;
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
  /** Claude's relevance judgement per maintainer, strongest first. */
  relevance: TriageRelevance[];
  /** Why it has no open owner, as the router sees it; null when someone owns it. */
  whyUnowned: WhyUnowned | null;
}

export interface TriageRelevance {
  maintainer: string;
  relevance: "high" | "medium" | "low" | "none";
  reason: string;
  /** PRs from the maintainer's own profile that justify the judgement. */
  evidence: { number: number; kind: string; title: string }[];
  /** False when the item changed since it was judged (a re-judge is queued). */
  current: boolean;
  judgedAt: string;
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
  /**
   * People who dropped or marked slop at least `threshold` items in the last
   * 24 hours. Both actions stop an item from ever being routed again, so a
   * burst can hide real problems (a compromised or careless account).
   */
  suppression: { threshold: number; actors: { actor: string; drops: number; slops: number }[] };
  /** Raw pipeline-health signals; `pipelineHealth` in triage-health.ts grades them. */
  health: TriagePipelineHealth;
}

export interface TriagePipelineHealth {
  /** Newest Claude label (max triage_extractions.created_at), ISO. */
  lastLabelledAt: string | null;
  /** Newest relevance judgement (max triage_relevance.created_at), ISO. */
  lastJudgedAt: string | null;
  /** Open in-scope items waiting for (or being given) a label, retries included. */
  waitingForLabel: number;
  /** Oldest last-change time among items waiting for a label (they can't have waited longer). */
  labelWaitSince: string | null;
  /** Unowned open P0/P1 items missing a current judgement for some active maintainer. */
  waitingForJudgement: number;
  /** Oldest label time among those items whose label is current (ready to be judged). */
  judgementWaitSince: string | null;
  /** Items whose labelling failed, last touched in the past 24 hours. */
  labelFailures24h: number;
  /** Open in-scope items whose labelling failed on every attempt; never retried. */
  labelGaveUp: number;
  /** The newest labelling error text, for the tooltip. */
  lastLabelError: string | null;
  /** TRIAGE_CLAUDE_LOGIN_EXPIRES (YYYY-MM-DD) when set: when the extractor host's Claude login runs out. */
  loginExpiresOn: string | null;
}
