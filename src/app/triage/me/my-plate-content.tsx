"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ActionButtons, TERMINAL_ACTIONS } from "@/components/triage/action-buttons";
import { ItemDrawer } from "@/components/triage/item-drawer";
import { ListShortcuts } from "@/components/triage/list-shortcuts";
import { UndoToastProvider } from "@/components/triage/undo-toast";
import { EmptyState, GroupedRows, PriorityGroupHeader, RowSkeleton } from "@/components/triage/item-row";
import { groupBand, nestGroups, rowOrder } from "@/lib/triage-groups";
import { advanceAfter, listPosition, stepItem } from "@/lib/triage-keys";
import { PLATE_VIEWS, inPlateView, parsePlateView, type PlateView } from "@/lib/triage-presets";
import type { TriageAction } from "@/lib/triage-vocab";
import { useLocationHash } from "@/lib/use-location-hash";
import { describeReason, itemFromLocation, triageFetcher } from "@/lib/triage-format";
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
function PlateFooter({ entry, closed, onChanged }: { entry: Entry; closed: boolean; onChanged: () => void }) {
  const why = routedBecause(entry);
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        <span className="font-medium text-zinc-600 dark:text-zinc-300">
          {entry.assignment.role === "primary" ? "Primary" : "Backup"} · {statusText(entry)}
        </span>
        {why && <span className="line-clamp-1"> {why}</span>}
      </p>
      <ActionButtons
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
  const view = parsePlateView(searchParams.get("view"));
  const { data, error, mutate } = useSWR<TriageMyPlate>("/api/triage/me", triageFetcher);

  // `view` and `item` both live in the URL, so a reload or a shared link lands in the same place.
  function navigate(next: { item?: string | null; view?: PlateView }) {
    const params = new URLSearchParams();
    const nextView = next.view ?? view;
    if (nextView !== "all") params.set("view", nextView);
    const item = "item" in next ? next.item : openItem;
    if (item) params.set("item", item);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }
  const setItem = (item: string | null) => navigate({ item });

  const shown = data ? data.open.filter((entry) => inPlateView(entry, view)) : [];
  // Your fix PRs sit under the issue they fix: one row, the PRs indented beneath.
  const groups = data ? groupByPriority(nestGroups(shown), groupBand) : [];
  const closedRows = data ? nestGroups(data.recentlyClosed) : [];
  const notAcked = data?.open.filter((entry) => entry.assignment.status === "open").length ?? 0;
  // j / k order: the open list as drawn, then the closed list.
  const openOrder = groups.flatMap((group) => rowOrder(group.items));
  const order = [...openOrder, ...rowOrder(closedRows).filter((key) => !openOrder.includes(key))];
  const position = listPosition(order, openItem);
  const prev = openItem ? stepItem(order, openItem, -1) : null;
  const next = openItem ? stepItem(order, openItem, 1) : null;

  function afterAction(action: TriageAction, alsoApplied: readonly string[]) {
    // A terminal action takes the item (and fix PRs that followed it) off
    // your list: go straight to the next one still on it.
    if (!openItem || !TERMINAL_ACTIONS.includes(action) || !openOrder.includes(openItem)) return;
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
                {data.open.length} open · {notAcked} not acked yet
                {groups.length > 0 && ` · ${groups.map((group) => `${group.items.reduce((n, row) => n + 1 + row.members.length, 0)} ${BAND_STYLES[group.band].label}`).join(", ")}`}
              </p>
            )}
          </div>
          {data && data.open.length > 0 && (
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
              {PLATE_VIEWS.map((option) => {
                const count = data.open.filter((entry) => inPlateView(entry, option.id)).length;
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
                onClick={() => navigate({ view: "all" })}
                className="dashboard-control mt-1 rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Show all
              </button>
            }
          />
        )}
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
                footer={(entry) => <PlateFooter entry={entry} closed={false} onChanged={() => void mutate()} />}
              />
            </ul>
          </section>
        ))}
      </div>

      {data && data.recentlyClosed.length > 0 && (
        <div className="overflow-clip rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-baseline gap-3 border-b border-zinc-200 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Closed in the last 14 days</h2>
            <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{data.recentlyClosed.length}</p>
          </div>
          <ul className="divide-y divide-zinc-100 opacity-90 dark:divide-zinc-900">
            <GroupedRows
              rows={closedRows}
              rowKey={(entry) => entry.assignment.id}
              hideOwner
              activeKey={openItem}
              onOpen={(entry) => setItem(entry.itemKey)}
              onOpenKey={setItem}
              footer={(entry) => <PlateFooter entry={entry} closed onChanged={() => void mutate()} />}
            />
          </ul>
        </div>
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
