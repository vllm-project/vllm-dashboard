"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ActionButtons, TERMINAL_ACTIONS } from "@/components/triage/action-buttons";
import { ItemDrawer } from "@/components/triage/item-drawer";
import { ListShortcuts } from "@/components/triage/list-shortcuts";
import { UndoToastProvider } from "@/components/triage/undo-toast";
import { EmptyState, GroupedRows, KindLegend, PriorityGroupHeader, RowSkeleton } from "@/components/triage/item-row";
import { groupBand, nestGroups, rowOrder } from "@/lib/triage-groups";
import { advanceAfter, listPosition, stepItem } from "@/lib/triage-keys";
import { PLATE_VIEWS, matchesPlateFilters, parsePlateFilters, plateFilterParams, plateNextAction, overdueAck, type PlateFilters } from "@/lib/triage-my-list";
import type { TriageAction } from "@/lib/triage-vocab";
import { useLocationHash } from "@/lib/use-location-hash";
import { describeReason, formatAge, itemFromLocation, triageFetcher } from "@/lib/triage-format";
import { BAND_STYLES, groupByPriority } from "@/lib/triage-style";
import type { TriageMyPlate } from "@/lib/triage-types";

type Entry = TriageMyPlate["open"][number];

/** Status in words; notes when it followed GitHub rather than a click. */
function statusText(entry: Entry): string {
  const { status, reason } = entry.assignment;
  if (status === "done" && reason.closed_by === "github") return `closed on GitHub (${String(reason.item_state ?? "closed")})`;
  if (status === "acked") return reason.acked_by === "github_comment" ? "✓ acked (you commented on GitHub)" : "✓ acked";
  return status.replace("_", " ");
}

function routedBecause(entry: Entry): string | null {
  const reason = entry.assignment.reason as { why?: unknown; matched?: unknown };
  if (typeof reason.why === "string" && reason.why) return reason.why;
  const matched = Array.isArray(reason.matched) ? reason.matched.filter((value): value is string => typeof value === "string") : [];
  return matched.length > 0 ? matched.map(describeReason).join("; ") : null;
}

/** Why it's yours plus the actions, under the item's context line. */
function PlateFooter({ entry, closed, onChanged, onOpen, now }: { entry: Entry; closed: boolean; onChanged: () => void; onOpen: () => void; now: number }) {
  const why = routedBecause(entry);
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        <span className="font-medium text-zinc-600 dark:text-zinc-300">
          {entry.assignment.role === "primary" ? "Primary" : "Backup"} · {statusText(entry)}
        </span>
        {!closed && (
          <span className={overdueAck(entry, now) ? "ml-2 font-medium text-amber-700 dark:text-amber-400" : "ml-2"} title={entry.assignment.assignedAt}>
            Assigned {formatAge(entry.assignment.assignedAt, now)} ago{overdueAck(entry, now) ? " · ack overdue" : ""}
          </span>
        )}
        {why && <span className="line-clamp-1"> {why}</span>}
      </p>
      <ActionButtons
        compact
        onOpen={onOpen}
        itemKey={entry.itemKey}
        assignmentId={entry.assignment.id}
        mode={closed ? "closed" : entry.assignment.status === "acked" ? "acked" : "open"}
        onDone={onChanged}
        relevance={entry.relevanceMatches}
        owners={[entry.assignment.maintainer]}
      />
    </div>
  );
}

function PlateFilterControls({ filters, onChange }: { filters: PlateFilters; onChange: (patch: Partial<PlateFilters>) => void }) {
  const count = [filters.kind, filters.role, filters.status, filters.readiness].filter(Boolean).length;
  const selectClass = "mt-1 block w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900";
  return (
    <details className="text-xs text-zinc-600 dark:text-zinc-300">
      <summary className="dashboard-control w-fit cursor-pointer rounded-md border border-zinc-200 px-2.5 py-1.5 font-medium dark:border-zinc-700">
        Filters{count ? ` · ${count}` : ""}
      </summary>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label>Item type<select className={selectClass} value={filters.kind ?? ""} onChange={(event) => onChange({ kind: event.target.value as PlateFilters["kind"] || null })}>
          <option value="">Issues + PRs</option><option value="issue">Issues</option><option value="pr">PRs</option>
        </select></label>
        <label>Your role<select className={selectClass} value={filters.role ?? ""} onChange={(event) => onChange({ role: event.target.value as PlateFilters["role"] || null })}>
          <option value="">Primary + backup</option><option value="primary">Primary</option><option value="backup">Backup</option>
        </select></label>
        <label>Acknowledgement<select className={selectClass} value={filters.status ?? ""} onChange={(event) => onChange({ status: event.target.value as PlateFilters["status"] || null })}>
          <option value="">Any</option><option value="open">Needs ack</option><option value="acked">Acknowledged</option>
        </select></label>
        <label>PR readiness<select className={selectClass} value={filters.readiness ?? ""} onChange={(event) => onChange({ readiness: event.target.value as PlateFilters["readiness"] || null })}>
          <option value="">Any</option><option value="review">Ready for review</option><option value="merge">Ready to merge</option>
        </select></label>
      </div>
      {count > 0 && <button type="button" className="dashboard-control mt-2 rounded underline underline-offset-2" onClick={() => onChange({ kind: null, role: null, status: null, readiness: null })}>Clear filters</button>}
    </details>
  );
}

export default function MyPlateContent() {
  return (
    <UndoToastProvider>
      <MyPlate />
    </UndoToastProvider>
  );
}

function MyPlate() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hash = useLocationHash();
  const openItem = itemFromLocation(searchParams.get("item"), hash);
  const filters = parsePlateFilters(searchParams);
  const { view } = filters;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const { data, error, mutate } = useSWR<TriageMyPlate>("/api/triage/me", triageFetcher, { refreshInterval: 60_000 });

  // `view` and `item` both live in the URL, so a reload or a shared link lands in the same place.
  function navigate(next: Partial<PlateFilters> & { item?: string | null }) {
    const item = "item" in next ? next.item : openItem;
    const params = plateFilterParams({ ...filters, ...next }, item ?? null);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }
  const setItem = (item: string | null) => navigate({ item });

  const shown = data ? data.open.filter((entry) => matchesPlateFilters(entry, filters, now)) : [];
  // Your fix PRs sit under the issue they fix: one row, the PRs indented beneath.
  const grouped = nestGroups(shown);
  const groups = groupByPriority(grouped, groupBand);
  const closedRows = data ? nestGroups(data.recentlyClosed) : [];
  // Keyboard navigation only includes visible rows.
  const openOrder = groups.flatMap((group) => rowOrder(group.items));
  const order = [...openOrder, ...(historyOpen ? rowOrder(closedRows).filter((key) => !openOrder.includes(key)) : [])];
  const position = listPosition(order, openItem);
  const prev = openItem ? stepItem(order, openItem, -1) : null;
  const next = openItem ? stepItem(order, openItem, 1) : null;

  function afterAction(action: TriageAction, alsoApplied: readonly string[]) {
    // A terminal action takes the item (and fix PRs that followed it) off
    // your list: go straight to the next one still on it.
    if (!openItem || !openOrder.includes(openItem)) return;
    const current = data?.open.find((entry) => entry.itemKey === openItem);
    const leavesViewAfterAck = action === "ack" && current && !matchesPlateFilters(
      { ...current, assignment: { ...current.assignment, status: "acked" } }, filters, now,
    );
    if (!TERMINAL_ACTIONS.includes(action) && !leavesViewAfterAck) return;
    setItem(advanceAfter(openOrder.filter((key) => !alsoApplied.includes(key)), openItem));
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error.message}</p>}

      <div className="overflow-clip rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="space-y-2 border-b border-zinc-200 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">On your list</h2>
            {data && (
              <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                Showing {shown.length} of {data.open.length} assignments
                <span title="A group is an issue with its linked fix PRs, or a standalone item"> · {grouped.length} groups</span>
              </p>
            )}
          </div>
          {data && data.open.length > 0 && (
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
              {PLATE_VIEWS.map((option) => {
                const count = data.open.filter((entry) => matchesPlateFilters(entry, { ...filters, view: option.id }, now)).length;
                const on = view === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => navigate({ view: option.id })}
                    className={`dashboard-control inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium ${
                      on
                        ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                        : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-50"
                    }`}
                  >
                    {option.label}
                    <span className="tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
          {data && data.open.length > 0 && <PlateFilterControls filters={filters} onChange={navigate} />}
        </div>
        {!data && !error && <RowSkeleton rows={3} />}
        {data && data.open.length === 0 && (
          <EmptyState
            title="Your list is clear"
            detail="Nothing is assigned to you right now. Unowned P0/P1 items are waiting in the queue."
            action={
              <Link
                href="/triage"
                className="dashboard-control mt-1 rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                See what needs triage
              </Link>
            }
          />
        )}
        {data && data.open.length > 0 && shown.length === 0 && (
          <EmptyState
            title="Nothing here"
            detail="No items on your list match this filter."
            action={
              <button
                type="button"
                onClick={() => navigate({ view: "all", kind: null, role: null, status: null, readiness: null })}
                className="dashboard-control mt-1 rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Show all
              </button>
            }
          />
        )}
        {groups.length > 0 && <KindLegend />}
        {groups.map((group) => (
          <section key={group.band} aria-label={`${BAND_STYLES[group.band].label} items`}>
            <PriorityGroupHeader band={group.band} count={group.items.reduce((n, row) => n + 1 + row.members.length, 0)} />
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              <GroupedRows
                rows={group.items}
                rowKey={(entry) => entry.assignment.id}
                hideOwner
                activeKey={openItem}
                onOpen={(entry) => setItem(entry.itemKey)}
                onOpenKey={setItem}
                label={(entry) => (
                  <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                    overdueAck(entry, now) ? "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                      : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                  }`} title={plateNextAction(entry, now) === "Ready to merge" ? "Fresh observed readiness; confirm on GitHub before merging" : undefined}>
                    {plateNextAction(entry, now)}
                  </span>
                )}
                footer={(entry) => <PlateFooter entry={entry} closed={false} now={now} onOpen={() => setItem(entry.itemKey)} onChanged={() => void mutate()} />}
              />
            </ul>
          </section>
        ))}
      </div>

      {data && data.recentlyClosed.length > 0 && (
        <details open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)} className="overflow-clip rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <summary className="dashboard-control cursor-pointer px-4 py-3 text-sm font-semibold text-zinc-900 dark:bg-zinc-900/40 dark:text-zinc-100">
            Recently closed · {data.recentlyClosed.length}
            <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">Last 14 days</span>
          </summary>
          {historyOpen && <ul className="divide-y divide-zinc-100 opacity-90 dark:divide-zinc-900">
            <GroupedRows
              rows={closedRows}
              rowKey={(entry) => entry.assignment.id}
              hideOwner
              activeKey={openItem}
              onOpen={(entry) => setItem(entry.itemKey)}
              onOpenKey={setItem}
              footer={(entry) => <PlateFooter entry={entry} closed now={now} onOpen={() => setItem(entry.itemKey)} onChanged={() => void mutate()} />}
            />
          </ul>}
        </details>
      )}

      <ListShortcuts enabled={!openItem} onOpenFirst={openOrder[0] ? () => setItem(openOrder[0]) : null} />
      {openItem && data && (
        <ItemDrawer
          itemKey={openItem}
          viewer={data.login}
          onClose={() => setItem(null)}
          onChanged={() => void mutate()}
          onActed={afterAction}
          nav={{
            position,
            onPrev: prev ? () => setItem(prev) : null,
            onNext: next ? () => setItem(next) : null,
          }}
        />
      )}
    </div>
  );
}
