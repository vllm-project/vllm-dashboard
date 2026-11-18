/**
 * The few routing facts the "How triage works" page states that are not in
 * scoring.yaml. They live in the Python worker; triage-guide.test.ts reads
 * that source and fails if these drift from it.
 */
export const GUIDE_FACTS = {
  /** Relevance profiles use PRs from this many days (pipeline.PROFILE_WINDOW). */
  profileDays: 180,
  /** A P0 opened within this many days may go past the weekly cap (pipeline.FRESH_WINDOW). */
  freshDays: 3,
  /** Languages a maintainer file accepts (maintainers.py). */
  languages: ["en", "vi"],
  /** notify_mode values (maintainers.py). */
  notifyModes: ["immediate", "digest", "off"],
} as const;

export const MAINTAINERS_DIR_URL =
  "https://github.com/vllm-project/vllm-dashboard/tree/main/triage/config/maintainers";
