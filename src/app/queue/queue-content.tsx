"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import QueueDetails from "./queue-details";
import QueueTraffic from "./queue-traffic";

export default function QueueContent() {
  const searchParams = useSearchParams();
  const view =
    searchParams.get("view") ??
    (searchParams.has("queue") ? "details" : "traffic");

  return (
    <div className="space-y-6">
      <nav
        aria-label="Queue views"
        className="inline-flex gap-1 rounded-lg border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-950"
      >
        {(
          [
            ["details", "Queue details"],
            ["traffic", "Traffic & utilization"],
          ] as const
        ).map(([key, label]) => {
          const params = new URLSearchParams(searchParams.toString());
          params.set("view", key);
          return (
            <Link
              key={key}
              href={`/queue?${params}`}
              aria-current={view === key ? "page" : undefined}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${view === key ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      {view === "details" ? <QueueDetails /> : <QueueTraffic />}
    </div>
  );
}
