import {
  DEFAULT_QUEUE_BANDS,
  TRIAGE_AREAS,
  TRIAGE_BANDS,
  TRIAGE_HARDWARE,
  isOneOf,
  type TriageBand,
} from "@/lib/triage-vocab";
import { isValidLogin } from "@/lib/triage-auth";

export const QUEUE_STATUSES = ["any", "unassigned", "open", "acked", "closed"] as const;
export const QUEUE_SORTS = ["score", "age", "updated"] as const;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** `owner=none`: items with no open or acked assignment. */
export const OWNER_NONE = "none";

export interface QueueFilters {
  bands: TriageBand[];
  kind: "issue" | "pr" | null;
  area: string | null;
  hardware: string | null;
  model: string | null;
  /**
   * Who owns it now (an open or acked assignment): a GitHub login, or
   * OWNER_NONE for items nobody owns. URL: `owner=<login>` / `owner=none`
   * (`assignee=<login>` is still read, for old links).
   */
  owner: string | null;
  status: (typeof QUEUE_STATUSES)[number];
  /**
   * `review=ready`: open, non-draft PRs whose move is the reviewers'
   * (`prepass.waiting_on = "reviewer"`, so CI isn't failing on the PR's own
   * account, no conflicts, no changes requested; see `whose_move` in
   * triage/prepass.py).
   */
  review: "ready" | null;
  q: string | null;
  state: "open" | "all";
  includeOutOfScope: boolean;
  sort: (typeof QUEUE_SORTS)[number];
  page: number;
  pageSize: number;
}

function text(value: string | null, max = 100): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function positiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, max) : fallback;
}

/** Parses /api/triage/items query params; unknown values fall back to defaults. */
export function parseQueueFilters(params: URLSearchParams): QueueFilters {
  const bandParam = params.get("bands");
  const bands =
    bandParam === null
      ? [...DEFAULT_QUEUE_BANDS]
      : bandParam
          .split(",")
          .map((band) => band.trim())
          .filter((band): band is TriageBand => isOneOf(TRIAGE_BANDS, band));
  const kind = params.get("kind");
  const area = params.get("area");
  const hardware = params.get("hardware");
  const owner = text(params.get("owner") ?? params.get("assignee"), 40);
  const status = params.get("status");
  const sort = params.get("sort");
  return {
    bands: bands.length > 0 ? [...new Set(bands)] : [...DEFAULT_QUEUE_BANDS],
    kind: kind === "issue" || kind === "pr" ? kind : null,
    area: isOneOf(TRIAGE_AREAS, area) ? area : null,
    hardware: isOneOf(TRIAGE_HARDWARE, hardware) ? hardware : null,
    model: text(params.get("model")),
    owner: owner === OWNER_NONE ? OWNER_NONE : owner && isValidLogin(owner) ? owner : null,
    status: isOneOf(QUEUE_STATUSES, status) ? status : "any",
    review: params.get("review") === "ready" ? "ready" : null,
    q: text(params.get("q"), 200),
    state: params.get("state") === "all" ? "all" : "open",
    includeOutOfScope: params.get("scope") === "all",
    sort: isOneOf(QUEUE_SORTS, sort) ? sort : "score",
    page: positiveInt(params.get("page"), 1, 10_000),
    pageSize: positiveInt(params.get("pageSize"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

/** The inverse, for building client URLs; omits defaults. */
export function queueFiltersToParams(filters: Partial<QueueFilters>): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.bands) {
    const isDefault =
      filters.bands.length === DEFAULT_QUEUE_BANDS.length &&
      DEFAULT_QUEUE_BANDS.every((band) => filters.bands!.includes(band));
    if (!isDefault) params.set("bands", filters.bands.join(","));
  }
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.area) params.set("area", filters.area);
  if (filters.hardware) params.set("hardware", filters.hardware);
  if (filters.model) params.set("model", filters.model);
  if (filters.owner) params.set("owner", filters.owner);
  if (filters.status && filters.status !== "any") params.set("status", filters.status);
  if (filters.review === "ready") params.set("review", "ready");
  if (filters.q) params.set("q", filters.q);
  if (filters.state === "all") params.set("state", "all");
  if (filters.includeOutOfScope) params.set("scope", "all");
  if (filters.sort && filters.sort !== "score") params.set("sort", filters.sort);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  if (filters.pageSize && filters.pageSize !== DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(filters.pageSize));
  }
  return params;
}

/** GitHub links shown on triage pages must point into vllm-project. */
export function safeGithubUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.pathname.startsWith("/vllm-project/") &&
      !parsed.username &&
      !parsed.password
    ) {
      return parsed.toString();
    }
  } catch {
    // fall through
  }
  return null;
}
