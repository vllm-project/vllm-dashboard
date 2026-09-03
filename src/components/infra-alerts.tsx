import {
  type InfraAlertEpisodeView,
  type InfraAlertView,
  type InfraRetiredHost,
} from "@/lib/alerts-infra";
import { formatAlertDateTime } from "@/lib/alerts-shared";

function StatusBadge({ status }: { status: InfraAlertEpisodeView["status"] }) {
  return status === "open" ? (
    <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/60 dark:text-red-300">
      Open
    </span>
  ) : (
    <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      Resolved
    </span>
  );
}

function RetiredBadge() {
  return (
    <span className="shrink-0 rounded-full border border-dashed border-amber-300 px-2 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-800 dark:text-amber-300">
      Retired
    </span>
  );
}

function EpisodeRow({ episode }: { episode: InfraAlertEpisodeView }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-5">
      <span className="min-w-0 truncate font-mono text-zinc-900 dark:text-zinc-100">
        {episode.subjectKey}
      </span>
      <span className="shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        {episode.typeLabel}
      </span>
      <StatusBadge status={episode.status} />
      {episode.retired && <RetiredBadge />}
      <span className="ml-auto shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
        Opened {formatAlertDateTime(episode.openedAt)}
        {episode.resolvedAt !== null &&
          ` · Resolved ${formatAlertDateTime(episode.resolvedAt)}`}
      </span>
      <p className="w-full text-xs text-zinc-500 dark:text-zinc-400">
        {episode.summary}
      </p>
    </li>
  );
}

function EpisodeSection({
  title,
  episodes,
}: {
  title: string;
  episodes: InfraAlertEpisodeView[];
}) {
  if (episodes.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
        {title}{" "}
        <span className="font-normal text-zinc-400 dark:text-zinc-500">
          {episodes.length}
        </span>
      </h2>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800/60 dark:border-zinc-800 dark:bg-zinc-950">
        {episodes.map((episode) => (
          <EpisodeRow key={episode.alertId} episode={episode} />
        ))}
      </ul>
    </section>
  );
}

function RetiredHosts({ hosts }: { hosts: InfraRetiredHost[] }) {
  if (hosts.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
        Retired hosts{" "}
        <span className="font-normal text-zinc-400 dark:text-zinc-500">
          {hosts.length}
        </span>
      </h2>
      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-dashed border-zinc-300 bg-white dark:divide-zinc-800/60 dark:border-zinc-700 dark:bg-zinc-950">
        {hosts.map((host) => (
          <li
            key={host.subjectKey}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-5"
          >
            <span className="min-w-0 truncate font-mono text-zinc-500 dark:text-zinc-400">
              {host.subjectKey}
            </span>
            <RetiredBadge />
            <span className="ml-auto shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
              {host.lastReportedAt !== null &&
                `Last report ${formatAlertDateTime(host.lastReportedAt)} · `}
              Retired {formatAlertDateTime(host.retiredAt)}
            </span>
            <p className="w-full text-xs text-zinc-500 dark:text-zinc-400">
              Stopped reporting and was auto-retired after 7 days absent from
              every expected source; it no longer alerts.
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Infra alert episodes are per-subject breach episodes with exactly two Slack
 * notifications each, so this view reports them read-only: it deliberately
 * exposes no resolution, acknowledgement, or suppression controls.
 *
 * Episodes are per subject rather than per job run, so the lists stay short
 * enough to render without pagination.
 */
export function InfraAlerts({ view }: { view: InfraAlertView }) {
  const { open, resolved, retiredHosts } = view;

  if (open.length === 0 && resolved.length === 0 && retiredHosts.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-zinc-300 text-sm text-zinc-400 dark:border-zinc-700">
        No infra alerts were recorded in this window.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <EpisodeSection title="Open" episodes={open} />
      <EpisodeSection title="Recently resolved" episodes={resolved} />
      <RetiredHosts hosts={retiredHosts} />
    </div>
  );
}
