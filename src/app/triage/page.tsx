import type { Metadata } from "next";
import { Suspense } from "react";
import QueueContent from "./queue-content";

export const metadata: Metadata = { title: "Triage queue" };

export default function TriageQueuePage() {
  return (
    <Suspense fallback={<div className="flex h-64 items-center justify-center text-sm text-zinc-400">Loading triage queue...</div>}>
      <QueueContent />
    </Suspense>
  );
}
