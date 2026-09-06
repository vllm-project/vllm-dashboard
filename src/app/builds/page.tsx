import { Suspense } from "react";
import BuildsContent from "./builds-content";

function BuildsFallback() {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-muted">
      Loading builds...
    </div>
  );
}

export default function BuildsPage() {
  return (
    <Suspense fallback={<BuildsFallback />}>
      <BuildsContent />
    </Suspense>
  );
}
