import { useState } from "react";
import {
  isResolvableQuarantine,
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

export type ResolveQuarantine = (
  host: string,
  by: string,
  reason: string,
  force: boolean,
) => Promise<void>;

const INPUT =
  "min-h-9 min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

function ResolveQuarantineForm({
  host,
  onResolve,
  forceOnly,
}: {
  host: string;
  onResolve: ResolveQuarantine;
  /** The resolve already waits for a clean reading; only skipping it is left. */
  forceOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const [force, setForce] = useState(forceOnly);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="dashboard-control h-6 shrink-0 rounded-md border border-zinc-200 px-2 text-[11px] font-medium text-zinc-500 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
      >
        {forceOnly ? "Skip the wait" : "Resolve"}
      </button>
    );
  }
  return (
    <form
      className="flex w-full flex-col gap-2 sm:flex-row sm:items-center"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        try {
          await onResolve(host, by.trim(), reason.trim(), force);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : "Resolve failed.");
          setPending(false);
        }
      }}
    >
      <input
        aria-label="Your name"
        placeholder="Your name"
        value={by}
        onChange={(event) => setBy(event.target.value)}
        maxLength={80}
        required
        className={`${INPUT} sm:max-w-40`}
      />
      <input
        aria-label="What was fixed"
        placeholder="What was fixed"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={500}
        required
        className={INPUT}
      />
      {/* By default the host waits for a fresh reading that no longer shows
          the fault; skip it only when you know better than the reading. */}
      <label className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={force}
          disabled={forceOnly}
          onChange={(event) => setForce(event.target.checked)}
        />
        Skip the clean-reading check
      </label>
      <button
        type="submit"
        disabled={pending}
        className="dashboard-control h-9 shrink-0 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {pending ? "Resolving…" : "Return to service"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="dashboard-control h-9 shrink-0 px-2 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        Cancel
      </button>
      {error && (
        <p role="alert" className="w-full text-xs font-medium text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </form>
  );
}

function EpisodeRow({
  episode,
  onResolveQuarantine,
}: {
  episode: InfraAlertEpisodeView;
  onResolveQuarantine?: ResolveQuarantine;
}) {
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
      {onResolveQuarantine && isResolvableQuarantine(episode) && (
        <ResolveQuarantineForm
          // A resolve that moves the episode on starts the form afresh.
          key={String(episode.details.stage)}
          host={episode.subjectKey}
          onResolve={onResolveQuarantine}
          forceOnly={episode.details.stage === "resolve_requested"}
        />
      )}
    </li>
  );
}

function EpisodeSection({
  title,
  episodes,
  onResolveQuarantine,
}: {
  title: string;
  episodes: InfraAlertEpisodeView[];
  onResolveQuarantine?: ResolveQuarantine;
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
          <EpisodeRow
            key={episode.alertId}
            episode={episode}
            onResolveQuarantine={onResolveQuarantine}
          />
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
 * notifications each, so this view reports them read-only. The one exception
 * is resolving a quarantine, offered only once the operator token is entered:
 * that is the only way a quarantined host returns to service, and it is kept
 * off Slack because the infra channel is public.
 *
 * Episodes are per subject rather than per job run, so the lists stay short
 * enough to render without pagination.
 */
export function InfraAlerts({
  view,
  onResolveQuarantine,
}: {
  view: InfraAlertView;
  onResolveQuarantine?: ResolveQuarantine;
}) {
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
      <EpisodeSection
        title="Open"
        episodes={open}
        onResolveQuarantine={onResolveQuarantine}
      />
      <EpisodeSection title="Recently resolved" episodes={resolved} />
      <RetiredHosts hosts={retiredHosts} />
    </div>
  );
}
