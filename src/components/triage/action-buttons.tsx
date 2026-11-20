"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Kbd } from "@/components/triage/keyboard-help";
import { useUndoToast } from "@/components/triage/undo-toast";
import { drawerCommand } from "@/lib/triage-keys";
import { sendJson, triageFetcher } from "@/lib/triage-format";
import { actionButtons, actionToast, type ActionButtonSpec, type ActionMode } from "@/lib/triage-buttons";
import { reassignOptions, type ReassignCandidate } from "@/lib/triage-reassign";
import type { TriageRelevance } from "@/lib/triage-types";
import type { TriageAction } from "@/lib/triage-vocab";

interface Props {
  itemKey: string;
  assignmentId: number | null;
  /**
   * "open"/"acked": the viewer's own assignment (working actions); "closed":
   * the viewer's closed assignment (Reopen); "unassigned": Take + Reassign;
   * "others": someone else holds it (Reassign only).
   */
  mode: ActionMode;
  onDone: () => void;
  /** Claude's relevance per maintainer for this item: orders the Reassign list. */
  relevance?: readonly Pick<TriageRelevance, "maintainer" | "relevance">[];
  /** Who holds it now; left out of the Reassign list. */
  owners?: readonly string[];
  /**
   * After any action succeeds (e.g. to move on to the next item).
   * `alsoApplied`: fix PRs the same click changed (an issue's group).
   */
  onActed?: (action: TriageAction, alsoApplied: readonly string[]) => void;
  /** Single-key shortcuts (a / d / n / r) and their hints: the drawer's buttons only. */
  keyboard?: boolean;
}

/** Actions that close the viewer's assignment (or move it away): they get the Undo toast. */
export const TERMINAL_ACTIONS: readonly TriageAction[] = ["not_mine", "done", "drop", "slop", "reassign"];

const BASE =
  "dashboard-control inline-flex min-h-8 items-center gap-1 rounded-md border px-2.5 text-xs font-medium disabled:opacity-50";
const LOOK: Record<ActionButtonSpec["look"], string> = {
  secondary: `${BASE} border-zinc-200 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800`,
  primary: `${BASE} border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`,
  danger: `${BASE} border-red-300 text-red-700 hover:bg-red-50 dark:border-red-500/50 dark:text-red-400 dark:hover:bg-red-500/10`,
};

export function ActionButtons({ itemKey, assignmentId, mode, onDone, relevance = [], owners = [], onActed, keyboard = false }: Props) {
  const [busy, setBusy] = useState(false);
  const select = useRef<HTMLSelectElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState(false);
  const [target, setTarget] = useState("");
  const showUndo = useUndoToast();
  const { data: maintainers } = useSWR<{ maintainers: (ReassignCandidate & { openAssignments: number })[] }>(
    reassigning ? "/api/triage/maintainers" : null,
    triageFetcher,
  );
  const options = maintainers ? reassignOptions(maintainers.maintainers, relevance, owners) : [];
  const hasMatches = options.some((option) => option.relevance !== null);

  async function act(action: TriageAction, extra: { target?: string } = {}) {
    setBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ actionId?: number; alsoApplied?: string[] }>("/api/triage/actions", "POST", {
        itemKey,
        action,
        assignmentId,
        ...extra,
      });
      setReassigning(false);
      setTarget("");
      if (TERMINAL_ACTIONS.includes(action)) {
        showUndo({
          message: actionToast(action, extra.target),
          actionId: typeof result.actionId === "number" ? result.actionId : null,
          onUndone: onDone,
        });
      }
      onDone();
      onActed?.(action, Array.isArray(result.alsoApplied) ? result.alsoApplied : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const working = mode === "open" || mode === "acked";

  // Latest state for the key handler without re-subscribing on every render.
  const keyState = useRef({ busy, mode, working, act });
  useEffect(() => {
    keyState.current = { busy, mode, working, act };
  });
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (event: KeyboardEvent) => {
      const command = drawerCommand(event);
      const { busy: isBusy, mode: current, working: canWork, act: run } = keyState.current;
      if (!command || isBusy) return;
      if (command === "ack" && (current === "open" || current === "unassigned")) {
        event.preventDefault();
        void run("ack");
      } else if ((command === "done" || command === "not_mine") && canWork) {
        event.preventDefault();
        void run(command);
      } else if (command === "reassign" && current !== "closed") {
        event.preventDefault();
        setReassigning(true);
        window.requestAnimationFrame(() => select.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard]);

  const hint = (key: string) => (keyboard ? <Kbd className="ml-0.5">{key}</Kbd> : null);
  const titled = (text: string, key: string) => (keyboard ? `${text} (${key})` : text);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {actionButtons(mode).map((button) => {
          const reassign = button.id === "reassign";
          return (
            <button
              key={button.id}
              type="button"
              className={LOOK[button.look]}
              disabled={busy}
              aria-expanded={reassign ? reassigning : undefined}
              title={button.shortcut ? titled(button.title, button.shortcut) : button.title}
              onClick={() => {
                if (reassign) {
                  setReassigning((value) => !value);
                  window.requestAnimationFrame(() => select.current?.focus());
                } else if (button.action) {
                  void act(button.action);
                }
              }}
            >
              {button.label}
              {reassign && (
                <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
                  <path d="M4 6l4 4 4-4z" />
                </svg>
              )}
              {button.shortcut && hint(button.shortcut)}
            </button>
          );
        })}
        {mode !== "closed" &&
          keyboard &&
          relevance
            .filter(
              (match) =>
                (match.relevance === "high" || match.relevance === "medium") &&
                !owners.some((owner) => owner.toLowerCase() === match.maintainer.toLowerCase()),
            )
            .slice(0, 2)
            .map((match) => (
              <button
                key={match.maintainer}
                type="button"
                className={LOOK.secondary}
                disabled={busy}
                title={`One-click assign to ${match.maintainer} (${match.relevance} relevance match)`}
                onClick={() => act("reassign", { target: match.maintainer })}
              >
                → {match.maintainer}
                <span className="text-[10px] font-normal text-zinc-400 dark:text-zinc-500">
                  {match.relevance === "high" ? "high" : "med"}
                </span>
              </button>
            ))}
      </div>
      {reassigning && (
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            ref={select}
            aria-label="Reassign to"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="min-h-8 max-w-full rounded-md border border-zinc-200 bg-white px-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">{maintainers ? "Choose a maintainer…" : "Loading maintainers…"}</option>
            {hasMatches && (
              <optgroup label="Best match for this item (Claude)">
                {options
                  .filter((option) => option.relevance !== null)
                  .map((option) => (
                    <option key={option.login} value={option.login}>
                      {option.label}
                    </option>
                  ))}
              </optgroup>
            )}
            <optgroup label={hasMatches ? "Everyone else" : "Maintainers"}>
              {options
                .filter((option) => option.relevance === null)
                .map((option) => (
                  <option key={option.login} value={option.login}>
                    {option.label}
                  </option>
                ))}
            </optgroup>
          </select>
          <button
            type="button"
            className={LOOK.secondary}
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
