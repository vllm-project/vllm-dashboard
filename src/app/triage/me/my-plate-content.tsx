"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ActionButtons } from "@/components/triage/action-buttons";
import { ItemDrawer } from "@/components/triage/item-drawer";
import { EmptyState, ItemRow, PriorityGroupHeader, RowSkeleton } from "@/components/triage/item-row";
import { describeReason, triageFetcher } from "@/lib/triage-format";
import { BAND_STYLES, groupByPriority } from "@/lib/triage-style";
import type { TriageMyPlate } from "@/lib/triage-types";

type Entry = TriageMyPlate["open"][number];

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
          {entry.assignment.role === "primary" ? "Primary" : "Backup"} · {entry.assignment.status === "acked" ? "✓ acked" : entry.assignment.status.replace("_", " ")}
        </span>
        {why && <span className="line-clamp-1"> {why}</span>}
      </p>
      <ActionButtons
        itemKey={entry.itemKey}
        assignmentId={entry.assignment.id}
        mode={closed ? "closed" : entry.assignment.status === "acked" ? "acked" : "open"}
        onDone={onChanged}
      />
    </div>
  );
}

export default function MyPlateContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openItem = searchParams.get("item");
  const { data, error, mutate } = useSWR<TriageMyPlate>("/api/triage/me", triageFetcher);

  function setItem(item: string | null) {
    router.replace(item ? `${pathname}?item=${encodeURIComponent(item)}` : pathname, { scroll: false });
  }

  const groups = data ? groupByPriority(data.open, (entry) => entry.band) : [];
  const notAcked = data?.open.filter((entry) => entry.assignment.status === "open").length ?? 0;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error.message}</p>}

      <div className="overflow-clip rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-zinc-200 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">On your plate</h2>
          {data && (
            <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              {data.open.length} open · {notAcked} not acked yet
              {groups.length > 0 && ` · ${groups.map((group) => `${group.items.length} ${BAND_STYLES[group.band].label}`).join(", ")}`}
            </p>
          )}
        </div>
        {!data && !error && <RowSkeleton rows={3} />}
        {data && data.open.length === 0 && (
          <EmptyState
            title="Your plate is clear"
            detail="Nothing is assigned to you right now. Unowned P0/P1 items are waiting in the queue."
            action={
              <Link
                href="/triage?bands=page,route&status=unassigned"
                className="dashboard-control mt-1 rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                See unowned P0/P1
              </Link>
            }
          />
        )}
        {groups.map((group) => (
          <section key={group.band} aria-label={`${BAND_STYLES[group.band].label} items`}>
            <PriorityGroupHeader band={group.band} count={group.items.length} />
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {group.items.map((entry) => (
                <ItemRow
                  key={entry.assignment.id}
                  item={entry}
                  hideOwner
                  onOpen={() => setItem(entry.itemKey)}
                  footer={<PlateFooter entry={entry} closed={false} onChanged={() => void mutate()} />}
                />
              ))}
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
            {data.recentlyClosed.map((entry) => (
              <ItemRow
                key={entry.assignment.id}
                item={entry}
                hideOwner
                onOpen={() => setItem(entry.itemKey)}
                footer={<PlateFooter entry={entry} closed onChanged={() => void mutate()} />}
              />
            ))}
          </ul>
        </div>
      )}

      {openItem && data && (
        <ItemDrawer itemKey={openItem} viewer={data.login} onClose={() => setItem(null)} onChanged={() => void mutate()} />
      )}
    </div>
  );
}
