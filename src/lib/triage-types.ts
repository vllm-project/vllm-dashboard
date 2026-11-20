import type { TriageCi } from "@/lib/triage-ci";
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
  /** PRs: issues it fixes (closing keywords and GitHub closing references); see triage/groups.py. */
  fixes_issues?: number[];
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
  merge_ready?: boolean;
  merge_checked_at?: string | null;
  checks_state?: string | null;
  head_sha?: string | null;
  /** Why it waits on the author: draft, ci_failing, merge_conflict, changes_requested. */
  waiting_reasons?: string[];
  /** GitHub PR reviewDecision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED. */
  review_decision?: string | null;
  /** GitHub PR mergeable state: MERGEABLE, CONFLICTING, UNKNOWN. */
  mergeable?: string | null;
  /** Checks failing on the PR's head commit (GraphQL ingest only). */
  failing_checks?: string[];
  /** Failed CI jobs that aren't failing on main, when that makes it the author's move (`ci_pr_failures`). */
  ci_pr_only_jobs?: string[];
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
  /** Max immediate Slack DMs per local day (0–50; default 5, the rest wait for the digest). */
  max_notifications_per_day?: number;
}

export interface TriageAssignmentSummary {
  id: number;
  maintainer: string;
  role: "primary" | "backup";
  status: AssignmentStatus;
}

/** The other side of an issue + fix PR link (triage/groups.py). */
export interface TriageLinkedItem {
  itemKey: string;
  number: number;
  kind: "issue" | "pr";
  title: string;
  /** open / closed / merged. */
  state: string;
  htmlUrl: string;
  score: number | null;
  band: string | null;
  /** Open/acked primary owner, if any. */
  owner: string | null;
}

/** Why a PR appeared in the Close / dedup view (only populated on that view). */
export interface TriageCleanupInfo {
  lowEffort: boolean;
  slopSignals: string[];
  /** Other open non-draft PRs fixing the same issue(s). */
  competesWith: { issueNumber: number; prs: { itemKey: string; number: number; htmlUrl: string }[] }[];
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
  /** Open PRs: whose move it is (`prepass.waiting_on`); null for issues or when unknown. */
  waitingOn?: "author" | "reviewer" | null;
  /** Current stored GitHub review decision and conservative merge-readiness snapshot. */
  reviewDecision?: string | null;
  mergeReady?: boolean;
  mergeCheckedAt?: string | null;
  /** PRs: the issues it fixes. */
  fixes: TriageLinkedItem[];
  /** Issues: the PRs that fix it. */
  fixedBy: TriageLinkedItem[];
  /** Open PRs: CI of the head commit (triage_pr_ci); null/absent when not tracked. */
  ci?: TriageCi | null;
  /** Close / dedup reasons (only populated when the cleanup view is active). */
  cleanup?: TriageCleanupInfo | null;
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
  /** Set when the actor took it back with Undo; it no longer counts anywhere. */
  undoneAt?: string | null;
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
  /** PRs: the issues it fixes. */
  fixes: TriageLinkedItem[];
  /** Issues: the PRs that fix it. */
  fixedBy: TriageLinkedItem[];
  /** PRs: CI of the head commit (triage_pr_ci); null when not tracked. */
  ci: TriageCi | null;
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
  /** `relevanceMatches`: Claude's high/medium judgements for active maintainers (orders "Reassign…"). */
  open: (TriageQueueItem & {
    assignment: TriageAssignment;
    relevanceMatches?: { maintainer: string; relevance: "high" | "medium" }[];
  })[];
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
  /** Worker runs in the last 24h that recorded warnings or errors (`triage_runs`). */
  workerWarnings24h?: number;
  /** Most recent non-fatal worker warning message, if any. */
  latestWorkerWarning?: string | null;
}
