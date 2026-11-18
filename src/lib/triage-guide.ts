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
  /** Routing waits this long for Claude's judgements, then goes ahead (pipeline.RELEVANCE_GRACE). */
  relevanceGraceHours: 2,
  /** Not mine / ack / done from this many days feed back into relevance (relevance.FEEDBACK_WINDOW). */
  feedbackDays: 60,
  /** Local hour the daily digest goes out when `digest_hour` is unset (pipeline.DEFAULT_DIGEST_HOUR). */
  defaultDigestHour: 9,
  /** Un-acked items this many days old show under "Still waiting" in the digest (notify.WAITING_AFTER_DAYS). */
  waitingAfterDays: 3,
  /** Languages a maintainer file accepts (maintainers.py). */
  languages: ["en", "vi"],
  /** notify_mode values (maintainers.py). */
  notifyModes: ["immediate", "digest", "off"],
} as const;

export const MAINTAINERS_DIR_URL =
  "https://github.com/vllm-project/vllm-dashboard/tree/main/triage/config/maintainers";
