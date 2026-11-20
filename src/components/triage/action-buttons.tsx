"use client";

import { useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import { Kbd } from "@/components/triage/keyboard-help";
import { useUndoToast } from "@/components/triage/undo-toast";
import { drawerCommand } from "@/lib/triage-keys";
import { sendJson, triageFetcher } from "@/lib/triage-format";
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
  mode: "open" | "acked" | "closed" | "unassigned" | "others";
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
  /** Compact My list actions; other actions remain available under More. */
  compact?: boolean;
  onOpen?: () => void;
}

/** Actions that close the viewer's assignment (or move it away): they get the Undo toast. */
export const TERMINAL_ACTIONS: readonly TriageAction[] = ["not_mine", "done", "drop", "slop", "reassign"];

const BASE =
  "dashboard-control inline-flex min-h-8 items-center gap-1 rounded-md border px-2.5 text-xs font-medium disabled:opacity-50";
const SECONDARY = `${BASE} border-zinc-200 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800`;
const PRIMARY = `${BASE} border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`;
const QUIET = `${BASE} border-transparent text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100`;

function toastMessage(action: TriageAction, target?: string): string {
  switch (action) {
    case "not_mine":
      return "Marked not mine";
    case "done":
      return "Marked done";
    case "drop":
      return "Dropped: hidden from every maintainer";
    case "slop":
      return "Marked as slop: hidden from every maintainer";
    case "reassign":
      return target ? `Reassigned to ${target}` : "Reassigned";
    default:
      return "Saved";
  }
}

const HIDE_TITLE = "Hides this from every maintainer";

/** Hide actions, plus less common assignment actions under More on compact rows. */
function HideMenu({ disabled, onPick, extra = [] }: {
  disabled: boolean;
  onPick: (action: "drop" | "slop") => void;
  extra?: { label: string; run: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        className={QUIET}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={extra.length ? "More actions" : HIDE_TITLE}
        onClick={() => setOpen((value) => !value)}
      >
        {extra.length ? "More" : "Hide"}
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
          <path d="M4 6l4 4 4-4z" />
        </svg>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={extra.length ? "More actions" : "Hide this item"}
          onKeyDown={(event) => {
            const items = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const next = (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            } else if (event.key === "Tab") {
              setOpen(false);
            }
          }}
          className={`${extra.length ? "relative w-56 max-w-full" : "absolute w-64"} left-0 z-30 mt-1 rounded-lg border border-zinc-200 bg-white p-1 text-xs shadow-lg shadow-black/10 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/40`}
        >
          {extra.map((option, index) => (
            <button key={option.label} ref={index === 0 ? first : undefined} type="button" role="menuitem"
              onClick={() => { close(); option.run(); }}
              className="dashboard-control block w-full rounded-md px-2 py-1.5 text-left font-medium hover:bg-zinc-100 focus:bg-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800">
              {option.label}
            </button>
          ))}
          <p className="px-2 pb-1 pt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">{HIDE_TITLE}; it is never routed again.</p>
          {(
            [
              ["drop", "Drop", "Not worth anyone's time."],
              ["slop", "Slop", "Low-quality or AI-generated noise; also teaches the scorer."],
            ] as const
          ).map(([action, label, detail], index) => (
            <button
              key={action}
              ref={index === 0 && extra.length === 0 ? first : undefined}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(action);
              }}
              className="dashboard-control flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-red-50 focus:bg-red-50 dark:hover:bg-red-500/10 dark:focus:bg-red-500/10"
            >
              <span className="font-semibold text-red-700 dark:text-red-400">{label}</span>
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ActionButtons({ itemKey, assignmentId, mode, onDone, relevance = [], owners = [], onActed, keyboard = false, compact = false, onOpen }: Props) {
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
          message: toastMessage(action, extra.target),
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
        {mode === "open" && (
          <button type="button" className={PRIMARY} disabled={busy} onClick={() => act("ack")} title={titled("Tell everyone you're on it", "a")}>
            Ack{hint("a")}
          </button>
        )}
        {mode === "unassigned" && (
          <button type="button" className={PRIMARY} disabled={busy} onClick={() => act("ack")} title={titled("Become its owner", "a")}>
            Take it{hint("a")}
          </button>
        )}
        {compact && mode === "acked" && onOpen && (
          <button type="button" className={PRIMARY} onClick={onOpen}>Open</button>
        )}
        {working && (
          <>
            {(!compact || mode === "acked") && <button type="button" className={SECONDARY} disabled={busy} onClick={() => act("done")} title={titled("You've dealt with it", "d")}>
              Done{hint("d")}
            </button>}
            {(!compact || mode === "open") && <button type="button" className={SECONDARY} disabled={busy} onClick={() => act("not_mine")} title={titled("Send it to someone else", "n")}>
              Not mine{hint("n")}
            </button>}
          </>
        )}
        {mode !== "closed" && !compact && (
          <button
            type="button"
            className={SECONDARY}
            disabled={busy}
            aria-expanded={reassigning}
            title={titled("Hand it to someone you choose", "r")}
            onClick={() => setReassigning((value) => !value)}
          >
            Reassign…{hint("r")}
          </button>
        )}
        {working && <HideMenu disabled={busy} onPick={(action) => void act(action)} extra={compact ? [
          ...(mode === "open" ? [{ label: "Done", run: () => void act("done") }] : [{ label: "Not mine", run: () => void act("not_mine") }]),
          { label: "Reassign…", run: () => { setReassigning(true); window.requestAnimationFrame(() => select.current?.focus()); } },
        ] : []} />}
        {mode === "closed" && (
          <button type="button" className={SECONDARY} disabled={busy} onClick={() => act("reopen")}>
            Reopen
          </button>
        )}
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
            className={SECONDARY}
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
