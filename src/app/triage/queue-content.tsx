"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ItemDrawer } from "@/components/triage/item-drawer";
import { ListShortcuts } from "@/components/triage/list-shortcuts";
import { UndoToastProvider } from "@/components/triage/undo-toast";
import { OwnerPicker } from "@/components/triage/owner-picker";
import {
  EmptyState,
  GroupedRows,
  ItemListHeader,
  KindLegend,
  PriorityGroupHeader,
  RowSkeleton,
} from "@/components/triage/item-row";
import { groupBand, nestGroups, rowOrder } from "@/lib/triage-groups";
import { listPosition, stepItem } from "@/lib/triage-keys";
import { QUEUE_PRESETS, activeFilterCount, activePreset, parseQueueLocation, presetFilters, type QueuePresetId } from "@/lib/triage-presets";
import { useTriageLogin } from "@/components/triage/use-triage-session";
import { useLocationHash } from "@/lib/use-location-hash";
import { itemFromLocation, percent, triageFetcher } from "@/lib/triage-format";
import { OWNER_NONE, queueFiltersToParams, type QueueFilters } from "@/lib/triage-query";
import {
  BAND_ORDER,
  BAND_STYLES,
  formatSearchInput,
  groupByPriority,
  parseSearchInput,
  type BandKey,
} from "@/lib/triage-style";
import { pipelineHealth, type HealthTone } from "@/lib/triage-health";
import type { TriageQueueResponse, TriageStats } from "@/lib/triage-types";
import { TRIAGE_AREAS, TRIAGE_HARDWARE } from "@/lib/triage-vocab";

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

const HEALTH_CHIP: Record<HealthTone, string> = {
  ok: "text-zinc-600 dark:text-zinc-300",
  warn: "bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/40",
  bad: "bg-red-50 text-red-800 ring-1 ring-inset ring-red-300 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/40",
};
const HEALTH_DOT: Record<HealthTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-600 dark:bg-red-500",
};
const HEALTH_WORD: Record<HealthTone, string> = { ok: "healthy", warn: "slow", bad: "stalled" };

/**
 * One compact line: is labelling and relevance judging keeping up? Both run
 * on the extractor host and fail silently, so this turns amber/red when they
 * fall behind (thresholds in triage-health.ts). Hover a part for details.
 */
/** Now, re-read every minute so "4m ago" and the health thresholds move between refreshes. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function PipelineHealthStrip({ stats }: { stats: TriageStats | undefined }) {
  const now = useMinuteClock();
  // Nothing until there's something to show: no placeholder bar that may never fill.
  if (!stats?.health) return null;
  const view = pipelineHealth(stats.health, now);
  return (
    <div
      role={view.tone === "ok" ? "status" : "alert"}
      aria-label={`Pipeline ${HEALTH_WORD[view.tone]}`}
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]"
    >
      <span
        className="inline-flex items-center gap-1.5 font-medium text-zinc-500 dark:text-zinc-400"
        title="Labelling and relevance judging run every 10 minutes on the extractor host."
      >
        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${HEALTH_DOT[view.tone]}`} />
        Pipeline {HEALTH_WORD[view.tone]}
      </span>
      {view.signals.map((signal) => (
        <span key={signal.key} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-600">·</span>
          <span title={signal.detail} className={`rounded px-1.5 py-0.5 tabular-nums ${HEALTH_CHIP[signal.tone]}`}>
            {signal.tone !== "ok" && <span className="sr-only">{signal.tone === "bad" ? "Problem: " : "Warning: "}</span>}
            {signal.text}
          </span>
        </span>
      ))}
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

function FieldSelect({
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
    <label className="flex flex-col gap-1">
      <span className={PANEL_LABEL}>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className={`${CONTROL} w-full pr-6`}>
        {children}
      </select>
    </label>
  );
}

function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`${CONTROL} inline-flex items-center gap-1.5 ${
        on ? "border-zinc-400 bg-zinc-100 text-zinc-900 dark:border-zinc-500 dark:bg-zinc-800 dark:text-zinc-50" : ""
      }`}
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-3.5 w-6 rounded-full transition-colors ${on ? "bg-zinc-700 dark:bg-zinc-300" : "bg-zinc-300 dark:bg-zinc-600"}`}
      >
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all dark:bg-zinc-900 ${on ? "left-3" : "left-0.5"}`} />
      </span>
      {label}
    </button>
  );
}

/** The landing view ("Needs triage", no search): what Reset goes back to. */
function isDefaultFilters(filters: QueueFilters): boolean {
  return activePreset(filters) === "needs-triage" && !filters.q;
}

/**
 * One slim line over the queue: pipeline health, open items per priority
 * (each a filter shortcut), unowned P0/P1, new today. When labelling or
 * judging falls behind, the full health strip opens under it by itself;
 * the operator panels sit behind "System stats". Rendered only once stats
 * have loaded and only when there's something to say: never a grey
 * placeholder that might not fill (e.g. when /api/triage/stats fails).
 */
function StatusLine({
  stats,
  statsOpen,
  onToggleStats,
  onPickBand,
  onPickUnowned,
}: {
  stats: TriageStats | undefined;
  statsOpen: boolean;
  onToggleStats: () => void;
  onPickBand: (band: BandKey) => void;
  onPickUnowned: () => void;
}) {
  const now = useMinuteClock();
  if (!stats) return null;
  const view = stats.health ? pipelineHealth(stats.health, now) : null;
  const unowned = stats.unowned ?? 0;
  const hasP0Unowned = (stats.unownedPage ?? 0) > 0;
  const bands = BAND_ORDER.filter((band) => (stats.bandCounts?.[band] ?? 0) > 0);
  if (!view && bands.length === 0 && unowned === 0 && !stats.newToday) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
      {view && (
        <>
          <span
            className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-medium ${HEALTH_CHIP[view.tone]}`}
            title="Labelling and relevance judging run every 10 minutes on the extractor host."
          >
            <span aria-hidden="true" className={`h-2 w-2 rounded-full ${HEALTH_DOT[view.tone]}`} />
            Pipeline {HEALTH_WORD[view.tone]}
          </span>
          <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-600">·</span>
        </>
      )}
      <span className="inline-flex flex-wrap items-center gap-x-1.5" role="group" aria-label="Open items by priority">
        {bands.map((band) => (
          <button
            key={band}
            type="button"
            onClick={() => onPickBand(band)}
            title={`${BAND_STYLES[band].meaning}. Click to show only ${BAND_STYLES[band].label}.`}
            className="dashboard-control rounded px-0.5 tabular-nums hover:text-zinc-950 hover:underline dark:hover:text-zinc-50"
          >
            <span className="font-semibold">{BAND_STYLES[band].label}</span> {stats.bandCounts[band].toLocaleString()}
          </button>
        ))}
      </span>
      <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-600">·</span>
      <button
        type="button"
        onClick={onPickUnowned}
        disabled={unowned === 0}
        title={`P0/P1 items with no owner: ${stats.unownedPage} are P0, ${stats.pageUnacked} P0 not acked. Click to filter.`}
        className={`dashboard-control rounded px-1.5 py-0.5 tabular-nums enabled:hover:underline ${
          unowned > 0
            ? hasP0Unowned
              ? "bg-red-50 font-semibold text-red-800 ring-1 ring-inset ring-red-300 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/40"
              : "bg-amber-50 font-semibold text-amber-900 ring-1 ring-inset ring-amber-300 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/40"
            : ""
        }`}
      >
        {unowned} P0/P1 unowned
      </button>
      <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-600">·</span>
      <span className="tabular-nums">{stats.newToday} new today</span>
      <button
        type="button"
        onClick={onToggleStats}
        aria-expanded={statsOpen}
        aria-controls="triage-system-stats"
        className="dashboard-control ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        System stats
        <svg aria-hidden="true" viewBox="0 0 16 16" className={`h-3 w-3 transition-transform ${statsOpen ? "rotate-180" : ""}`} fill="currentColor">
          <path d="M4 6l4 4 4-4z" />
        </svg>
      </button>
    </div>
  );
}

/** Whether the pipeline needs attention, for opening its full strip automatically. */
function pipelineNeedsAttention(stats: TriageStats | undefined, now: number): boolean {
  return !!stats?.health && pipelineHealth(stats.health, now).tone !== "ok";
}

/** One-click views (triage-presets.ts); the active one is pressed. */
function PresetBar({ active, onPick }: { active: QueuePresetId | null; onPick: (id: QueuePresetId) => void }) {
  return (
    <div
      role="group"
      aria-label="Views"
      className="inline-flex h-8 shrink-0 items-stretch overflow-hidden rounded-md border border-zinc-200 bg-white shadow-sm shadow-black/[0.02] dark:border-zinc-700 dark:bg-zinc-900"
    >
      {QUEUE_PRESETS.map((preset, index) => {
        const on = active === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={on}
            title={preset.title}
            onClick={() => onPick(preset.id)}
            className={`dashboard-control whitespace-nowrap px-2.5 text-xs font-medium ${
              index > 0 ? "border-l border-zinc-200 dark:border-zinc-700" : ""
            } ${
              on
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
            }`}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}

/** Every other filter, in a popover: priority, kind, area, hardware, owner, status, closed, sort. */
function FiltersPopover({
  filters,
  counts,
  onChange,
  onToggleBand,
  onReset,
}: {
  filters: QueueFilters;
  counts: TriageStats["bandCounts"] | undefined;
  onChange: (patch: Partial<QueueFilters>) => void;
  onToggleBand: (band: BandKey) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const count = activeFilterCount(filters);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button, select")?.focus();
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "triage-filters" : undefined}
        onClick={() => setOpen((value) => !value)}
        className={`${CONTROL} inline-flex items-center gap-1.5 font-medium ${count > 0 ? "border-zinc-400 text-zinc-900 dark:border-zinc-500 dark:text-zinc-50" : ""}`}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
        </svg>
        Filters
        {count > 0 && (
          <span className="rounded-full bg-zinc-900 px-1.5 text-[10px] font-semibold leading-4 text-white dark:bg-zinc-100 dark:text-zinc-900">
            {count}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panel}
          id="triage-filters"
          role="dialog"
          aria-label="Filters"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
          }}
          className="absolute right-0 z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] space-y-3 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg shadow-black/10 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/40"
        >
          <div className="space-y-1">
            <p className={PANEL_LABEL}>Priority</p>
            <div className="scrollbar-hidden -mx-1 max-w-full overflow-x-auto px-1">
              <PriorityToggle selected={filters.bands} counts={counts} onToggle={onToggleBand} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <FieldSelect label="Type" value={filters.kind ?? ""} onChange={(value) => onChange({ kind: (value || null) as QueueFilters["kind"] })}>
              <option value="">Issues + PRs</option>
              <option value="issue">Issues</option>
              <option value="pr">PRs</option>
            </FieldSelect>
            <FieldSelect label="Status" value={filters.status} onChange={(value) => onChange({ status: value as QueueFilters["status"] })}>
              <option value="any">Any status</option>
              <option value="unassigned">Nobody on it</option>
              <option value="open">Owner hasn&apos;t acked</option>
              <option value="acked">Owner acked</option>
              <option value="closed">Owner closed it</option>
            </FieldSelect>
            <FieldSelect label="Area" value={filters.area ?? ""} onChange={(value) => onChange({ area: value || null })}>
              <option value="">Any area</option>
              {TRIAGE_AREAS.map((area) => <option key={area} value={area}>{area}</option>)}
            </FieldSelect>
            <FieldSelect label="Hardware" value={filters.hardware ?? ""} onChange={(value) => onChange({ hardware: value || null })}>
              <option value="">Any hardware</option>
              {TRIAGE_HARDWARE.map((hw) => <option key={hw} value={hw}>{hw}</option>)}
            </FieldSelect>
            <div className="flex flex-col gap-1">
              <span className={PANEL_LABEL}>Owner</span>
              <OwnerPicker value={filters.owner} onChange={(owner) => onChange({ owner })} className="w-full" />
            </div>
            <FieldSelect label="Sort" value={filters.sort} onChange={(value) => onChange({ sort: value as QueueFilters["sort"] })}>
              <option value="score">By priority</option>
              <option value="age">Newest first</option>
              <option value="updated">Recently updated</option>
            </FieldSelect>
          </div>
          <div className="flex flex-wrap gap-2">
            <Toggle on={filters.state === "all"} label="Closed too" onClick={() => onChange({ state: filters.state === "all" ? "open" : "all" })} />
            <Toggle on={filters.review === "ready"} label="Ready to review only" onClick={() => onChange({ review: filters.review ? null : "ready" })} />
          </div>
          <div className="flex items-center justify-between border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <button
              type="button"
              onClick={onReset}
              className="dashboard-control rounded text-xs font-medium text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Reset all
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
              className={`${CONTROL} font-medium`}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const STATS_OPEN_KEY = "triage.queue.systemStats";

export default function QueueContent() {
  return (
    <UndoToastProvider>
      <Queue />
    </UndoToastProvider>
  );
}

function Queue() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const viewer = useTriageLogin();
  const filters = parseQueueLocation(new URLSearchParams(searchParams.toString()));
  const hash = useLocationHash();
  const openItem = itemFromLocation(searchParams.get("item"), hash);
  const grouped = filters.sort === "score";
  const pageSize = grouped && !searchParams.get("pageSize") ? GROUPED_PAGE_SIZE : filters.pageSize;
  const apiParams = queueFiltersToParams({ ...filters, pageSize }).toString();
  const now = useMinuteClock();

  const { data, error, isLoading, mutate } = useSWR<TriageQueueResponse>(
    `/api/triage/items${apiParams ? `?${apiParams}` : ""}`,
    triageFetcher,
    { keepPreviousData: true },
  );
  const { data: stats, mutate: mutateStats } = useSWR<TriageStats>("/api/triage/stats", triageFetcher, {
    refreshInterval: 120_000,
  });
  const [search, setSearch] = useState(formatSearchInput(filters.q, filters.model));
  const [showP3, setShowP3] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount; storage isn't available during SSR
      setStatsOpen(window.localStorage.getItem(STATS_OPEN_KEY) === "1");
    } catch {
      // storage blocked: stay collapsed
    }
  }, []);
  function toggleStats() {
    const next = !statsOpen;
    setStatsOpen(next);
    try {
      window.localStorage.setItem(STATS_OPEN_KEY, next ? "1" : "0");
    } catch {
      // ignore
    }
  }

  const replaceFilters = useCallback(
    (next: QueueFilters, item: string | null) => {
      const params = queueFiltersToParams(next);
      if (item) params.set("item", item);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const update = useCallback(
    (patch: Partial<QueueFilters>, extra: Record<string, string | null> = {}) => {
      const item = "item" in extra ? extra.item : openItem;
      replaceFilters({ ...filters, page: 1, ...patch }, item ?? null);
    },
    [filters, openItem, replaceFilters],
  );

  // Search applies as you type (debounced) and immediately on Enter.
  const applySearch = useCallback(
    (text: string) => {
      const { owner, ...parsed } = parseSearchInput(text);
      const ownerChanged = owner !== undefined && owner !== filters.owner;
      if (parsed.q !== filters.q || parsed.model !== filters.model || ownerChanged) {
        update(ownerChanged ? { ...parsed, owner } : parsed);
      }
    },
    [filters.q, filters.model, filters.owner, update],
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

  function pickPreset(id: QueuePresetId) {
    const next = presetFilters(id, filters);
    if (next.bands.includes("ignore")) setShowP3(true);
    replaceFilters(next, openItem);
  }

  function clearFilters() {
    setSearch("");
    router.replace(openItem ? `${pathname}?item=${encodeURIComponent(openItem)}` : pathname, { scroll: false });
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // Fix PRs sit under their issue; a group is filed under its most urgent member.
  const rows = data ? nestGroups(data.items) : [];
  const groups = data && grouped ? groupByPriority(rows, groupBand) : [];
  const openRow = (itemKey: string) => update({ page: filters.page }, { item: itemKey });
  const lastOnPage = data && data.page < totalPages ? data.items[data.items.length - 1]?.band : undefined;
  // j / k walk the rows as drawn (a collapsed P3 group is skipped).
  const order = grouped
    ? groups.filter((group) => group.band !== "ignore" || showP3).flatMap((group) => rowOrder(group.items))
    : rowOrder(rows);
  const prevKey = openItem ? stepItem(order, openItem, -1) : null;
  const nextKey = openItem ? stepItem(order, openItem, 1) : null;
  const preset = activePreset(filters);
  const needsAttention = pipelineNeedsAttention(stats, now);

  return (
    <div className="space-y-3">
      <StatusLine
        stats={stats}
        statsOpen={statsOpen}
        onToggleStats={toggleStats}
        onPickBand={(band) => {
          if (band === "ignore") setShowP3(true);
          update({ bands: [band], status: "any" });
        }}
        onPickUnowned={() => update({ bands: ["page", "route"], owner: OWNER_NONE, status: "any" })}
      />
      {(needsAttention || statsOpen) && <PipelineHealthStrip stats={stats} />}
      <SuppressionWarning stats={stats} />
      {statsOpen && stats && (
        <div id="triage-system-stats">
          <StatStrip
            stats={stats}
            onPickBand={(band) => {
              if (band === "ignore") setShowP3(true);
              update({ bands: [band], status: "any" });
            }}
            onPickUnowned={() => update({ bands: ["page", "route"], owner: OWNER_NONE, status: "any" })}
          />
        </div>
      )}

      {/* overflow-clip, not overflow-hidden: hidden would make this box the sticky container and stop the group headers sticking. */}
      <div className="overflow-clip rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-zinc-50/60 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="scrollbar-hidden -mx-1 max-w-full overflow-x-auto px-1">
            <PresetBar active={preset} onPick={pickPreset} />
          </div>
          <form
            role="search"
            className="relative min-w-[10rem] flex-[1_1_12rem]"
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
              aria-label="Search title, summary, number; model:name filters by model; owner:login or owner:none filters by owner"
              placeholder="Search · #123 · model:x · owner:x"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={`${CONTROL} w-full pl-7`}
            />
          </form>
          <FiltersPopover filters={filters} counts={stats?.bandCounts} onChange={update} onToggleBand={toggleBand} onReset={clearFilters} />
          <Link
            href="/triage/scoring"
            title="How is this scored?"
            aria-label="How is this scored?"
            className="dashboard-control inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-zinc-600 underline-offset-2 hover:text-zinc-950 hover:underline dark:text-zinc-300 dark:hover:text-zinc-50"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="6.25" />
              <path d="M6.4 6.2a1.7 1.7 0 113.1 1c-.6.5-1.5.8-1.5 1.8M8 11.2v.1" strokeLinecap="round" />
            </svg>
            <span className="hidden lg:inline">How is this scored?</span>
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

        <KindLegend />
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
                  count={group.items.reduce((n, row) => n + 1 + row.members.length, 0)}
                  collapsed={group.band === "ignore" ? collapsed : undefined}
                  onToggle={group.band === "ignore" ? () => setShowP3((value) => !value) : undefined}
                  note={group.band === lastOnPage ? "continues on the next page" : undefined}
                />
                {!collapsed && (
                  <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
                    <GroupedRows rows={group.items} rowKey={(item) => item.itemKey} activeKey={openItem} onOpen={(item) => openRow(item.itemKey)} onOpenKey={openRow} />
                  </ul>
                )}
              </section>
            );
          })}
        {data && data.items.length > 0 && !grouped && (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            <GroupedRows rows={rows} rowKey={(item) => item.itemKey} activeKey={openItem} onOpen={(item) => openRow(item.itemKey)} onOpenKey={openRow} />
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

      <ListShortcuts enabled={!openItem} onOpenFirst={order[0] ? () => openRow(order[0]) : null} />
      {openItem && (
        <ItemDrawer
          itemKey={openItem}
          viewer={viewer}
          onClose={() => update({ page: filters.page }, { item: null })}
          onChanged={() => {
            void mutate();
            void mutateStats();
          }}
          nav={{
            position: listPosition(order, openItem),
            onPrev: prevKey ? () => openRow(prevKey) : null,
            onNext: nextKey ? () => openRow(nextKey) : null,
          }}
        />
      )}
    </div>
  );
}
