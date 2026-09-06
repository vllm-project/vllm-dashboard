import { Suspense } from "react";
import BuildDetail from "./build-detail";

export default async function BuildDetailPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const { number } = await params;
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center text-sm text-muted">
          Loading build #{number}...
        </div>
      }
    >
      <BuildDetail number={number} />
    </Suspense>
  );
}
