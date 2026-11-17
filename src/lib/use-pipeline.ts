"use client";

import { useSearchParams } from "next/navigation";
import { getPipeline } from "./pipeline-navigation";

export function usePipeline(): string {
  return getPipeline(useSearchParams());
}
