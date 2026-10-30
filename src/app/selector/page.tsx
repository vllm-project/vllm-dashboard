import { Suspense } from "react";
import SelectorContent from "./selector-content";

function SelectorFallback() {
  return (
    <div className="flex h-64 items-center justify-center text-zinc-400">
      Loading CI selector health...
    </div>
  );
}

export default function SelectorPage() {
  return (
    <Suspense fallback={<SelectorFallback />}>
      <SelectorContent />
    </Suspense>
  );
}
