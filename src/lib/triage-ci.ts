/**
 * A PR's CI, as the triage worker stores it (table triage_pr_ci, written by
 * triage/ci.py): the Buildkite build for the head commit, job counts, and the
 * failed jobs with whether each is also failing on main.
 *
 * `ciWaitsOnAuthor` mirrors `ci_waits_on_author` in triage/ci.py, behind the
 * same switch (`CI_PR_ONLY_FAILURES_WAIT_ON_AUTHOR`); keep the two in step.
 */

export type CiState = "passed" | "failed" | "running" | "canceled" | "not_started";

export interface CiFailedJob {
  name: string;
  key: string;
  url: string;
  /** Jobs of this step that failed (shards fold into one entry). */
  count: number;
  /** The same job is failing on main right now; null when main's state is unknown. */
  on_main: boolean | null;
  /** Not failing on main now, but failed there in the last MAIN_RECENT_DAYS (flaky). */
  recent_on_main: boolean;
  /** Lost its agent / no exit code: infrastructure, not the PR. */
  infra: boolean;
}

export interface TriageCi {
  head_sha: string;
  state: CiState;
  build_number: number | null;
  build_url: string | null;
  build_state: string | null;
  jobs_total: number;
  jobs_passed: number;
  jobs_running: number;
  jobs_failed: number;
  jobs_failed_on_main: number;
  jobs_failed_recent_on_main: number;
  /** Failures main doesn't share (now or recently) and not a lost agent. */
  jobs_failed_pr_only: number;
  main_known: boolean;
  failed_jobs: CiFailedJob[];
  /** When the worker last asked GitHub/Buildkite, ISO. */
  checked_at: string | null;
}

/** `CI_PR_ONLY_FAILURES_WAIT_ON_AUTHOR` in triage/ci.py. */
export const CI_PR_ONLY_FAILURES_WAIT_ON_AUTHOR = true;
/** `MAIN_RECENT_DAYS` in triage/ci.py: a failure on main this recent still counts as main's. */
export const MAIN_RECENT_DAYS = 7;
/** Failed jobs listed in the drawer (the worker keeps up to 50). */
export const CI_JOBS_SHOWN = 8;

/** `ci_waits_on_author` in triage/ci.py: a finished build failed on a job main doesn't fail. */
export function ciWaitsOnAuthor(ci: Pick<TriageCi, "state" | "main_known" | "jobs_failed_pr_only"> | null | undefined): boolean {
  return Boolean(
    CI_PR_ONLY_FAILURES_WAIT_ON_AUTHOR && ci && ci.state === "failed" && ci.main_known && ci.jobs_failed_pr_only > 0,
  );
}

/** A Buildkite link only when it points into the vllm org; null otherwise (rows are untrusted). */
export function safeBuildkiteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      parsed.hostname === "buildkite.com" &&
      parsed.pathname.startsWith("/vllm/") &&
      !parsed.username &&
      !parsed.password
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

/** Buildkite emoji codes (":nvidia: (H200) X") read as noise on the dashboard. */
export function jobLabel(name: string): string {
  return name.replace(/:[a-z0-9_+-]+:/gi, "").replace(/\s+/g, " ").trim() || name;
}

/**
 * Where the failures stand against main: "also failing on main", "2 also
 * failing on main, 1 flaky on main", "only on this PR"; "" when main's state
 * is unknown. Mirrors `ci_fragment` in triage/notify.py.
 */
export function mainText(ci: TriageCi): string {
  if (!ci.main_known || ci.jobs_failed === 0) return "";
  if (ci.jobs_failed_on_main >= ci.jobs_failed) return "also failing on main";
  const notes: string[] = [];
  if (ci.jobs_failed_on_main) notes.push(`${ci.jobs_failed_on_main} also failing on main`);
  if (ci.jobs_failed_recent_on_main) notes.push(`${ci.jobs_failed_recent_on_main} flaky on main`);
  return notes.length ? notes.join(", ") : "only on this PR";
}

/** "38/41 passed · 2 running · 1 failed (also failing on main)". */
export function ciLine(ci: TriageCi): string {
  if (ci.state === "not_started") return "Not started: nobody has run /ci run on this commit yet";
  if (ci.state === "canceled") return `Build canceled · ${ci.jobs_passed}/${ci.jobs_total} passed`;
  const parts = [`${ci.jobs_passed}/${ci.jobs_total} passed`];
  if (ci.jobs_running) parts.push(`${ci.jobs_running} running`);
  if (ci.jobs_failed) {
    const main = mainText(ci);
    parts.push(`${ci.jobs_failed} failed${main ? ` (${main})` : ""}`);
  }
  return parts.join(" · ");
}

export type CiTone = "pass" | "fail" | "main" | "running" | "idle";

/**
 * The compact row badge: label, tone and a tooltip. Failures main shares get
 * their own tone, so a red PR that only inherited main's breakage doesn't
 * look like the author's problem.
 */
export function ciBadge(ci: TriageCi): { label: string; tone: CiTone; title: string } {
  const title = `CI: ${ciLine(ci)}`;
  switch (ci.state) {
    case "passed":
      return { label: "CI ✓", tone: "pass", title };
    case "failed": {
      // Every failure is main's (failing there now or this week): not this PR's doing.
      const mainOnly = ci.main_known && ci.jobs_failed > 0 && ci.jobs_failed_pr_only === 0;
      return { label: `CI ${ci.jobs_failed} ✗${mainOnly ? " (main)" : ""}`, tone: mainOnly ? "main" : "fail", title };
    }
    case "running":
      return {
        label: ci.jobs_failed ? `CI ${ci.jobs_failed} ✗ · running` : `CI ${ci.jobs_passed}/${ci.jobs_total}`,
        tone: ci.jobs_failed ? "fail" : "running",
        title,
      };
    case "canceled":
      return { label: "CI canceled", tone: "idle", title };
    default:
      return { label: "CI not run", tone: "idle", title };
  }
}

/** Rows read straight from Postgres: numbers may come back as strings, JSON as unknown. */
export function toTriageCi(row: Record<string, unknown> | null | undefined): TriageCi | null {
  if (!row || typeof row.state !== "string" || typeof row.head_sha !== "string") return null;
  const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v) || 0);
  const jobs = Array.isArray(row.failed_jobs) ? row.failed_jobs : [];
  const checked = row.checked_at;
  return {
    head_sha: row.head_sha,
    state: row.state as CiState,
    build_number: row.build_number === null || row.build_number === undefined ? null : Number(row.build_number),
    build_url: typeof row.build_url === "string" ? row.build_url : null,
    build_state: typeof row.build_state === "string" ? row.build_state : null,
    jobs_total: n(row.jobs_total),
    jobs_passed: n(row.jobs_passed),
    jobs_running: n(row.jobs_running),
    jobs_failed: n(row.jobs_failed),
    jobs_failed_on_main: n(row.jobs_failed_on_main),
    jobs_failed_recent_on_main: n(row.jobs_failed_recent_on_main),
    jobs_failed_pr_only: n(row.jobs_failed_pr_only),
    main_known: row.main_known === true,
    failed_jobs: jobs.flatMap((j) => {
      const job = j as Record<string, unknown>;
      return typeof job?.name === "string"
        ? [{
            name: job.name,
            key: String(job.key ?? ""),
            url: typeof job.url === "string" ? job.url : "",
            count: n(job.count) || 1,
            on_main: typeof job.on_main === "boolean" ? job.on_main : null,
            recent_on_main: job.recent_on_main === true,
            infra: job.infra === true,
          }]
        : [];
    }),
    checked_at:
      checked instanceof Date ? checked.toISOString() : typeof checked === "string" ? new Date(checked).toISOString() : null,
  };
}
