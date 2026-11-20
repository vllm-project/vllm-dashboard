"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { sendJson } from "@/lib/triage-format";

/** How long the Undo toast stays up (the server allows undo for a minute). */
export const UNDO_TOAST_MS = 5_000;

export interface UndoToastRequest {
  /** "Marked done", "Hidden from every maintainer", … */
  message: string;
  /** The triage_actions row to undo; null shows the message without Undo. */
  actionId: number | null;
  /** Called after a successful undo (refresh the lists). */
  onUndone?: () => void;
}

type Show = (request: UndoToastRequest) => void;

const UndoToastContext = createContext<Show | null>(null);

/** Show the "… · Undo" toast; a no-op outside an UndoToastProvider. */
export function useUndoToast(): Show {
  return useContext(UndoToastContext) ?? (() => undefined);
}

interface ToastState extends UndoToastRequest {
  key: number;
  phase: "ready" | "undoing" | "undone" | "failed";
  error?: string;
}

/**
 * One toast at a time, bottom centre, above the drawer. It closes after
 * UNDO_TOAST_MS, but not while the pointer or keyboard focus is on it.
 */
export function UndoToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [held, setHeld] = useState(false);
  const counter = useRef(0);

  const show = useCallback<Show>((request) => {
    counter.current += 1;
    setHeld(false);
    setToast({ ...request, key: counter.current, phase: "ready" });
  }, []);

  useEffect(() => {
    if (!toast || held || toast.phase === "undoing") return;
    const ms = toast.phase === "ready" ? UNDO_TOAST_MS : toast.phase === "failed" ? 5_000 : 1_500;
    const timer = window.setTimeout(() => setToast((current) => (current?.key === toast.key ? null : current)), ms);
    return () => window.clearTimeout(timer);
  }, [toast, held]);

  async function undo() {
    if (!toast || toast.actionId === null || toast.phase !== "ready") return;
    const { key, actionId, onUndone } = toast;
    setToast((current) => (current?.key === key ? { ...current, phase: "undoing" } : current));
    try {
      await sendJson("/api/triage/actions/undo", "POST", { actionId });
      setToast((current) => (current?.key === key ? { ...current, phase: "undone", message: "Undone." } : current));
      onUndone?.();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setToast((current) => (current?.key === key ? { ...current, phase: "failed", error } : current));
    }
  }

  return (
    <UndoToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex justify-center px-4">
        {toast && (
          <div
            key={toast.key}
            onMouseEnter={() => setHeld(true)}
            onMouseLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={() => setHeld(false)}
            className="pointer-events-auto flex max-w-md items-center gap-3 rounded-lg bg-zinc-900 px-3.5 py-2 text-sm text-white shadow-lg shadow-black/20 dark:bg-zinc-100 dark:text-zinc-900"
          >
            <span className="min-w-0">
              {toast.phase === "failed" ? `Couldn't undo: ${toast.error}` : toast.message}
            </span>
            {toast.actionId !== null && (toast.phase === "ready" || toast.phase === "undoing") && (
              <button
                type="button"
                onClick={() => void undo()}
                disabled={toast.phase === "undoing"}
                className="dashboard-control shrink-0 rounded px-1.5 py-0.5 text-sm font-semibold text-sky-300 underline-offset-2 hover:underline disabled:opacity-60 dark:text-sky-700"
              >
                {toast.phase === "undoing" ? "Undoing…" : "Undo"}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setToast(null)}
              className="dashboard-control -mr-1 shrink-0 rounded p-0.5 text-zinc-400 hover:text-white dark:text-zinc-500 dark:hover:text-zinc-900"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </UndoToastContext.Provider>
  );
}
