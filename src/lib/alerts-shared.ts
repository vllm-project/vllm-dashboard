/**
 * Presentation logic shared by the Fast CI and Full CI views of the alerts tab.
 *
 * Both views answer the same two questions about an alert that Postgres can
 * answer alone: how far its Slack notification got, and where the commit or
 * pull request it refers to lives on GitHub.
 */

export type NotificationStatus =
  | "pending"
  | "retrying"
  | "delivered"
  | "dead_letter";

export type NotificationState = NotificationStatus | "unnotified";

/**
 * One rendered Slack batch covers up to eight events, and a consolidated
 * recovery summary can add a second delivery for the same event, so an event
 * can carry several outbox statuses. Delivery is the question a responder is
 * asking, so any delivered attempt wins; otherwise the worst outstanding
 * attempt is reported.
 */
const UNDELIVERED_SEVERITY: NotificationStatus[] = [
  "dead_letter",
  "retrying",
  "pending",
];

export function notificationStateFor(
  statuses: readonly NotificationStatus[],
): NotificationState {
  if (statuses.length === 0) return "unnotified";
  if (statuses.includes("delivered")) return "delivered";
  return (
    UNDELIVERED_SEVERITY.find((status) => statuses.includes(status)) ?? "pending"
  );
}

export const NOTIFICATION_STATE_LABELS: Record<NotificationState, string> = {
  pending: "Slack pending",
  retrying: "Slack retrying",
  delivered: "Slack delivered",
  dead_letter: "Slack dead-lettered",
  unnotified: "No Slack notification",
};

/** Alert timestamps are read at a glance, so the year is left implicit. */
export function formatAlertDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * How long ago a timestamp was, for the scan columns of an alert list where the
 * question is "is this still happening?" rather than "when exactly?". Anything
 * older than a month falls back to the absolute form.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const seconds = Math.round((now.getTime() - time) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatAlertDateTime(iso);
}

/**
 * The alerts views keep a bounded history (seven days for Fast CI), and the
 * reader narrows it further to what an incident window actually spans.
 */
export type AlertTimeWindow = "1h" | "3h" | "1d" | "7d";

export const ALERT_TIME_WINDOWS: readonly {
  value: AlertTimeWindow;
  label: string;
}[] = [
  { value: "1h", label: "Past 1h" },
  { value: "3h", label: "Past 3h" },
  { value: "1d", label: "Past 1d" },
  { value: "7d", label: "Past 7d" },
];

const ALERT_WINDOW_MS: Record<AlertTimeWindow, number> = {
  "1h": 60 * 60 * 1000,
  "3h": 3 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export function isAlertTimeWindow(
  value: string | null,
): value is AlertTimeWindow {
  return value !== null && value in ALERT_WINDOW_MS;
}

export function alertWindowCutoff(
  window: AlertTimeWindow,
  now: Date = new Date(),
): Date {
  return new Date(now.getTime() - ALERT_WINDOW_MS[window]);
}

/** A timestamp that cannot be parsed is excluded rather than guessed at. */
export function withinAlertWindow(iso: string, cutoff: Date): boolean {
  const time = new Date(iso).getTime();
  return !Number.isNaN(time) && time >= cutoff.getTime();
}

const VLLM_REPO_URL = "https://github.com/vllm-project/vllm";

export function commitUrl(commitSha: string): string {
  return `${VLLM_REPO_URL}/commit/${commitSha}`;
}

export function pullRequestUrl(prNumber: string | null): string | null {
  return prNumber ? `${VLLM_REPO_URL}/pull/${prNumber}` : null;
}
