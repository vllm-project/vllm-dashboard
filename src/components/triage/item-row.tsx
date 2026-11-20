"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import {
  GithubLink,
  KindIcon,
  OwnerStack,
  PriorityBadge,
  UnroutedBadge,
} from "@/components/triage/badges";
import type { CiTone } from "@/lib/triage-ci";
import { formatAge } from "@/lib/triage-format";
import { linkLabel, type NestedRow } from "@/lib/triage-groups";
import {
  SCORE_TOOLTIP,
  contextText,
  impactBadge,
  kindLabel,
  linkText,
  listRows,
  rowCiChip,
  scoreParts,
} from "@/lib/triage-rows";
import { bandStyle, flagStyle, isUnrouted, type BandKey } from "@/lib/triage-style";
import type { TriageQueueItem } from "@/lib/triage-types";

/**
 * Column template shared by the header and every row (md and up):
 * priority · score, item, owner, age. Every row, fix PRs included, keeps its
 * own stripe and priority cell in the same place; only the item column of a
 * fix PR indents. Below md a row stacks, with the owner folded under the
 * title.
 */
export const ROW_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 md:grid-cols-[7rem_minmax(0,1fr)_12rem_3rem]";

export function ItemListHeader() {
  return (
    <div
      className={`${ROW_GRID} hidden border-b border-zinc-200 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500 md:grid dark:border-zinc-800 dark:text-zinc-400`}
    >
      <span className="whitespace-nowrap">Priority · Score</span>
      <span>Item</span>
      <span>Owner</span>
      <span className="text-right">Age</span>
    </div>
  );
}

function Owner({ item }: { item: TriageQueueItem }) {
  if (item.assignments.length > 0) return <OwnerStack assignments={item.assignments} />;
  if (isUnrouted(item.band, 0)) return <UnroutedBadge />;
  // P2/P3 are never routed, so an empty owner is expected: show nothing.
  return null;
}

/** "P0" pill and "79 pts" under it; the score links to how it's computed. */
function PriorityCell({ band, score }: { band: string | null; score: number | null }) {
  const { value, unit } = scoreParts(score);
  return (
    <div className="flex flex-col items-start gap-0.5 pt-0.5">
      <PriorityBadge band={band} />
      <Link
        href="/triage/scoring"
        title={SCORE_TOOLTIP}
        aria-label={score === null ? "Not scored yet: how scores are computed" : `Impact score ${value} points: how it's computed`}
        onClick={(event) => event.stopPropagation()}
        className="rounded-sm text-sm font-semibold tabular-nums leading-tight text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300"
      >
        {value}
        {unit && <span className="ml-0.5 text-[11px] font-normal text-zinc-400 dark:text-zinc-500">{unit}</span>}
      </Link>
    </div>
  );
}

const CI_TONE: Record<CiTone, string> = {
  fail: "text-red-700 dark:text-red-400",
  main: "text-amber-700 dark:text-amber-400",
  pass: "text-emerald-700 dark:text-emerald-400",
  running: "text-zinc-500 dark:text-zinc-400",
  idle: "text-zinc-500 dark:text-zinc-400",
};

/** Line 2: one impact badge, CI when actionable, then plain muted context and "Fixes #N". */
function DetailLine({ item, shownLinks }: { item: TriageQueueItem; shownLinks: readonly string[] }) {
  const impact = impactBadge(item);
  const ci = rowCiChip(item.ci);
  const context = contextText(item);
  const links = linkText(item, shownLinks);
  if (!impact && !ci && !context.text && !links) return null;
  const parts: ReactNode[] = [];
  if (context.text) {
    parts.push(
      <span key="context" className="min-w-0 truncate" title={[context.text, ...context.hidden].join(" · ")}>
        {context.text}
        {context.more > 0 && <span className="text-zinc-400 dark:text-zinc-500"> · +{context.more}</span>}
      </span>,
    );
  }
  if (links) {
    parts.push(
      <span key="links" className="shrink-0" onClick={(event) => event.stopPropagation()}>
        {links.verb}{" "}
        {links.links.map((link, index) => (
          <Fragment key={link.itemKey}>
            <GithubLink href={link.htmlUrl} title={link.title} className="!text-zinc-500 hover:!text-zinc-800 dark:!text-zinc-400 dark:hover:!text-zinc-100">
              {linkLabel(link)}
            </GithubLink>
            {index < links.links.length - 1 ? ", " : ""}
          </Fragment>
        ))}
      </span>,
    );
  }
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
      {impact && (
        <span title={impact.title} className={`shrink-0 rounded px-1.5 py-px text-[11px] font-semibold leading-4 ${flagStyle(impact.flag)}`}>
          {impact.label}
        </span>
      )}
      {ci && (
        <span title={ci.title} className={`shrink-0 text-[11px] font-semibold tabular-nums ${CI_TONE[ci.tone]}`}>
          {ci.label}
        </span>
      )}
      {parts.map((part, index) => (
        <Fragment key={index}>
          {(index > 0 || impact || ci) && <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-600">·</span>}
          {part}
        </Fragment>
      ))}
    </div>
  );
}

/** "Issue" / "PR" with the state-coloured icon, or "↳ Fix PR" under its issue. */
function KindTag({ item, nested }: { item: TriageQueueItem; nested: boolean }) {
  const label = kindLabel(item, nested);
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
      {nested && <span aria-hidden="true" className="text-zinc-400 dark:text-zinc-500">↳</span>}
      <KindIcon kind={item.kind} draft={item.draft} state={item.state} />
      <span>{label}</span>
    </span>
  );
}

/**
 * One item. The whole row and its title open the drawer; "#123 ↗" after the
 * title goes to GitHub. `footer` (e.g. My list's action buttons) renders
 * under the detail line. `nested`: a fix PR under its issue, indented in the
 * item column only, joined to it by a thin connector; `connectsDown` carries
 * that line on to the next fix PR. `shownLinks` are group members already on
 * screen, left out of its "Fixes #N" text. `active` marks the row whose
 * drawer is open.
 */
export function ItemRow({
  item,
  onOpen,
  footer,
  hideOwner = false,
  nested = false,
  connectsDown = false,
  shownLinks = [],
  active = false,
}: {
  item: TriageQueueItem;
  onOpen: () => void;
  footer?: ReactNode;
  hideOwner?: boolean;
  nested?: boolean;
  connectsDown?: boolean;
  shownLinks?: readonly string[];
  active?: boolean;
}) {
  const style = bandStyle(item.band);
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    // Keep the open item in view while j/k walk the list behind the drawer.
    if (active) row.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const number = (
    <span className="shrink-0 text-xs tabular-nums" onClick={(event) => event.stopPropagation()}>
      <GithubLink
        href={item.htmlUrl}
        title={`Open #${item.number} on GitHub`}
        className="!text-zinc-400 hover:!text-zinc-700 dark:!text-zinc-500 dark:hover:!text-zinc-200"
      >
        #{item.number}
        <span aria-hidden="true"> ↗</span>
      </GithubLink>
    </span>
  );
  return (
    <li
      ref={row}
      data-row
      data-item-key={item.itemKey}
      data-nested={nested || undefined}
      aria-current={active || undefined}
      aria-label={nested ? `Fix PR #${item.number} for the issue above` : undefined}
      className={`relative cursor-pointer py-2.5 pl-4 pr-4 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/70 ${active ? "bg-zinc-100 dark:bg-zinc-800/70" : ""} ${style.row}`}
      onClick={onOpen}
    >
      {style.stripe && <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${style.stripe}`} />}
      <div className={ROW_GRID}>
        <PriorityCell band={item.band} score={item.score} />
        <div className={`relative min-w-0 ${nested ? "pl-6" : ""}`}>
          {/* Connector in the gutter left of the item column: from the issue down to each of its fix PRs. */}
          {nested && (
            <span aria-hidden="true" className="absolute -left-1.5 -top-2.5 h-5 w-px bg-zinc-300 dark:bg-zinc-700" />
          )}
          {connectsDown && (
            <span
              aria-hidden="true"
              className={`absolute -bottom-2.5 -left-1.5 ${nested ? "top-2.5" : "top-2"} w-px bg-zinc-300 dark:bg-zinc-700`}
            />
          )}
          <div className="flex min-w-0 items-baseline gap-2">
            <KindTag item={item} nested={nested} />
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
              title="Open details"
              className="line-clamp-2 min-w-0 rounded-sm text-left text-sm font-medium leading-snug text-zinc-950 underline-offset-2 hover:underline dark:text-zinc-50"
            >
              {item.title}
            </button>
            {number}
          </div>
          <DetailLine item={item} shownLinks={shownLinks} />
          {!hideOwner && (
            <div className="mt-1 md:hidden">
              <Owner item={item} />
            </div>
          )}
          {footer && (
            <div className="mt-2" onClick={(event) => event.stopPropagation()}>
              {footer}
            </div>
          )}
        </div>
        <div className="hidden min-w-0 pt-0.5 md:block">{!hideOwner && <Owner item={item} />}</div>
        <div className="pt-0.5 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400" title={item.ghCreatedAt}>
          {formatAge(item.ghCreatedAt)}
        </div>
      </div>
    </li>
  );
}

/**
 * Rows with each fix PR under its issue (triage-groups.ts `nestGroups`,
 * shaped by `listRows`): same order as j/k.
 */
export function GroupedRows<T extends TriageQueueItem>({
  rows,
  rowKey,
  onOpen,
  footer,
  hideOwner = false,
  activeKey = null,
}: {
  rows: readonly NestedRow<T>[];
  rowKey: (item: T) => string | number;
  onOpen: (item: T) => void;
  footer?: (item: T) => ReactNode;
  hideOwner?: boolean;
  /** The item key whose drawer is open. */
  activeKey?: string | null;
}) {
  return (
    <>
      {listRows(rows).map((row) => (
        <ItemRow
          key={rowKey(row.item)}
          item={row.item}
          nested={row.nested}
          connectsDown={row.connectsDown}
          onOpen={() => onOpen(row.item)}
          footer={footer?.(row.item)}
          hideOwner={hideOwner}
          shownLinks={row.shownLinks}
          active={row.item.itemKey === activeKey}
        />
      ))}
    </>
  );
}

/** Sticky section header for one priority. Sits under the sticky site nav. */
export function PriorityGroupHeader({
  band,
  count,
  collapsed,
  onToggle,
  note,
}: {
  band: BandKey;
  count: number;
  collapsed?: boolean;
  onToggle?: () => void;
  note?: string;
}) {
  const style = bandStyle(band);
  return (
    <div className="sticky top-[108px] z-10 flex items-center gap-2 border-b border-zinc-200 bg-zinc-50/95 px-4 py-1.5 backdrop-blur lg:top-14 dark:border-zinc-800 dark:bg-zinc-900/95">
      <PriorityBadge band={band} />
      <span className="text-xs font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">{count}</span>
      <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{style.meaning}</span>
      {note && <span className="hidden text-[11px] text-zinc-400 sm:inline dark:text-zinc-500">· {note}</span>}
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="dashboard-control ml-auto shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
        >
          {collapsed ? `Show ${count}` : "Hide"}
        </button>
      )}
    </div>
  );
}

export function RowSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul aria-hidden="true" className="divide-y divide-zinc-100 dark:divide-zinc-900">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className={`${ROW_GRID} animate-pulse px-4 py-3`}>
          <div className="h-5 w-14 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="space-y-2">
            <div className="h-3 w-40 rounded bg-zinc-100 dark:bg-zinc-800/70" />
            <div className="h-4 w-4/5 rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-3 w-56 rounded bg-zinc-100 dark:bg-zinc-800/70" />
          </div>
          <div className="hidden h-5 w-24 rounded-full bg-zinc-100 md:block dark:bg-zinc-800/70" />
          <div className="h-3 w-6 justify-self-end rounded bg-zinc-100 dark:bg-zinc-800/70" />
        </li>
      ))}
    </ul>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-8 w-8 text-zinc-300 dark:text-zinc-700" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5l2.5 2.5L16 9.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{title}</p>
      {detail && <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-400">{detail}</p>}
      {action}
    </div>
  );
}
