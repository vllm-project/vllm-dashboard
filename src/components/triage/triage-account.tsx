"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { SECTION_NAV_ACTIONS_ID } from "@/components/section-nav";
import { Avatar } from "@/components/triage/badges";

const noopSubscribe = () => () => {};

/**
 * The signed-in maintainer and Sign out, right-aligned in the section tab row
 * instead of on a row of their own. Rendered through a portal into the slot
 * SectionNav leaves for it; nothing renders on the server.
 */
export function TriageAccount({ login }: { login: string }) {
  const slot = useSyncExternalStore(
    noopSubscribe,
    () => document.getElementById(SECTION_NAV_ACTIONS_ID),
    () => null,
  );
  if (!slot) return null;
  return createPortal(
    <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
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
