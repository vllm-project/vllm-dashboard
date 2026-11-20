"use client";

import { useCallback, useEffect, useState } from "react";
import type { BandKey } from "@/lib/triage-style";

/** Bands collapsed by default: P3 (ignore) only. */
export const DEFAULT_COLLAPSED: readonly BandKey[] = ["ignore"];

/** Parse a stored list, keeping only known band keys. */
export function parseCollapsed(raw: string | null, known: readonly string[]): BandKey[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    return value.filter((band): band is BandKey => typeof band === "string" && known.includes(band));
  } catch {
    return null;
  }
}

/** Flip one band in a collapsed list (returns a new list). */
export function toggleCollapsed(collapsed: readonly BandKey[], band: BandKey): BandKey[] {
  return collapsed.includes(band) ? collapsed.filter((b) => b !== band) : [...collapsed, band];
}

/**
 * Which priority groups are collapsed, remembered per browser (a viewer
 * convenience: storage may be blocked, then the defaults apply).
 */
export function useCollapsedBands(storageKey: string, known: readonly string[]) {
  const [collapsed, setCollapsed] = useState<BandKey[]>([...DEFAULT_COLLAPSED]);
  useEffect(() => {
    try {
      const stored = parseCollapsed(window.localStorage.getItem(storageKey), known);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount; storage isn't available during SSR
      if (stored) setCollapsed(stored);
    } catch {
      // storage blocked: keep the defaults
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once
  }, [storageKey]);
  const save = useCallback(
    (next: BandKey[]) => {
      setCollapsed(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // ignore
      }
    },
    [storageKey],
  );
  const toggle = useCallback((band: BandKey) => save(toggleCollapsed(collapsed, band)), [collapsed, save]);
  const expand = useCallback(
    (band: BandKey) => {
      if (collapsed.includes(band)) save(collapsed.filter((b) => b !== band));
    },
    [collapsed, save],
  );
  return { collapsed, toggle, expand };
}
