import { Suspense } from "react";
import QueueContent from "./queue-content";

function QueueFallback() {
  return (
    <div className="flex h-64 items-center justify-center text-zinc-400">
      Loading queue data...
    </div>
  );
}

export default function QueuePage() {
  return (
    <Suspense fallback={<QueueFallback />}>
      <QueueContent />
    </Suspense>
  );
}
