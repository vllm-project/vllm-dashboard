import { Suspense } from "react";
import OverviewContent from "./overview-content";

function OverviewFallback() {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-muted">
      Loading overview...
    </div>
  );
}

export default function OverviewPage() {
  return (
    <Suspense fallback={<OverviewFallback />}>
      <OverviewContent />
    </Suspense>
  );
}
