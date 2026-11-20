"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ShortcutHelp } from "@/components/triage/keyboard-help";
import { drawerCommand } from "@/lib/triage-keys";

/**
 * List pages with no drawer open: `j` opens the first item (then j / k walk
 * the list inside the drawer) and `?` shows the shortcuts. Same rules as the
 * drawer: nothing fires while typing or with a modifier held.
 */
export function ListShortcuts({ enabled, onOpenFirst }: { enabled: boolean; onOpenFirst: (() => void) | null }) {
  const [help, setHelp] = useState(false);
  const closeHelp = useCallback(() => setHelp(false), []);
  const latest = useRef(onOpenFirst);
  useEffect(() => {
    latest.current = onOpenFirst;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const command = drawerCommand(event);
      if (command === "next" && latest.current) {
        event.preventDefault();
        latest.current();
      } else if (command === "help") {
        event.preventDefault();
        setHelp(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
  return help && enabled ? <ShortcutHelp onClose={closeHelp} /> : null;
}
