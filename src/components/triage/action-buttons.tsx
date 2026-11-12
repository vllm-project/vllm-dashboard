"use client";

import { useState } from "react";
import useSWR from "swr";
import { sendJson, triageFetcher } from "@/lib/triage-format";
import type { TriageAction } from "@/lib/triage-vocab";

interface Props {
  itemKey: string;
  assignmentId: number | null;
  /**
   * "open"/"acked": the viewer's own assignment (working actions); "closed":
   * the viewer's closed assignment (Reopen); "unassigned": Take + Reassign;
   * "others": someone else holds it (Reassign only).
   */
  mode: "open" | "acked" | "closed" | "unassigned" | "others";
  onDone: () => void;
}

const BUTTON =
  "dashboard-control inline-flex min-h-8 items-center rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800";

export function ActionButtons({ itemKey, assignmentId, mode, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState(false);
  const [target, setTarget] = useState("");
  const { data: maintainers } = useSWR<{ maintainers: { githubLogin: string; openAssignments: number }[] }>(
    reassigning ? "/api/triage/maintainers" : null,
    triageFetcher,
  );

  async function act(action: TriageAction, extra: { target?: string } = {}) {
    setBusy(true);
    setError(null);
    try {
      await sendJson("/api/triage/actions", "POST", { itemKey, action, assignmentId, ...extra });
      setReassigning(false);
      setTarget("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {mode === "open" && (
          <button type="button" className={BUTTON} disabled={busy} onClick={() => act("ack")}>
            Ack
          </button>
        )}
        {mode === "unassigned" && (
          <button type="button" className={BUTTON} disabled={busy} onClick={() => act("ack")}>
            Take it
          </button>
        )}
        {(mode === "open" || mode === "acked") && (
          <>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => act("not_mine")}>
              Not mine
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => act("done")}>
              Done
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => act("drop")}>
              Drop
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => act("slop")}>
              Slop
            </button>
          </>
        )}
        {mode !== "closed" && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => setReassigning((value) => !value)}
          >
            Reassign…
          </button>
        )}
        {mode === "closed" && (
          <button type="button" className={BUTTON} disabled={busy} onClick={() => act("reopen")}>
            Reopen
          </button>
        )}
      </div>
      {reassigning && (
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Reassign to"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="min-h-8 rounded-md border border-zinc-200 bg-white px-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">Choose a maintainer…</option>
            {maintainers?.maintainers.map((maintainer) => (
              <option key={maintainer.githubLogin} value={maintainer.githubLogin}>
                {maintainer.githubLogin} ({maintainer.openAssignments} open)
              </option>
            ))}
          </select>
          <button
            type="button"
            className={BUTTON}
            disabled={busy || !target}
            onClick={() => act("reassign", { target })}
          >
            Reassign
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
