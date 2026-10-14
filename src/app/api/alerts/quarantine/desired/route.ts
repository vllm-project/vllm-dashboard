import {
  actuatorCall,
  desiredQuarantines,
  fail,
} from "@/lib/quarantine-actions";

export const dynamic = "force-dynamic";

// Matches the QUARANTINE_CLUSTER names the actuators send (h100, b200, h200).
const CLUSTER = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/**
 * What one cluster's quarantine actuator polls every minute: its hosts with an
 * open quarantine episode and their stage. Requires the GPU_REPORT_SECRET
 * bearer credential the reporters already hold.
 */
export async function GET(request: Request) {
  return actuatorCall(request, "Reading desired quarantines", async (_body, db) => {
    const cluster = new URL(request.url).searchParams.get("cluster") ?? "";
    if (!CLUSTER.test(cluster)) return fail(400, "cluster is not a valid name.");
    return desiredQuarantines(db(), cluster);
  });
}
