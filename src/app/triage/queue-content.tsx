"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { StatCard } from "@/components/stat-card";
import { BandBadge, Chips, GithubLink, KindBadge } from "@/components/triage/badges";
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
import type { TriageQueueResponse, TriageStats } from "@/lib/triage-types";
import { TRIAGE_AREAS, TRIAGE_BANDS, TRIAGE_HARDWARE, type TriageBand } from "@/lib/triage-vocab";

const SELECT =
  "min-h-9 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";

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
  const { data: stats } = useSWR<TriageStats>("/api/triage/stats", triageFetcher);
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

  function toggleBand(band: TriageBand) {
    const bands = filters.bands.includes(band)
      ? filters.bands.filter((value) => value !== band)
      : [...filters.bands, band];
    update({ bands: bands.length > 0 ? bands : filters.bands });
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Ingested (24h)" value={stats?.ingestedLast24h ?? "—"} />
        <StatCard
          label="Extraction coverage (7d)"
          value={stats ? percent(stats.extractedLast7d, stats.inScopeLast7d) : "—"}
          detail={stats ? `${stats.extractedLast7d} of ${stats.inScopeLast7d} in-scope items` : undefined}
        />
        <StatCard
          label="Page band, unacked"
          value={stats?.pageUnacked ?? "—"}
          color={stats && stats.pageUnacked > 0 ? "red" : "default"}
        />
        <StatCard
          label="Not-mine rate (7d)"
          value={stats ? percent(stats.notMineLast7d, stats.assignedLast7d) : "—"}
          detail={stats ? `${stats.notMineLast7d} of ${stats.assignedLast7d} assignments` : undefined}
        />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Score bands">
          {TRIAGE_BANDS.map((band) => (
            <button
              key={band}
              type="button"
              aria-pressed={filters.bands.includes(band)}
              onClick={() => toggleBand(band)}
              className={`dashboard-control min-h-9 rounded-md px-2.5 text-xs font-medium ring-1 ring-inset ${
                filters.bands.includes(band)
                  ? "bg-zinc-900 text-white ring-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-100"
                  : "text-zinc-500 ring-zinc-200 hover:text-zinc-900 dark:ring-zinc-700 dark:hover:text-zinc-100"
              }`}
            >
              {band}
            </button>
          ))}
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
          <input aria-label="Model" placeholder="Model…" value={model} onChange={(e) => setModel(e.target.value)} className={`${SELECT} w-32`} />
          <input aria-label="Search" placeholder="Search title, summary, #…" value={search} onChange={(e) => setSearch(e.target.value)} className={`${SELECT} w-56`} />
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
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            <tr>
              <th className="px-3 py-2">Score</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Areas</th>
              <th className="px-3 py-2">Models</th>
              <th className="px-3 py-2">Hardware</th>
              <th className="px-3 py-2">Serving</th>
              <th className="px-3 py-2">Assignees</th>
              <th className="px-3 py-2 text-right">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {data?.items.map((item) => (
              <tr
                key={item.itemKey}
                className="cursor-pointer align-top hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                onClick={() => update({ page: filters.page }, { item: item.itemKey })}
              >
                <td className="px-3 py-2"><BandBadge band={item.band} score={item.score} /></td>
                <td className="max-w-[28rem] px-3 py-2">
                  <div className="flex items-center gap-2">
                    <KindBadge kind={item.kind} draft={item.draft} />
                    <span className="text-xs text-zinc-400">#{item.number}</span>
                    {item.type && <span className="text-xs text-zinc-500">{item.type}</span>}
                  </div>
                  <div className="mt-0.5 font-medium leading-snug" onClick={(event) => event.stopPropagation()}>
                    <GithubLink href={item.htmlUrl}>{item.title}</GithubLink>
                  </div>
                  {item.summary && <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">{item.summary}</p>}
                </td>
                <td className="px-3 py-2"><Chips values={item.areas} max={3} /></td>
                <td className="px-3 py-2"><Chips values={item.models} max={2} /></td>
                <td className="px-3 py-2"><Chips values={item.hardware} max={3} /></td>
                <td className="px-3 py-2"><Chips values={item.serving} tone="muted" max={3} /></td>
                <td className="px-3 py-2 text-xs">
                  {item.assignments.length === 0 ? (
                    <span className="text-zinc-400">—</span>
                  ) : (
                    item.assignments.map((assignment) => (
                      <div key={assignment.id}>
                        {assignment.maintainer}
                        <span className="text-zinc-400"> · {assignment.status}</span>
                      </div>
                    ))
                  )}
                </td>
                <td className="px-3 py-2 text-right text-xs tabular-nums text-zinc-500">{formatAge(item.ghCreatedAt)}</td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-sm text-zinc-400">No items match these filters.</td>
              </tr>
            )}
            {!data && isLoading && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-sm text-zinc-400">Loading…</td>
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
          onChanged={() => void mutate()}
        />
      )}
    </div>
  );
}
