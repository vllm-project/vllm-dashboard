"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type StateRecord = Record<string, string>;

/**
 * Page state that lives in the query string so every view is a shareable
 * link. Keys equal to their default are omitted from the URL, so the plain
 * route stays clean. Components calling this must render inside a
 * `<Suspense>` boundary because it reads `useSearchParams`.
 */
export function useUrlState<T extends StateRecord>(
  defaults: T,
): [T, (patch: Partial<T>) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo(() => {
    const next = { ...defaults } as T;
    for (const key of Object.keys(defaults) as Array<keyof T>) {
      const value = searchParams.get(key as string);
      if (value !== null) next[key] = value as T[keyof T];
    }
    return next;
  }, [defaults, searchParams]);

  const setState = useCallback(
    (patch: Partial<T>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null || value === defaults[key]) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [defaults, pathname, router, searchParams],
  );

  return [state, setState];
}

/** Today's date as YYYY-MM-DD, for date-range defaults. */
export function isoDate(daysAgo = 0): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}
