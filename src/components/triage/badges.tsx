import { safeGithubUrl } from "@/lib/triage-query";
import { RELEVANCE_MEANING } from "@/lib/triage-words";
import {
  FLAG_STYLE_QUIET,
  avatarUrl,
  bandStyle,
  chipStyle,
  contextChips,
  flagStyle,
  severityFlags,
  typeLabel,
  typeStyle,
  type ChipKind,
} from "@/lib/triage-style";
import { linkLabel } from "@/lib/triage-groups";
import type { TriageFacets, TriageLinkedItem } from "@/lib/triage-types";

/** The priority pill: P0/P1 solid, P2 soft, P3 and Unscored neutral. */
export function PriorityBadge({ band, size = "sm" }: { band: string | null; size?: "sm" | "md" }) {
  const style = bandStyle(band);
  return (
    <span
      title={style.meaning}
      className={`inline-flex shrink-0 items-center justify-center rounded font-bold tabular-nums tracking-tight ${style.badge} ${
        size === "md" ? "h-6 min-w-9 px-1.5 text-sm" : "h-5 min-w-7 px-1 text-[11px]"
      }`}
    >
      {style.label}
    </span>
  );
}

/** P-badge plus the raw score in neutral ink (the badge carries the color). */
export function PriorityScore({ band, score }: { band: string | null; score: number | null }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={`${bandStyle(band).meaning} · score ${score ?? "—"}`}>
      <PriorityBadge band={band} />
      <span className="text-sm font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">{score ?? "—"}</span>
    </span>
  );
}

/** Kept for lists that show one line per item (rules preview). */
export function BandBadge({ band, score }: { band: string | null; score: number | null }) {
  return <PriorityScore band={band} score={score} />;
}

/**
 * Severity flags, worst first. Only the worst keeps its color (solid for
 * "serving broken" and "security"); the rest are neutral outlines, so a row
 * with five problems doesn't turn into a rainbow.
 */
export function SeverityFlags({
  facets,
  max = 3,
  colorAll = false,
}: {
  facets: Pick<TriageFacets, "severity" | "type"> | null;
  max?: number;
  /** The drawer's summary shows every flag in color. */
  colorAll?: boolean;
}) {
  const flags = severityFlags(facets);
  if (flags.length === 0) return null;
  const shown = flags.slice(0, max);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((flag, index) => (
        <span
          key={flag.key}
          className={`rounded px-1.5 py-px text-[11px] font-semibold leading-4 ${
            index === 0 || colorAll ? flagStyle(flag) : FLAG_STYLE_QUIET
          }`}
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

/**
 * The compact context under a title: up to three chips (hardware tinted by
 * vendor, model and area neutral) and "+N" with the rest in a tooltip.
 */
export function ContextLine({
  item,
  max = 3,
}: {
  item: { hardware: string[]; models: string[]; areas: string[] };
  max?: number;
}) {
  const { shown, hidden } = contextChips(item, max);
  if (shown.length === 0) return null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((chip) => (
        <span
          key={`${chip.kind}:${chip.value}`}
          title={chip.kind}
          className={
            chip.kind === "hardware"
              ? chipStyle("hardware", chip.value)
              : chip.kind === "model"
                ? "rounded px-1.5 py-px text-[11px] font-medium leading-4 text-zinc-700 ring-1 ring-inset ring-zinc-300 dark:text-zinc-300 dark:ring-zinc-700"
                : "px-0.5 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400"
          }
        >
          {chip.value}
        </span>
      ))}
      {hidden.length > 0 && (
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500" title={hidden.map((chip) => chip.value).join(", ")}>
          +{hidden.length}
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
/** GitHub's colours for an item's state: open green, draft grey, merged
 * purple, closed PR red, closed issue purple. Unknown state reads as open. */
export function kindIconStyle(
  kind: "issue" | "pr",
  state?: string,
  draft?: boolean,
): { label: string; tone: string } {
  const GREEN = "text-green-600 dark:text-green-400";
  const PURPLE = "text-purple-600 dark:text-purple-400";
  const RED = "text-red-600 dark:text-red-400";
  const GREY = "text-zinc-400 dark:text-zinc-500";
  if (kind === "issue") {
    return state === "closed" ? { label: "Closed issue", tone: PURPLE } : { label: "Open issue", tone: GREEN };
  }
  if (state === "merged") return { label: "Merged pull request", tone: PURPLE };
  if (state === "closed") return { label: "Closed pull request", tone: RED };
  if (draft) return { label: "Draft pull request", tone: GREY };
  return { label: "Open pull request", tone: GREEN };
}

export function KindIcon({ kind, draft, state }: { kind: "issue" | "pr"; draft?: boolean; state?: string }) {
  const { label, tone } = kindIconStyle(kind, state, draft);
  return (
    <span title={label} className="inline-flex shrink-0 items-center">
      <span className="sr-only">{label}</span>
      {kind === "issue" ? (
        <svg aria-hidden="true" viewBox="0 0 16 16" className={`h-3.5 w-3.5 ${tone}`}>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="1.75" fill="currentColor" />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className={`h-3.5 w-3.5 ${tone}`}
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
export function KindBadge({ kind, draft, state }: { kind: "issue" | "pr"; draft?: boolean; state?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      <KindIcon kind={kind} draft={draft} state={state} />
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
      style={{ width: size, height: size }}
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
      {role === "backup" && (
        <span className="rounded bg-zinc-100 px-1 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          backup
        </span>
      )}
      <span className={`text-[10px] font-medium ${STATUS_STYLES[status] ?? "text-zinc-500 dark:text-zinc-400"}`}>
        {status}
      </span>
    </span>
  );
}

const RELEVANCE_STYLES: Record<string, string> = {
  high: "bg-emerald-600 text-white dark:bg-emerald-600",
  medium: "bg-sky-100 text-sky-900 ring-1 ring-inset ring-sky-600/30 dark:bg-sky-500/15 dark:text-sky-200",
  low: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  none: "bg-zinc-50 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-500",
};

/** Claude's relevance level for one maintainer. */
export function RelevanceBadge({ level }: { level: string }) {
  return (
    <span title={RELEVANCE_MEANING[level] ?? level} className={`inline-flex rounded px-1.5 py-px text-[11px] font-semibold leading-4 ${RELEVANCE_STYLES[level] ?? RELEVANCE_STYLES.none}`}>
      {level}
    </span>
  );
}

/** P0/P1 item with nobody on it. */
export function UnroutedBadge() {
  return (
    <span
      title="P0/P1 with no owner"
      className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-semibold leading-4 text-amber-800 ring-1 ring-inset ring-amber-500/50 dark:text-amber-300 dark:ring-amber-400/40"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-500" /> no owner
    </span>
  );
}

/**
 * Owners as overlapping avatars, primary first, with the primary's login and
 * a check when acked. Full detail (backup, status, why) is in the drawer.
 */
export function OwnerStack({
  assignments,
}: {
  assignments: { id: number; maintainer: string; role: string; status: string }[];
}) {
  if (assignments.length === 0) return null;
  const ordered = [...assignments].sort((a, b) => (a.role === b.role ? 0 : a.role === "primary" ? -1 : 1));
  const primary = ordered[0];
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5"
      title={ordered.map((a) => `${a.maintainer} (${a.role}, ${a.status})`).join(", ")}
    >
      <span className="flex shrink-0 -space-x-1.5">
        {ordered.slice(0, 3).map((a) => (
          <span key={a.id} className="rounded-full ring-2 ring-white dark:ring-zinc-950">
            <Avatar login={a.maintainer} />
          </span>
        ))}
      </span>
      <span className="truncate text-xs text-zinc-700 dark:text-zinc-300">{primary.maintainer}</span>
      {primary.status === "acked" && (
        <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400" aria-label="acknowledged">
          ✓
        </span>
      )}
      {ordered.length > 1 && <span className="text-[11px] text-zinc-400">+{ordered.length - 1}</span>}
    </span>
  );
}

/**
 * "Fixes #65385" on a PR, "Fixed by #67812 (merged)" on an issue: the other
 * members of its issue + fix PR group (triage/groups.py), as GitHub links.
 * `shown` are keys already visible next to it (its nested rows), left out.
 */
export function GroupLinks({
  item,
  shown = [],
}: {
  item: { kind: "issue" | "pr"; fixes: TriageLinkedItem[]; fixedBy: TriageLinkedItem[] };
  shown?: readonly string[];
}) {
  const links = (item.kind === "pr" ? item.fixes : item.fixedBy).filter((link) => !shown.includes(link.itemKey));
  if (links.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 text-[11px] text-zinc-500 dark:text-zinc-400" onClick={(event) => event.stopPropagation()}>
      <span>{item.kind === "pr" ? "Fixes" : "Fixed by"}</span>
      {links.map((link, index) => (
        <span key={link.itemKey}>
          <GithubLink href={link.htmlUrl} title={link.title} className="!text-zinc-600 dark:!text-zinc-300">
            {linkLabel(link)}
          </GithubLink>
          {index < links.length - 1 ? "," : ""}
        </span>
      ))}
    </span>
  );
}
