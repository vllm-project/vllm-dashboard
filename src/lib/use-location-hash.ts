"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The URL fragment ("#123"), "" during server rendering. */
export function useLocationHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash, () => "");
}
