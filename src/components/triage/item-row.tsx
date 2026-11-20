"use client";

import { Fragment, useEffect, useRef, type ReactNode } from "react";
import {
  ContextLine,
  GithubLink,
  GroupLinks,
  KindIcon,
  OwnerStack,
  PriorityBadge,
  PriorityScore,
  SeverityFlags,
  TypeLabel,
  UnroutedBadge,
} from "@/components/triage/badges";
import { CiBadge } from "@/components/triage/ci-status";
import { formatAge } from "@/lib/triage-format";
import { bandStyle, isUnrouted, type BandKey } from "@/lib/triage-style";
import type { NestedRow } from "@/lib/triage-groups";
import type { TriageQueueItem } from "@/lib/triage-types";

/**
 * Column template shared by the header and every row (md and up):
 * priority+score · item · owner · age. Below md a row stacks, with the owner
 * folded under the title.
 */
export const ROW_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 md:grid-cols-[5.5rem_minmax(0,1fr)_12rem_3rem]";

export function ItemListHeader() {
  return (
    <div
      className={`${ROW_GRID} hidden border-b border-zinc-200 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500 md:grid dark:border-zinc-800 dark:text-zinc-400`}
    >
      <span>Priority</span>
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

/**
 * One item. The whole row and its title open the drawer; "#123 ↗" next to
 * the title goes to GitHub. `footer` (e.g. My list's action buttons) renders
 * under the context line. `nested` draws a fix PR indented under its issue's
 * row (see `GroupedRows`); `shownLinks` are group members already visible,
 * so its "Fixes #N" / "Fixed by #N" line leaves them out. `active` marks the
 * row whose drawer is open.
 */
export function ItemRow({
  item,
  onOpen,
  footer,
  hideOwner = false,
  nested = false,
  shownLinks = [],
  active = false,
}: {
  item: TriageQueueItem;
  onOpen: () => void;
  footer?: ReactNode;
  hideOwner?: boolean;
  nested?: boolean;
  shownLinks?: readonly string[];
  active?: boolean;
}) {
  const style = bandStyle(item.band);
  const facets = { severity: item.severity ?? undefined, type: item.type ?? undefined };
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    // Keep the open item in view while j/k walk the list behind the drawer.
    if (active) row.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <li
      ref={row}
      data-row
      data-item-key={item.itemKey}
      data-nested={nested || undefined}
      aria-current={active || undefined}
      className={`relative cursor-pointer py-2.5 pr-4 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/70 ${
        nested ? "border-l-2 border-zinc-200 pl-10 dark:border-zinc-700" : "pl-4"
      } ${active ? "bg-zinc-100 dark:bg-zinc-800/70" : ""} ${style.row}`}
      onClick={onOpen}
    >
      {style.stripe && <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${style.stripe}`} />}
      <div className={ROW_GRID}>
        <div className="pt-0.5">
          <PriorityScore band={item.band} score={item.score} />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {nested && <span className="text-xs text-zinc-400 dark:text-zinc-500" aria-label="fix PR">↳ fix</span>}
            <KindIcon kind={item.kind} draft={item.draft} state={item.state} />
            <TypeLabel type={item.type} />
            <SeverityFlags facets={facets} max={2} />
            <CiBadge ci={item.ci} />
          </div>
          <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
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
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <ContextLine item={item} />
            <GroupLinks item={item} shown={shownLinks} />
            {!hideOwner && (
              <span className="md:hidden">
                <Owner item={item} />
              </span>
            )}
          </div>
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
 * Rows with each fix PR nested under its issue (triage-groups.ts
 * `nestGroups`): the issue's row, then its fix PRs indented beneath.
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
      {rows.map(({ item, members }) => (
        <Fragment key={rowKey(item)}>
          <ItemRow
            item={item}
            onOpen={() => onOpen(item)}
            footer={footer?.(item)}
            hideOwner={hideOwner}
            shownLinks={members.map((member) => member.itemKey)}
            active={item.itemKey === activeKey}
          />
          {members.map((member) => (
            <ItemRow
              key={rowKey(member)}
              item={member}
              nested
              onOpen={() => onOpen(member)}
              footer={footer?.(member)}
              hideOwner={hideOwner}
              shownLinks={[item.itemKey]}
              active={member.itemKey === activeKey}
            />
          ))}
        </Fragment>
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
