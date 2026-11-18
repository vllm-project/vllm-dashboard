"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ItemDrawer } from "@/components/triage/item-drawer";
import { OwnerPicker } from "@/components/triage/owner-picker";
import {
  EmptyState,
  ItemListHeader,
  ItemRow,
  PriorityGroupHeader,
  RowSkeleton,
} from "@/components/triage/item-row";
import { useTriageLogin } from "@/components/triage/use-triage-session";
import { useLocationHash } from "@/lib/use-location-hash";
import { itemFromLocation, percent, triageFetcher } from "@/lib/triage-format";
import { OWNER_NONE, parseQueueFilters, queueFiltersToParams, type QueueFilters } from "@/lib/triage-query";
import {
  BAND_ORDER,
  BAND_STYLES,
  formatSearchInput,
  groupByPriority,
  parseSearchInput,
  type BandKey,
} from "@/lib/triage-style";
import type { TriageQueueResponse, TriageStats } from "@/lib/triage-types";
import { DEFAULT_QUEUE_BANDS, TRIAGE_AREAS, TRIAGE_HARDWARE } from "@/lib/triage-vocab";

const CONTROL =
  "h-8 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-700 shadow-sm shadow-black/[0.02] hover:border-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600";
const PANEL = "rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950";
const PANEL_LABEL = "text-[11px] font-medium text-zinc-500 dark:text-zinc-400";
/** Grouped by priority, a page should usually hold all of P0 and P1. */
const GROUPED_PAGE_SIZE = 100;

/**
 * Open items by priority as one tall segmented bar. Each part is labelled
 * inside ("P0 35") when it fits; every part is a filter shortcut and has a
 * tooltip, and the toolbar below repeats the counts as text.
 */
function PriorityMix({
  counts,
  onPick,
}: {
  counts: TriageStats["bandCounts"];
  onPick: (band: BandKey) => void;
}) {
  const total = BAND_ORDER.reduce((sum, band) => sum + counts[band], 0);
  return (
    <div className={`${PANEL} min-w-0 sm:col-span-2`}>
      <div className="flex items-baseline justify-between">
        <p className={PANEL_LABEL}>Open items by priority</p>
        <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{total.toLocaleString()} open</p>
      </div>
      {total > 0 ? (
        <div className="mt-2 flex h-7 w-full gap-0.5" role="group" aria-label="Open items by priority">
          {BAND_ORDER.filter((band) => counts[band] > 0).map((band) => {
            const share = counts[band] / total;
            const style = BAND_STYLES[band];
            return (
              <button
                key={band}
                type="button"
                title={`${style.label}: ${counts[band]} (${percent(counts[band], total)}) · ${style.meaning}. Click to filter.`}
                aria-label={`${style.label}: ${counts[band]}. Filter to ${style.label}.`}
                onClick={() => onPick(band)}
                className={`dashboard-control flex h-full items-center justify-center overflow-hidden rounded text-[11px] font-semibold tabular-nums transition-opacity hover:opacity-85 ${style.fill} ${style.onFill}`}
                style={{ flexGrow: counts[band], flexBasis: 0, minWidth: 6 }}
              >
                {share >= 0.09 && (
                  <span className="hidden whitespace-nowrap px-1 sm:inline">
                    {style.label} {counts[band]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mt-2 flex h-7 items-center justify-center rounded bg-zinc-100 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          Nothing open
        </div>
      )}
    </div>
  );
}

/** Shown when someone dropped/slopped an unusual number of items in 24h. */
function SuppressionWarning({ stats }: { stats: TriageStats | undefined }) {
  const actors = stats?.suppression?.actors ?? [];
  if (actors.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200"
    >
      <p className="font-semibold">Unusual number of items hidden in the last 24 hours</p>
      <p className="mt-1">
        {actors.map((a, i) => (
          <span key={a.actor}>
            {i > 0 ? "; " : ""}
            <span className="font-medium">{a.actor}</span>: {a.drops} dropped, {a.slops} marked slop
          </span>
        ))}
        . Dropped and slop items are never routed again. If this wasn&apos;t expected, check the item history and reopen what
        was hidden. Threshold: {stats?.suppression.threshold} per person per day.
      </p>
    </div>
  );
}

function StatStrip({
  stats,
  onPickBand,
  onPickUnowned,
}: {
  stats: TriageStats | undefined;
  onPickBand: (band: BandKey) => void;
  onPickUnowned: () => void;
}) {
  const coverage =
    stats && stats.inScopeLast7d > 0 ? Math.round((stats.extractedLast7d / stats.inScopeLast7d) * 100) : null;
  const unowned = stats?.unowned ?? 0;
  const hasP0Unowned = (stats?.unownedPage ?? 0) > 0;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {stats ? (
        <PriorityMix counts={stats.bandCounts} onPick={onPickBand} />
      ) : (
        <div className={`${PANEL} col-span-2`}>
          <p className={PANEL_LABEL}>Open items by priority</p>
          <div className="mt-2 h-7 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
        </div>
      )}
      <button
        type="button"
        onClick={onPickUnowned}
        disabled={!stats || unowned === 0}
        title="P0/P1 items with no owner. Click to filter."
        // One background/border set at a time: Tailwind resolves conflicting
        // utilities by stylesheet order, not class order.
        className={`dashboard-control rounded-lg border px-3 py-2.5 text-left enabled:hover:ring-2 ${
          unowned > 0
            ? hasP0Unowned
              ? "border-red-300 bg-red-50 ring-red-300 dark:border-red-500/40 dark:bg-red-500/10 dark:ring-red-500/40"
              : "border-amber-300 bg-amber-50 ring-amber-300 dark:border-amber-500/40 dark:bg-amber-500/10 dark:ring-amber-500/40"
            : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
        }`}
      >
        <p className={PANEL_LABEL}>P0/P1 with no owner</p>
        <p
          className={`text-xl font-semibold leading-7 tabular-nums ${
            unowned > 0
              ? hasP0Unowned
                ? "text-red-700 dark:text-red-300"
                : "text-amber-800 dark:text-amber-300"
              : "text-zinc-900 dark:text-zinc-100"
          }`}
        >
          {stats ? unowned : "—"}
        </p>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          {stats ? `${stats.unownedPage} are P0 · ${stats.pageUnacked} P0 not acked` : "\u00a0"}
        </p>
      </button>
      <div className={PANEL}>
        <div className="flex items-baseline justify-between">
          <p className={PANEL_LABEL}>Read by the LLM · 7d</p>
          <p className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {coverage === null ? "—" : `${coverage}%`}
          </p>
        </div>
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
          role="progressbar"
          aria-label="Extraction coverage"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={coverage ?? 0}
        >
          <div className="h-full rounded-full bg-zinc-500 dark:bg-zinc-400" style={{ width: `${coverage ?? 0}%` }} />
        </div>
        <p className="mt-1.5 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
          {stats ? `${stats.extractedLast7d} of ${stats.inScopeLast7d} items` : "\u00a0"}
        </p>
      </div>
      <div className={PANEL}>
        <p className={PANEL_LABEL}>New today</p>
        <p className="text-xl font-semibold leading-7 tabular-nums text-zinc-900 dark:text-zinc-100">
          {stats?.newToday ?? "—"}
        </p>
        <p className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
          {stats ? `"Not mine" ${percent(stats.notMineLast7d, stats.assignedLast7d)} of assignments · 7d` : "\u00a0"}
        </p>
      </div>
    </div>
  );
}

/** Segmented P0…P3 toggle with counts: quiet when off, tinted when on. */
function PriorityToggle({
  selected,
  counts,
  onToggle,
}: {
  selected: readonly string[];
  counts: TriageStats["bandCounts"] | undefined;
  onToggle: (band: BandKey) => void;
}) {
  const bands: BandKey[] = ["page", "route", "watch", "ignore", ...(counts && counts.unscored > 0 ? (["unscored"] as const) : [])];
  return (
    <div
      role="group"
      aria-label="Priorities"
      className="inline-flex h-8 shrink-0 items-stretch overflow-hidden rounded-md border border-zinc-200 bg-white shadow-sm shadow-black/[0.02] dark:border-zinc-700 dark:bg-zinc-900"
    >
      {bands.map((band, index) => {
        const style = BAND_STYLES[band];
        const on = selected.includes(band);
        return (
          <button
            key={band}
            type="button"
            aria-pressed={on}
            title={style.meaning}
            onClick={() => onToggle(band)}
            className={`dashboard-control inline-flex items-center gap-1.5 px-2.5 text-xs font-medium ring-inset ${
              index > 0 ? "border-l border-zinc-200 dark:border-zinc-700" : ""
            } ${on ? `${style.tint} ring-1` : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"}`}
          >
            <span aria-hidden="true" className={`h-2 w-2 rounded-full ${style.fill} ${on ? "" : "opacity-60"}`} />
            <span className="font-semibold">{style.label}</span>
            {counts && <span className="tabular-nums opacity-70">{counts[band]}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`${CONTROL} min-w-0 flex-1 basis-[calc(50%-0.25rem)] pr-6 sm:w-36 sm:flex-none sm:basis-auto`}
    >
      {children}
    </select>
  );
}

function isDefaultFilters(filters: QueueFilters): boolean {
  return (
    filters.bands.length === DEFAULT_QUEUE_BANDS.length &&
    DEFAULT_QUEUE_BANDS.every((band) => filters.bands.includes(band)) &&
    !filters.kind &&
    !filters.area &&
    !filters.hardware &&
    !filters.model &&
    !filters.owner &&
    filters.status === "any" &&
    !filters.q &&
    filters.state === "open"
  );
}

export default function QueueContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const viewer = useTriageLogin();
  const filters = parseQueueFilters(new URLSearchParams(searchParams.toString()));
  const hash = useLocationHash();
  const openItem = itemFromLocation(searchParams.get("item"), hash);
  const grouped = filters.sort === "score";
  const pageSize = grouped && !searchParams.get("pageSize") ? GROUPED_PAGE_SIZE : filters.pageSize;
  const apiParams = queueFiltersToParams({ ...filters, pageSize }).toString();

  const { data, error, isLoading, mutate } = useSWR<TriageQueueResponse>(
    `/api/triage/items${apiParams ? `?${apiParams}` : ""}`,
    triageFetcher,
    { keepPreviousData: true },
  );
  const { data: stats, mutate: mutateStats } = useSWR<TriageStats>("/api/triage/stats", triageFetcher);
  const [search, setSearch] = useState(formatSearchInput(filters.q, filters.model));
  const [showP3, setShowP3] = useState(false);

  const update = useCallback(
    (patch: Partial<QueueFilters>, extra: Record<string, string | null> = {}) => {
      const next = queueFiltersToParams({ ...filters, page: 1, ...patch });
      const item = "item" in extra ? extra.item : openItem;
      if (item) next.set("item", item);
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [filters, openItem, pathname, router],
  );

  // Search applies as you type (debounced) and immediately on Enter.
  const applySearch = useCallback(
    (text: string) => {
      const parsed = parseSearchInput(text);
      if (parsed.q !== filters.q || parsed.model !== filters.model) update(parsed);
    },
    [filters.q, filters.model, update],
  );
  const searchTimer = useRef<number | null>(null);
  useEffect(() => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => applySearch(search), 350);
    return () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    };
  }, [search, applySearch]);

  function toggleBand(band: BandKey) {
    const bands = filters.bands.includes(band)
      ? filters.bands.filter((value) => value !== band)
      : [...filters.bands, band];
    if (band === "ignore" && !filters.bands.includes("ignore")) setShowP3(true);
    update({ bands: bands.length > 0 ? bands : filters.bands });
  }

  function clearFilters() {
    setSearch("");
    router.replace(openItem ? `${pathname}?item=${encodeURIComponent(openItem)}` : pathname, { scroll: false });
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const groups = data && grouped ? groupByPriority(data.items, (item) => item.band) : [];
  const openRow = (itemKey: string) => update({ page: filters.page }, { item: itemKey });
  const lastOnPage = data && data.page < totalPages ? data.items[data.items.length - 1]?.band : undefined;

  return (
    <div className="space-y-4">
      <SuppressionWarning stats={stats} />
      <StatStrip
        stats={stats}
        onPickBand={(band) => {
          if (band === "ignore") setShowP3(true);
          update({ bands: [band], status: "any" });
        }}
        onPickUnowned={() => update({ bands: ["page", "route"], owner: OWNER_NONE, status: "any" })}
      />

      {/* overflow-clip, not overflow-hidden: hidden would make this box the sticky container and stop the group headers sticking. */}
      <div className="overflow-clip rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-zinc-50/60 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="scrollbar-hidden -mx-1 max-w-full overflow-x-auto px-1">
            <PriorityToggle selected={filters.bands} counts={stats?.bandCounts} onToggle={toggleBand} />
          </div>
          <Select label="Kind" value={filters.kind ?? ""} onChange={(value) => update({ kind: (value || null) as QueueFilters["kind"] })}>
            <option value="">Issues + PRs</option>
            <option value="issue">Issues</option>
            <option value="pr">PRs</option>
          </Select>
          <Select label="Area" value={filters.area ?? ""} onChange={(value) => update({ area: value || null })}>
            <option value="">Any area</option>
            {TRIAGE_AREAS.map((area) => <option key={area} value={area}>{area}</option>)}
          </Select>
          <Select label="Hardware" value={filters.hardware ?? ""} onChange={(value) => update({ hardware: value || null })}>
            <option value="">Any hardware</option>
            {TRIAGE_HARDWARE.map((hw) => <option key={hw} value={hw}>{hw}</option>)}
          </Select>
          <OwnerPicker
            value={filters.owner}
            onChange={(owner) => update({ owner })}
            className="min-w-0 flex-1 basis-[calc(50%-0.25rem)] sm:w-40 sm:flex-none sm:basis-auto"
          />
          <Select label="Status" value={filters.status} onChange={(value) => update({ status: value as QueueFilters["status"] })}>
            <option value="any">Any status</option>
            <option value="unassigned">Nobody on it</option>
            <option value="open">Owner hasn&apos;t acked</option>
            <option value="acked">Owner acked</option>
            <option value="closed">Owner closed it</option>
          </Select>
          <Select label="Sort" value={filters.sort} onChange={(value) => update({ sort: value as QueueFilters["sort"] })}>
            <option value="score">By priority</option>
            <option value="age">Newest first</option>
            <option value="updated">Recently updated</option>
          </Select>
          <button
            type="button"
            aria-pressed={filters.state === "all"}
            onClick={() => update({ state: filters.state === "all" ? "open" : "all" })}
            className={`${CONTROL} inline-flex items-center gap-1.5 ${
              filters.state === "all" ? "border-zinc-400 bg-zinc-100 text-zinc-900 dark:border-zinc-500 dark:bg-zinc-800 dark:text-zinc-50" : ""
            }`}
          >
            <span
              aria-hidden="true"
              className={`relative inline-flex h-3.5 w-6 rounded-full transition-colors ${filters.state === "all" ? "bg-zinc-700 dark:bg-zinc-300" : "bg-zinc-300 dark:bg-zinc-600"}`}
            >
              <span
                className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all dark:bg-zinc-900 ${filters.state === "all" ? "left-3" : "left-0.5"}`}
              />
            </span>
            Closed
          </button>
          <form
            role="search"
            className="relative min-w-[10rem] flex-[1_1_10rem]"
            onSubmit={(event) => {
              event.preventDefault();
              applySearch(search);
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              aria-label="Search title, summary, number; model:name filters by model"
              placeholder="Search · #123 · model:x"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={`${CONTROL} w-full pl-7`}
            />
          </form>
          <Link
            href="/triage/scoring"
            className="dashboard-control inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-zinc-600 underline-offset-2 hover:text-zinc-950 hover:underline dark:text-zinc-300 dark:hover:text-zinc-50"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="6.25" />
              <path d="M6.4 6.2a1.7 1.7 0 113.1 1c-.6.5-1.5.8-1.5 1.8M8 11.2v.1" strokeLinecap="round" />
            </svg>
            How is this scored?
          </Link>
          {!isDefaultFilters(filters) && (
            <button
              type="button"
              onClick={clearFilters}
              className="dashboard-control h-8 rounded-md px-2 text-xs font-medium text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Reset
            </button>
          )}
        </div>

        {error && (
          <p className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            {error.message}
          </p>
        )}

        <ItemListHeader />
        {!data && isLoading && <RowSkeleton />}
        {data && data.items.length === 0 && (
          <EmptyState
            title={isDefaultFilters(filters) ? "Nothing needs triage right now" : "No items match these filters"}
            detail={isDefaultFilters(filters) ? "New issues and PRs show up here a few minutes after they are opened." : undefined}
            action={
              !isDefaultFilters(filters) && (
                <button type="button" onClick={clearFilters} className={`${CONTROL} mt-1 font-medium`}>
                  Reset filters
                </button>
              )
            }
          />
        )}
        {data && data.items.length > 0 && grouped &&
          groups.map((group) => {
            const collapsed = group.band === "ignore" && !showP3;
            return (
              <section key={group.band} aria-label={`${BAND_STYLES[group.band].label} items`}>
                <PriorityGroupHeader
                  band={group.band}
                  count={group.items.length}
                  collapsed={group.band === "ignore" ? collapsed : undefined}
                  onToggle={group.band === "ignore" ? () => setShowP3((value) => !value) : undefined}
                  note={group.band === lastOnPage ? "continues on the next page" : undefined}
                />
                {!collapsed && (
                  <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
                    {group.items.map((item) => (
                      <ItemRow key={item.itemKey} item={item} onOpen={() => openRow(item.itemKey)} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        {data && data.items.length > 0 && !grouped && (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {data.items.map((item) => (
              <ItemRow key={item.itemKey} item={item} onOpen={() => openRow(item.itemKey)} />
            ))}
          </ul>
        )}

        {data && data.total > data.pageSize && (
          <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <span className="tabular-nums">
              {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total}
            </span>
            <div className="flex items-center gap-2">
              <button type="button" className={CONTROL} disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 })}>
                Previous
              </button>
              <button type="button" className={CONTROL} disabled={filters.page >= totalPages} onClick={() => update({ page: filters.page + 1 })}>
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {openItem && (
        <ItemDrawer
          itemKey={openItem}
          viewer={viewer}
          onClose={() => update({ page: filters.page }, { item: null })}
          onChanged={() => {
            void mutate();
            void mutateStats();
          }}
        />
      )}
    </div>
  );
}
