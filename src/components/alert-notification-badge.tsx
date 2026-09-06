import {
  NOTIFICATION_STATE_LABELS,
  type NotificationState,
} from "@/lib/alerts-shared";

const NOTIFICATION_STATE_CLASSES: Record<NotificationState, string> = {
  delivered:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  pending: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  retrying:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  dead_letter: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  unnotified: "bg-zinc-100 text-muted dark:bg-zinc-800",
};

/** How far one alert's Slack delivery got, for either alert source. */
export function NotificationBadge({
  state,
  className = "",
}: {
  state: NotificationState;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${NOTIFICATION_STATE_CLASSES[state]} ${className}`}
    >
      {NOTIFICATION_STATE_LABELS[state]}
    </span>
  );
}
