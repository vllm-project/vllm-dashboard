"use client";

import { Fragment, Suspense, type ReactNode } from "react";
import { usePipeline } from "@/lib/use-pipeline";

export function PipelineView({ children }: { children: (pipeline: string) => ReactNode }) {
  return (
    <Suspense fallback={<div className="flex h-64 items-center justify-center text-zinc-400">Loading dashboard...</div>}>
      <SelectedPipelineView>{children}</SelectedPipelineView>
    </Suspense>
  );
}

function SelectedPipelineView({ children }: { children: (pipeline: string) => ReactNode }) {
  const pipeline = usePipeline();
  // Pagination and job/group filters from one pipeline must not hide another's data.
  return <Fragment key={pipeline}>{children(pipeline)}</Fragment>;
}
