import { GpuDashboard } from "@/app/gpu/gpu-dashboard";
import { getInitialGpuData } from "@/lib/gpu-data";
import type { GpuLatest, GpuOverviewPoint, HostLatest } from "@/lib/gpu-types";

export const dynamic = "force-dynamic";

export default async function GpuPage() {
  let initialOverview: GpuOverviewPoint[] = [];
  let initialLatest: GpuLatest[] = [];
  let initialHosts: HostLatest[] = [];
  let initialLatestCheckedAt = "";
  let initialNow = 0;

  try {
    const initial = await getInitialGpuData();
    initialOverview = initial.overview;
    initialLatest = initial.latest;
    initialHosts = initial.hosts;
    initialLatestCheckedAt = initial.latestCheckedAt;
    initialNow = initial.asOf;
  } catch (error) {
    console.error("Failed to prefetch GPU dashboard data:", error);
  }

  return (
    <GpuDashboard
      initialOverview={initialOverview}
      initialLatest={initialLatest}
      initialHosts={initialHosts}
      initialLatestCheckedAt={initialLatestCheckedAt}
      initialNow={initialNow}
    />
  );
}
