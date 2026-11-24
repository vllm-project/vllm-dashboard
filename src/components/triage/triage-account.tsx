"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { SECTION_NAV_ACTIONS_ID } from "@/components/section-nav";
import { Avatar } from "@/components/triage/badges";
import { triageFetcher } from "@/lib/triage-format";
import type { TriageStats } from "@/lib/triage-types";

const noopSubscribe = () => () => {};

/**
 * The signed-in maintainer, live My-list badge, and Sign out, right-aligned in
 * the section tab row instead of on a row of their own. Rendered through a
 * portal into the slot SectionNav leaves for it; nothing renders on the server.
 */
export function TriageAccount({ login }: { login: string }) {
  const slot = useSyncExternalStore(
    noopSubscribe,
    () => document.getElementById(SECTION_NAV_ACTIONS_ID),
    () => null,
  );
  const { data: stats } = useSWR<TriageStats>("/api/triage/stats", triageFetcher, {
    refreshInterval: 120_000,
  });
  if (!slot) return null;
  const myOpen = stats?.viewer?.myOpen ?? 0;
  const myUnacked = stats?.viewer?.myUnacked ?? 0;
  return createPortal(
    <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
      {myOpen > 0 && (
        <Link
          href="/triage/me"
          title={myUnacked > 0 ? `${myOpen} open on your list (${myUnacked} unacked)` : `${myOpen} open on your list`}
          className={`dashboard-control inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
            myUnacked > 0
              ? "bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-500/40"
              : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
          }`}
        >
          My list
          <span className="font-semibold">{myUnacked > 0 ? `${myUnacked} unacked` : myOpen}</span>
        </Link>
      )}
      <span className="inline-flex items-center gap-1.5" title={`Signed in as ${login}`}>
        <Avatar login={login} />
        <span className="hidden font-medium text-zinc-700 sm:inline dark:text-zinc-300">{login}</span>
      </span>
      <form action="/api/triage/auth/logout" method="post">
        <button
          type="submit"
          className="dashboard-control rounded-md px-1.5 py-1 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          Sign out
        </button>
      </form>
    </div>,
    slot,
  );
}
