import { Suspense } from "react";
import ShardingContent from "./sharding-content";

function ShardingFallback() {
  return (
    <div className="flex h-64 items-center justify-center text-zinc-400">
      Loading sharding data...
    </div>
  );
}

export default function ShardingPage() {
  return (
    <Suspense fallback={<ShardingFallback />}>
      <ShardingContent />
    </Suspense>
  );
}
