"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import {
  Assignee,
  Chips,
  GithubLink,
  KindIcon,
  ScoreCell,
  SeverityFlags,
  TypeLabel,
  UnroutedBadge,
} from "@/components/triage/badges";
import { ItemDrawer } from "@/components/triage/item-drawer";
import { useTriageLogin } from "@/components/triage/use-triage-session";
import { formatAge, percent, triageFetcher } from "@/lib/triage-format";
import {
  QUEUE_SORTS,
  QUEUE_STATUSES,
  parseQueueFilters,
  queueFiltersToParams,
  type QueueFilters,
} from "@/lib/triage-query";
import { BAND_ORDER, BAND_STYLES, bandStyle, isUnrouted, type BandKey } from "@/lib/triage-style";
import type { TriageQueueResponse, TriageStats } from "@/lib/triage-types";
import { TRIAGE_AREAS, TRIAGE_HARDWARE } from "@/lib/triage-vocab";

const SELECT =
  "min-h-8 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
const PANEL_SHAPE = "rounded-lg border px-3 py-2.5";
const PANEL = `${PANEL_SHAPE} border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950`;
const PANEL_LABEL = "text-[11px] font-medium text-zinc-500 dark:text-zinc-400";

/** In-scope open items split by band: one thin segmented bar plus a clickable legend. */
function BandMix({
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
        <p className={PANEL_LABEL}>Open items by band</p>
        <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{total.toLocaleString()} total</p>
      </div>
      {total > 0 ? (
        <div className="mt-2 flex h-2 w-full gap-0.5" role="img" aria-label={BAND_ORDER.map((band) => `${band} ${counts[band]}`).join(", ")}>
          {BAND_ORDER.filter((band) => counts[band] > 0).map((band) => (
            <button
              key={band}
              type="button"
              title={`${BAND_STYLES[band].label}: ${counts[band]} (${percent(counts[band], total)}) — click to filter`}
              onClick={() => onPick(band)}
              className={`h-full rounded-full transition-opacity hover:opacity-80 ${BAND_STYLES[band].fill}`}
              style={{ flexGrow: counts[band], flexBasis: 0, minWidth: 4 }}
            />
          ))}
        </div>
      ) : (
        <div className="mt-2 h-2 w-full rounded-full bg-zinc-100 dark:bg-zinc-800" />
      )}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {BAND_ORDER.map((band) => (
          <button
            key={band}
            type="button"
            onClick={() => onPick(band)}
            className="dashboard-control inline-flex items-center gap-1.5 rounded text-xs text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            <span aria-hidden="true" className={`h-2 w-2 rounded-full ${BAND_STYLES[band].fill}`} />
            {BAND_STYLES[band].label}
            <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{counts[band]}</span>
          </button>
        ))}
      </div>
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
  const hasPageUnowned = (stats?.unownedPage ?? 0) > 0;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {stats ? (
        <BandMix counts={stats.bandCounts} onPick={onPickBand} />
      ) : (
        <div className={`${PANEL} sm:col-span-2`}>
          <p className={PANEL_LABEL}>Open items by band</p>
          <div className="mt-2 h-2 w-full animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-800" />
        </div>
      )}
      <div className={PANEL}>
        <div className="flex items-baseline justify-between">
          <p className={PANEL_LABEL}>Extraction coverage · 7d</p>
          <p className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {coverage === null ? "—" : `${coverage}%`}
          </p>
        </div>
        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-sky-100 dark:bg-sky-500/20"
          role="progressbar"
          aria-label="Extraction coverage"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={coverage ?? 0}
        >
          <div className="h-full rounded-full bg-sky-600 dark:bg-sky-500" style={{ width: `${coverage ?? 0}%` }} />
        </div>
        <p className="mt-1.5 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
          {stats ? `${stats.extractedLast7d} of ${stats.inScopeLast7d} items read` : " "}
        </p>
      </div>
      <button
        type="button"
        onClick={onPickUnowned}
        disabled={!stats || unowned === 0}
        title="Page/route items with no open assignment — click to filter"
        // Only one background/border set at a time: Tailwind resolves
        // conflicting utilities by stylesheet order, not class order.
        className={`${PANEL_SHAPE} dashboard-control text-left enabled:hover:ring-2 ${
          unowned > 0
            ? hasPageUnowned
              ? "border-red-300 bg-red-50 ring-red-300 dark:border-red-500/40 dark:bg-red-500/10 dark:ring-red-500/40"
              : "border-amber-300 bg-amber-50 ring-amber-300 dark:border-amber-500/40 dark:bg-amber-500/10 dark:ring-amber-500/40"
            : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
        }`}
      >
        <p className={PANEL_LABEL}>Routed but unowned</p>
        <p
          className={`text-2xl font-semibold leading-8 tabular-nums ${
            unowned > 0
              ? hasPageUnowned
                ? "text-red-700 dark:text-red-400"
                : "text-amber-700 dark:text-amber-400"
              : "text-zinc-900 dark:text-zinc-100"
          }`}
        >
          {stats ? unowned : "—"}
        </p>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          {stats ? `${stats.unownedPage} in page band · ${stats.pageUnacked} page not acked` : " "}
        </p>
      </button>
      <div className={PANEL}>
        <p className={PANEL_LABEL}>New today</p>
        <p className="text-2xl font-semibold leading-8 tabular-nums text-zinc-900 dark:text-zinc-100">
          {stats?.newToday ?? "—"}
        </p>
        <p className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
          {stats
            ? `not mine ${percent(stats.notMineLast7d, stats.assignedLast7d)} · 7d`
            : " "}
        </p>
      </div>
    </div>
  );
}

export default function QueueContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const viewer = useTriageLogin();
  const filters = parseQueueFilters(new URLSearchParams(searchParams.toString()));
  const openItem = searchParams.get("item");
  const apiParams = queueFiltersToParams(filters).toString();

  const { data, error, isLoading, mutate } = useSWR<TriageQueueResponse>(
    `/api/triage/items${apiParams ? `?${apiParams}` : ""}`,
    triageFetcher,
    { keepPreviousData: true },
  );
  const { data: stats, mutate: mutateStats } = useSWR<TriageStats>("/api/triage/stats", triageFetcher);
  const [search, setSearch] = useState(filters.q ?? "");
  const [model, setModel] = useState(filters.model ?? "");

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

  function toggleBand(band: BandKey) {
    const bands = filters.bands.includes(band)
      ? filters.bands.filter((value) => value !== band)
      : [...filters.bands, band];
    update({ bands: bands.length > 0 ? bands : filters.bands });
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <StatStrip
        stats={stats}
        onPickBand={(band) => update({ bands: [band], status: "any" })}
        onPickUnowned={() => update({ bands: ["page", "route"], status: "unassigned" })}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Score bands">
          {BAND_ORDER.map((band) => {
            const active = filters.bands.includes(band);
            return (
              <button
                key={band}
                type="button"
                aria-pressed={active}
                onClick={() => toggleBand(band)}
                className={`dashboard-control inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ring-1 ring-inset ${
                  active
                    ? BAND_STYLES[band].active
                    : "text-zinc-500 ring-zinc-200 hover:text-zinc-900 dark:ring-zinc-700 dark:hover:text-zinc-100"
                }`}
              >
                {!active && <span aria-hidden="true" className={`h-2 w-2 rounded-full ${BAND_STYLES[band].fill}`} />}
                {band}
              </button>
            );
          })}
        </div>
        <select aria-label="Kind" className={SELECT} value={filters.kind ?? ""} onChange={(e) => update({ kind: (e.target.value || null) as QueueFilters["kind"] })}>
          <option value="">Issues + PRs</option>
          <option value="issue">Issues</option>
          <option value="pr">PRs</option>
        </select>
        <select aria-label="Area" className={SELECT} value={filters.area ?? ""} onChange={(e) => update({ area: e.target.value || null })}>
          <option value="">Any area</option>
          {TRIAGE_AREAS.map((area) => <option key={area} value={area}>{area}</option>)}
        </select>
        <select aria-label="Hardware" className={SELECT} value={filters.hardware ?? ""} onChange={(e) => update({ hardware: e.target.value || null })}>
          <option value="">Any hardware</option>
          {TRIAGE_HARDWARE.map((hw) => <option key={hw} value={hw}>{hw}</option>)}
        </select>
        <select aria-label="Assignment status" className={SELECT} value={filters.status} onChange={(e) => update({ status: e.target.value as QueueFilters["status"] })}>
          {QUEUE_STATUSES.map((status) => <option key={status} value={status}>{status === "any" ? "Any status" : status}</option>)}
        </select>
        <select aria-label="Sort" className={SELECT} value={filters.sort} onChange={(e) => update({ sort: e.target.value as QueueFilters["sort"] })}>
          {QUEUE_SORTS.map((sort) => <option key={sort} value={sort}>Sort: {sort}</option>)}
        </select>
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          <input type="checkbox" checked={filters.state === "all"} onChange={(e) => update({ state: e.target.checked ? "all" : "open" })} />
          include closed
        </label>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: search.trim() || null, model: model.trim() || null });
          }}
        >
          <input aria-label="Model" placeholder="Model…" value={model} onChange={(e) => setModel(e.target.value)} className={`${SELECT} w-28`} />
          <input aria-label="Search" placeholder="Search title, summary, #…" value={search} onChange={(e) => setSearch(e.target.value)} className={`${SELECT} w-52`} />
          <button type="submit" className={`${SELECT} font-medium`}>Apply</button>
        </form>
        {filters.assignee && (
          <button type="button" className={SELECT} onClick={() => update({ assignee: null })}>
            assignee: {filters.assignee} ✕
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error.message}</p>}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[1040px] text-left text-sm">
          <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            <tr>
              <th className="w-1 p-0" aria-label="Band" />
              <th className="px-3 py-2">Score</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Areas</th>
              <th className="px-3 py-2">Models</th>
              <th className="px-3 py-2">Hardware</th>
              <th className="px-3 py-2">Serving</th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2 text-right">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-900 dark:bg-zinc-950">
            {data?.items.map((item) => {
              const style = bandStyle(item.band);
              const facets = { severity: item.severity ?? undefined, type: item.type ?? undefined };
              return (
                <tr
                  key={item.itemKey}
                  className="cursor-pointer align-top hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                  onClick={() => update({ page: filters.page }, { item: item.itemKey })}
                >
                  <td className={`w-1 p-0 ${style.fill}`} aria-hidden="true" />
                  <td className="px-3 py-1.5">
                    <ScoreCell band={item.band} score={item.score} />
                  </td>
                  <td className="max-w-[30rem] px-3 py-1.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <KindIcon kind={item.kind} draft={item.draft} />
                      <span className="text-xs tabular-nums text-zinc-400 dark:text-zinc-500">#{item.number}</span>
                      <TypeLabel type={item.type} />
                      <SeverityFlags facets={facets} />
                    </div>
                    <div className="mt-0.5 line-clamp-2 font-medium leading-snug" onClick={(event) => event.stopPropagation()}>
                      <GithubLink href={item.htmlUrl} title={item.title}>{item.title}</GithubLink>
                    </div>
                    {item.summary && (
                      <p className="mt-0.5 line-clamp-1 text-xs text-zinc-500 dark:text-zinc-400" title={item.summary}>
                        {item.summary}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-1.5"><Chips values={item.areas} kind="area" max={2} /></td>
                  <td className="px-3 py-1.5"><Chips values={item.models} kind="model" max={2} /></td>
                  <td className="px-3 py-1.5"><Chips values={item.hardware} kind="hardware" max={3} /></td>
                  <td className="px-3 py-1.5"><Chips values={item.serving} kind="serving" max={2} /></td>
                  <td className="px-3 py-1.5">
                    {item.assignments.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        {item.assignments.map((assignment) => (
                          <Assignee key={assignment.id} login={assignment.maintainer} status={assignment.status} role={assignment.role} />
                        ))}
                      </div>
                    ) : isUnrouted(item.band, 0) ? (
                      <UnroutedBadge />
                    ) : (
                      <span className="text-zinc-300 dark:text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right text-xs tabular-nums text-zinc-500" title={item.ghCreatedAt}>
                    {formatAge(item.ghCreatedAt)}
                  </td>
                </tr>
              );
            })}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-sm text-zinc-400">No items match these filters.</td>
              </tr>
            )}
            {!data && isLoading && (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-sm text-zinc-400">Loading…</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span>{data.total} items</span>
          <div className="flex gap-2">
            <button type="button" className={SELECT} disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 })}>Previous</button>
            <span className="self-center">Page {filters.page} of {totalPages}</span>
            <button type="button" className={SELECT} disabled={filters.page >= totalPages} onClick={() => update({ page: filters.page + 1 })}>Next</button>
          </div>
        </div>
      )}

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
