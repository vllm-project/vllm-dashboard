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
  fixPrStatus,
  kindTag,
  priorityCell,
  type KindTag as KindTagView,
  type PriorityCellView,
  fixTargets,
  linkText,
  listBlocks,
  type FixTarget,
  type ListRow,
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
/** The Priority · Score cell. Empty for a fix PR inside a card (the issue row carries the card's score). */
function PriorityCell({ view }: { view: PriorityCellView }) {
  if (!view.show) {
    return <div className="pt-0.5"><span className="sr-only">Priority is on the issue row above</span></div>;
  }
  const { value, unit } = scoreParts(view.score);
  return (
    <div className="flex flex-col items-start gap-0.5 pt-0.5" title={view.tooltip ?? undefined}>
      <PriorityBadge band={view.band} />
      <Link
        href="/triage/scoring"
        title={view.tooltip ?? SCORE_TOOLTIP}
        aria-label={
          view.score === null
            ? "Not scored yet: how scores are computed"
            : `${view.tooltip ? `${view.tooltip}. ` : ""}Impact score ${value} points: how it's computed`
        }
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

/** Line 2 of a fix PR inside a card: CI when it says something, and whose move it is. */
function FixPrStatusLine({ item }: { item: TriageQueueItem }) {
  const { ci, move } = fixPrStatus(item);
  if (!ci && !move) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] font-semibold">
      {ci && (
        <span title={ci.title} className={`tabular-nums ${CI_TONE[ci.tone]}`}>
          {ci.label}
        </span>
      )}
      {ci && move && <span aria-hidden="true" className="font-normal text-zinc-300 dark:text-zinc-600">·</span>}
      {move && (
        <span className={move.tone === "ready" ? "text-emerald-700 dark:text-emerald-400" : "font-normal text-zinc-500 dark:text-zinc-400"}>
          {move.text}
        </span>
      )}
    </div>
  );
}

const KIND_BOX: Record<KindTagView["style"], string> = {
  // Issue: plain small caps. PR: an outlined, tinted box. Different shape and word, not just colour.
  issue: "text-zinc-600 dark:text-zinc-300",
  pr: "rounded bg-zinc-100 px-1 ring-1 ring-inset ring-zinc-300 text-zinc-700 dark:bg-zinc-800 dark:ring-zinc-600 dark:text-zinc-200",
};

/**
 * The kind tag that starts every title line, same width on every row so it
 * scans as a column: "ISSUE" or an outlined "PR", each with its
 * state-coloured icon. A fix PR in a card adds "· fix for #65364", each
 * number opening that issue's drawer.
 */
function KindTag({
  item,
  fixFor,
  onOpenKey,
}: {
  item: TriageQueueItem;
  fixFor?: readonly FixTarget[];
  onOpenKey?: (itemKey: string) => void;
}) {
  const tag = kindTag(item, fixFor);
  return (
    <>
      <span
        role="img"
        aria-label={tag.label}
        className={`inline-flex w-[4.25rem] shrink-0 items-center gap-1 self-start pt-px`}
      >
        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold uppercase leading-4 tracking-wide ${KIND_BOX[tag.style]}`}>
          <KindIcon kind={item.kind} draft={item.draft} state={item.state} />
          {tag.word}
        </span>
      </span>
      {tag.fixFor && fixFor && (
        <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400" aria-hidden={!onOpenKey || undefined}>
          fix for{" "}
          {fixFor.map((target, index) => (
            <Fragment key={target.itemKey}>
              {onOpenKey ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenKey(target.itemKey);
                  }}
                  title={`Open issue #${target.number}`}
                  className="rounded-sm font-semibold text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-200"
                >
                  #{target.number}
                </button>
              ) : (
                <span className="font-semibold text-zinc-700 dark:text-zinc-200">#{target.number}</span>
              )}
              {index < fixFor.length - 1 ? ", " : ""}
            </Fragment>
          ))}
        </span>
      )}
    </>
  );
}

/** One muted line above a list: how to read the kind tags. */
export function KindLegend() {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 px-4 py-1.5 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="inline-flex items-center gap-1">
        <KindIcon kind="issue" /> Issue
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1">
        <KindIcon kind="pr" /> Pull request
      </span>
      <span aria-hidden="true">·</span>
      <span>↳ fix PR (linked to the issue above)</span>
    </p>
  );
}

/** Where a row sits in a group card: drives the connector, stripe and pill. */
export interface CardPlace {
  /** The card's band: one stripe for the whole card. */
  band: string | null;
  /** The issue at the top (connector starts beside its kind tag). */
  lead: boolean;
  /** The fix PRs' own scores, for the issue row's tooltip when they set the card's band. */
  memberScores: readonly (number | null)[];
  /** The last fix PR (connector ends at its label). */
  last: boolean;
}

const CONNECTOR = "bg-zinc-300 dark:bg-zinc-600";

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
  label,
  hideOwner = false,
  nested = false,
  connectsDown = false,
  shownLinks = [],
  active = false,
  card,
  fixFor,
  onOpenKey,
}: {
  item: TriageQueueItem;
  onOpen: () => void;
  footer?: ReactNode;
  label?: ReactNode;
  hideOwner?: boolean;
  nested?: boolean;
  connectsDown?: boolean;
  shownLinks?: readonly string[];
  active?: boolean;
  /** Set when the row is inside a group card (see `GroupedRows`). */
  card?: CardPlace;
  /** A fix PR's issues, for "Fix PR for #N". */
  fixFor?: readonly FixTarget[];
  /** Opens another item's drawer by key (the "#N" in "Fix PR for #N"). */
  onOpenKey?: (itemKey: string) => void;
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
      className={`relative cursor-pointer py-2.5 transition-colors ${
        // In a card: 1rem minus the card's margin and border, so every cell lines up with standalone rows.
        card ? "px-[9px] hover:bg-zinc-100/70 dark:hover:bg-zinc-800/50" : `px-4 hover:bg-zinc-50 dark:hover:bg-zinc-900/70 ${style.row}`
      } ${active ? "!bg-zinc-100 dark:!bg-zinc-800/70" : ""}`}
      onClick={onOpen}
    >
      {!card && style.stripe && <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${style.stripe}`} />}
      <div className={ROW_GRID}>
        <PriorityCell view={priorityCell(item, card)} />
        <div className="relative min-w-0">
          {/*
            Connector in the gutter left of the item column (never over text or
            badges): a stub into the issue's kind tag, down to each fix PR, and an
            elbow into each fix PR's kind tag.
          */}
          {card?.lead && connectsDown && (
            <>
              <span aria-hidden="true" className={`absolute -left-[7px] top-[0.5rem] h-[1.5px] w-[6px] ${CONNECTOR}`} />
              <span aria-hidden="true" className={`absolute -bottom-2.5 -left-[7px] top-[0.5rem] w-[1.5px] ${CONNECTOR}`} />
            </>
          )}
          {card && nested && (
            <>
              <span
                aria-hidden="true"
                className={`absolute -left-[7px] -top-2.5 w-[1.5px] ${CONNECTOR} ${card.last ? "h-[1.15rem]" : "-bottom-2.5"}`}
              />
              <span aria-hidden="true" className={`absolute -left-[7px] top-[0.5rem] h-[1.5px] w-[6px] ${CONNECTOR}`} />
            </>
          )}
          <div className="flex min-w-0 items-baseline gap-2">
            {nested && <span className="sr-only">↳ fix PR for the issue above.</span>}
            <KindTag item={item} fixFor={nested ? fixFor : undefined} onOpenKey={onOpenKey} />
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
          {label && <div className="mt-1">{label}</div>}
          {/* A fix PR in a card: what's actionable for the PR (its issue row carries impact and context). */}
          {card && nested ? <FixPrStatusLine item={item} /> : <DetailLine item={item} shownLinks={shownLinks} />}
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
 * The list: an issue and its fix PRs as one group card (one stripe in the
 * group's most urgent band, a light tint, no dividers inside, space around
 * it); everything else as plain rows. Row order is `listRows` order, which
 * is also the j/k order. `onOpenKey` opens a drawer by key (the "#N" in a
 * fix PR's "Fix PR for #N").
 */
export function GroupedRows<T extends TriageQueueItem>({
  rows,
  rowKey,
  onOpen,
  onOpenKey,
  footer,
  label,
  hideOwner = false,
  activeKey = null,
}: {
  rows: readonly NestedRow<T>[];
  rowKey: (item: T) => string | number;
  onOpen: (item: T) => void;
  onOpenKey?: (itemKey: string) => void;
  footer?: (item: T) => ReactNode;
  label?: (item: T) => ReactNode;
  hideOwner?: boolean;
  /** The item key whose drawer is open. */
  activeKey?: string | null;
}) {
  const draw = (row: ListRow<T>, card?: CardPlace, fixFor?: FixTarget[]) => (
    <ItemRow
      key={rowKey(row.item)}
      item={row.item}
      nested={row.nested}
      connectsDown={row.connectsDown}
      onOpen={() => onOpen(row.item)}
      onOpenKey={onOpenKey}
      footer={footer?.(row.item)}
      label={label?.(row.item)}
      hideOwner={hideOwner}
      shownLinks={row.shownLinks}
      active={row.item.itemKey === activeKey}
      card={card}
      fixFor={fixFor}
    />
  );
  return (
    <>
      {listBlocks(rows).map((block) => {
        if (block.kind === "single") return draw(block.row);
        const lead = block.rows[0].item;
        const stripe = bandStyle(block.band).stripe;
        return (
          <li
            key={block.key}
            role="group"
            aria-label={block.label}
            data-group={block.key}
            className="relative mx-1.5 my-2 overflow-hidden rounded-lg !border border-zinc-200 bg-zinc-50/60 dark:border-zinc-700/80 dark:bg-zinc-900/40"
          >
            {stripe && <span aria-hidden="true" className={`absolute inset-y-0 left-0 z-[1] w-1 ${stripe}`} />}
            <ul>
              {block.rows.map((row, index) =>
                draw(
                  row,
                  {
                    band: block.band,
                    lead: index === 0,
                    last: index === block.rows.length - 1,
                    memberScores: block.rows.slice(1).map((member) => member.item.score),
                  },
                  row.nested ? fixTargets(row.item, lead.itemKey, lead.number) : undefined,
                ),
              )}
            </ul>
          </li>
        );
      })}
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
