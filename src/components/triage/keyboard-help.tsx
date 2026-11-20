"use client";

import { useEffect, useRef } from "react";
import { DRAWER_SHORTCUTS } from "@/lib/triage-keys";

/** A small key cap, for hints on buttons and in the help overlay. */
export function Kbd({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={`inline-flex min-w-[1.1rem] items-center justify-center rounded border border-zinc-400/50 px-1 font-mono text-[10px] font-medium leading-4 opacity-60 ${className}`}
    >
      {children}
    </kbd>
  );
}

/**
 * The "?" overlay: every drawer shortcut. Esc, "?" or a click outside closes
 * it; focus goes to its Close button while open.
 */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    // Capture: runs before the drawer's own window listener, so Esc closes only this.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "?") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="triage-shortcuts-title">
      <button type="button" aria-label="Close shortcuts" tabIndex={-1} className="absolute inset-0 bg-zinc-950/30 dark:bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-xs rounded-lg border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="triage-shortcuts-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Keyboard shortcuts
          </h2>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            className="dashboard-control rounded px-1.5 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            Close
          </button>
        </div>
        <dl className="space-y-1.5 text-xs">
          {DRAWER_SHORTCUTS.map((shortcut) => (
            <div key={shortcut.key} className="flex items-center justify-between gap-4">
              <dt className="text-zinc-600 dark:text-zinc-300">{shortcut.label}</dt>
              <dd>
                <Kbd className="!opacity-100 text-zinc-700 dark:text-zinc-200">{shortcut.key}</Kbd>
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[11px] text-zinc-500 dark:text-zinc-400">
          In the item panel. Keys do nothing while you type in a field or hold Ctrl, Alt or ⌘.
        </p>
      </div>
    </div>
  );
}
