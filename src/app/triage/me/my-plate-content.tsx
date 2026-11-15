"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ActionButtons } from "@/components/triage/action-buttons";
import {
  Chips,
  GithubLink,
  KindIcon,
  ScoreCell,
  SeverityFlags,
  TypeLabel,
} from "@/components/triage/badges";
import { bandStyle } from "@/lib/triage-style";
import { ItemDrawer } from "@/components/triage/item-drawer";
import { formatAge, triageFetcher } from "@/lib/triage-format";
import type { TriageMyPlate } from "@/lib/triage-types";

type Entry = TriageMyPlate["open"][number];

function matchedReasons(entry: Entry): string[] {
  const matched = (entry.assignment.reason as { matched?: unknown }).matched;
  return Array.isArray(matched) ? matched.filter((value): value is string => typeof value === "string") : [];
}

function PlateCard({
  entry,
  closed,
  onOpen,
  onChanged,
}: {
  entry: Entry;
  closed: boolean;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const reasons = matchedReasons(entry);
  return (
    <li className="relative overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 pl-5 dark:border-zinc-800 dark:bg-zinc-950">
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${bandStyle(entry.band).fill}`} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <ScoreCell band={entry.band} score={entry.score} />
        <KindIcon kind={entry.kind} draft={entry.draft} />
        <span className="tabular-nums">#{entry.number}</span>
        <TypeLabel type={entry.type} />
        <SeverityFlags facets={{ severity: entry.severity ?? undefined, type: entry.type ?? undefined }} max={5} />
        <span>{entry.assignment.role} · {entry.assignment.status} · assigned {formatAge(entry.assignment.assignedAt)} ago by {entry.assignment.assignedBy}</span>
      </div>
      <p className="mt-1.5 line-clamp-2 font-medium leading-snug">
        <GithubLink href={entry.htmlUrl} title={entry.title}>{entry.title}</GithubLink>
      </p>
      {entry.summary && <p className="mt-1 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400" title={entry.summary}>{entry.summary}</p>}
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        <Chips kind="area" values={entry.areas} max={4} />
        <Chips kind="model" values={entry.models} max={3} />
        <Chips kind="hardware" values={entry.hardware} max={3} />
        <Chips kind="serving" values={entry.serving} max={3} />
      </div>
      {reasons.length > 0 && (
        <p className="mt-2 text-[11px] text-zinc-500">Routed to you because: {reasons.join(", ")}</p>
      )}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
        <ActionButtons
          itemKey={entry.itemKey}
          assignmentId={entry.assignment.id}
          mode={closed ? "closed" : entry.assignment.status === "acked" ? "acked" : "open"}
          onDone={onChanged}
        />
        <button
          type="button"
          onClick={onOpen}
          className="dashboard-control text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
        >
          Details
        </button>
      </div>
    </li>
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

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error.message}</p>;
  if (!data) return <p className="text-sm text-zinc-400">Loading…</p>;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          On your plate <span className="font-normal text-zinc-500">({data.open.length})</span>
        </h2>
        {data.open.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing assigned to you right now.</p>
        ) : (
          <ul className="space-y-3">
            {data.open.map((entry) => (
              <PlateCard key={entry.assignment.id} entry={entry} closed={false} onOpen={() => setItem(entry.itemKey)} onChanged={() => void mutate()} />
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Closed in the last 14 days <span className="font-normal text-zinc-500">({data.recentlyClosed.length})</span>
        </h2>
        {data.recentlyClosed.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing closed recently.</p>
        ) : (
          <ul className="space-y-3">
            {data.recentlyClosed.map((entry) => (
              <PlateCard key={entry.assignment.id} entry={entry} closed onOpen={() => setItem(entry.itemKey)} onChanged={() => void mutate()} />
            ))}
          </ul>
        )}
      </section>
      {openItem && (
        <ItemDrawer itemKey={openItem} viewer={data.login} onClose={() => setItem(null)} onChanged={() => void mutate()} />
      )}
    </div>
  );
}
