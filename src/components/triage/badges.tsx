import { safeGithubUrl } from "@/lib/triage-query";
import {
  avatarUrl,
  bandStyle,
  chipStyle,
  flagStyle,
  scoreFillPercent,
  severityFlags,
  typeLabel,
  typeStyle,
  type ChipKind,
} from "@/lib/triage-style";
import type { TriageFacets } from "@/lib/triage-types";

/** Score as a band-colored number with its band name, for headers and lists. */
export function BandBadge({ band, score }: { band: string | null; score: number | null }) {
  const style = bandStyle(band);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${style.fill}`} />
      <span className={`font-semibold tabular-nums ${style.text}`}>{score ?? "—"}</span>
      <span className="text-zinc-500 dark:text-zinc-400">{style.label}</span>
    </span>
  );
}

/** Score number + a 0–100 fill bar in the band color, with the band name. */
export function ScoreCell({ band, score }: { band: string | null; score: number | null }) {
  const style = bandStyle(band);
  const fill = scoreFillPercent(score);
  return (
    <div className="w-16" title={`Score ${score ?? "—"} · ${style.label}`}>
      <div className="flex items-baseline justify-between gap-1">
        <span className={`text-base font-semibold leading-5 tabular-nums ${style.text}`}>{score ?? "—"}</span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {style.label}
        </span>
      </div>
      <div
        className={`mt-1 h-1 w-full overflow-hidden rounded-full ${style.track}`}
        role="meter"
        aria-label="Impact score"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fill}
      >
        <div className={`h-full rounded-full ${style.fill}`} style={{ width: `${fill}%` }} />
      </div>
    </div>
  );
}

/** Bold severity flags (serving broken, crash, …), worst first. */
export function SeverityFlags({
  facets,
  max = 3,
}: {
  facets: Pick<TriageFacets, "severity" | "type"> | null;
  max?: number;
}) {
  const flags = severityFlags(facets);
  if (flags.length === 0) return null;
  const shown = flags.slice(0, max);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((flag) => (
        <span
          key={flag.key}
          className={`rounded px-1.5 py-px text-[11px] font-bold leading-4 ${flagStyle(flag)}`}
        >
          {flag.label}
        </span>
      ))}
      {flags.length > max && (
        <span
          className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400"
          title={flags.slice(max).map((flag) => flag.label).join(", ")}
        >
          +{flags.length - max}
        </span>
      )}
    </span>
  );
}

/** Shown as a severity flag instead, so the type text would only repeat it. */
const TYPES_SHOWN_AS_FLAGS = new Set(["regression", "perf_regression"]);

export function TypeLabel({ type }: { type: string | null }) {
  if (!type || TYPES_SHOWN_AS_FLAGS.has(type)) return null;
  return <span className={`text-xs font-medium ${typeStyle(type)}`}>{typeLabel(type)}</span>;
}

/** Chips colored by category: hardware by vendor, models teal, areas violet, serving outline. */
export function Chips({
  values,
  kind = "plain",
  max = 4,
}: {
  values: string[];
  kind?: ChipKind;
  max?: number;
}) {
  if (values.length === 0) return <span className="text-zinc-300 dark:text-zinc-600">—</span>;
  const shown = values.slice(0, max);
  const rest = values.slice(max);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((value) => (
        <span key={value} className={chipStyle(kind, value)}>
          {value}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="self-center text-[11px] font-medium text-zinc-500 dark:text-zinc-400" title={rest.join(", ")}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/** A link to GitHub only when it points into vllm-project; plain text otherwise. */
export function GithubLink({
  href,
  children,
  title,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  const safe = safeGithubUrl(href);
  if (!safe) return <span title={title} className={className}>{children}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={title}
      className={`text-zinc-950 underline-offset-2 hover:underline dark:text-zinc-50 ${className}`}
    >
      {children}
    </a>
  );
}

/** Issue vs PR, GitHub-style: green circle-dot for issues, purple branch for PRs. */
export function KindIcon({ kind, draft }: { kind: "issue" | "pr"; draft?: boolean }) {
  const label = kind === "pr" ? (draft ? "Draft pull request" : "Pull request") : "Issue";
  return (
    <span title={label} className="inline-flex shrink-0 items-center">
      <span className="sr-only">{label}</span>
      {kind === "issue" ? (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 text-green-600 dark:text-green-400">
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="1.75" fill="currentColor" />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className={`h-3.5 w-3.5 ${draft ? "text-zinc-400 dark:text-zinc-500" : "text-purple-600 dark:text-purple-400"}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="4" cy="3.5" r="1.75" />
          <circle cx="4" cy="12.5" r="1.75" />
          <circle cx="12" cy="12.5" r="1.75" />
          <path d="M4 5.25v5.5M12 10.75V6.5a2 2 0 0 0-2-2H7.5" />
          <path d="M9 3l-1.5 1.5L9 6" />
        </svg>
      )}
    </span>
  );
}

/** Text badge kept for the drawer header. */
export function KindBadge({ kind, draft }: { kind: "issue" | "pr"; draft?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      <KindIcon kind={kind} draft={draft} />
      {kind === "pr" ? (draft ? "PR·draft" : "PR") : "Issue"}
    </span>
  );
}

export function Avatar({ login, size = 20 }: { login: string; size?: number }) {
  return (
    // Plain <img>: GitHub avatars are tiny, external, and not worth next/image config.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarUrl(login, size * 2)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 rounded-full bg-zinc-200 ring-1 ring-black/5 dark:bg-zinc-700 dark:ring-white/10"
    />
  );
}

const STATUS_STYLES: Record<string, string> = {
  open: "text-amber-700 dark:text-amber-400",
  acked: "text-emerald-700 dark:text-emerald-400",
};

export function Assignee({
  login,
  status,
  role,
}: {
  login: string;
  status: string;
  role?: string;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={`${login} · ${role ?? ""} ${status}`.trim()}>
      <Avatar login={login} />
      <span className="truncate text-xs text-zinc-800 dark:text-zinc-200">{login}</span>
      <span className={`text-[10px] font-medium ${STATUS_STYLES[status] ?? "text-zinc-500 dark:text-zinc-400"}`}>
        {status}
      </span>
    </span>
  );
}

/** Page/route item with nobody on it. */
export function UnroutedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-px text-[11px] font-bold leading-4 text-amber-900 ring-1 ring-inset ring-amber-600/30 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/30">
      <span aria-hidden="true">●</span> unrouted
    </span>
  );
}
