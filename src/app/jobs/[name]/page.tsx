import { Suspense } from "react";
import JobDetail from "./job-detail";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const jobName = decodeURIComponent(name);
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center text-sm text-muted">
          Loading job...
        </div>
      }
    >
      <JobDetail jobName={jobName} />
    </Suspense>
  );
}
