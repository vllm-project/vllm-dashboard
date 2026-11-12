"use client";

import useSWR from "swr";
import { triageFetcher } from "@/lib/triage-format";

export function useTriageLogin(): string | null {
  const { data } = useSWR<{ login: string }>("/api/triage/session", triageFetcher, {
    revalidateOnFocus: false,
  });
  return data?.login ?? null;
}
