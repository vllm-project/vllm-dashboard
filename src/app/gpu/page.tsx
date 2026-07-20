import { GpuDashboard } from "@/app/gpu/gpu-dashboard";
import { getInitialGpuData } from "@/lib/gpu-data";
import type { GpuHistoryResponse, GpuLatest } from "@/lib/gpu-types";

export const dynamic = "force-dynamic";

export default async function GpuPage() {
  let initialHistory: GpuHistoryResponse = { hours: 24, snapshots: [] };
  let initialLatest: GpuLatest[] = [];
  let initialNow = 0;

  try {
    const initial = await getInitialGpuData();
    initialHistory = initial.history;
    initialLatest = initial.latest;
    initialNow = initial.asOf;
  } catch (error) {
    console.error("Failed to prefetch GPU dashboard data:", error);
  }

  return (
    <GpuDashboard
      initialHistory={initialHistory}
      initialLatest={initialLatest}
      initialNow={initialNow}
    />
  );
}
