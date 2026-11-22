/** Report evidence, not independent verification by the bot. Mirrors incidents.py. */
export interface TriageIncident {
  impact?: string;
  exposure?: string;
  affected_context?: string;
  verification?: string;
  mitigation?: string;
  status?: string;
  release_blocker?: boolean | null;
  reason?: string;
  evidence?: Record<string, string>;
}

const CRITICAL = ["outage", "material_wrong_results", "serious_security", "service_unusable", "distribution_blocked"];
export const INCIDENT_EVIDENCE_KEYS = ["impact", "exposure", "current", "verification", "mitigation"];
const DEFECTS = ["bug", "regression", "perf_regression", "performance", "ci"];

export function p0Ineligibility(type: string, incident?: TriageIncident): string | null {
  const i = incident ?? {};
  if (!DEFECTS.includes(type)) return "P0 requires a defect, not a feature or question";
  if (!CRITICAL.includes(i.impact ?? "")) return "P0 requires critical service, correctness, security, or distribution impact";
  if (i.status !== "active") return "P0 requires an active incident; acknowledgment alone is not mitigation";
  if (!["supported_release", "production_deployment"].includes(i.affected_context ?? ""))
    return "P0 requires affected users on a supported release or production deployment; main-only is a release concern";
  if (!["broad_supported", "critical_deployment"].includes(i.exposure ?? ""))
    return "P0 requires broad supported-path impact or an identified critical deployment";
  if (!["reproduced", "maintainer_confirmed", "security_advisory"].includes(i.verification ?? ""))
    return "P0 requires concrete failure evidence or confirmation, not just a reproduction command";
  if (i.verification === "security_advisory" && i.impact !== "serious_security")
    return "A security advisory cannot establish an unrelated service incident";
  if (!["none", "unacceptable"].includes(i.mitigation ?? ""))
    return "P0 requires evidence that a safe, practical mitigation is unavailable or inadequate";
  const required = INCIDENT_EVIDENCE_KEYS.filter((key) => key !== "mitigation" || i.mitigation === "unacceptable");
  const missing = required.filter((key) => {
    const quote = i.evidence?.[key];
    return typeof quote !== "string" || !quote.trim();
  });
  return missing.length ? `P0 evidence missing: ${missing.join(", ")}` : null;
}

export function needsIncidentVerification(type: string, incident?: TriageIncident, security = false): boolean {
  return DEFECTS.includes(type) && (CRITICAL.includes(incident?.impact ?? "") || security) &&
    !["mitigated", "resolved"].includes(incident?.status ?? "");
}

/** Top-of-drawer card only for P0, critical reports needing verification, or release blockers. */
export function showIncidentCard(type: string, incident?: TriageIncident, security = false): boolean {
  if (!incident) return false;
  return (
    p0Ineligibility(type, incident) === null ||
    needsIncidentVerification(type, incident, security) ||
    incident.release_blocker === true
  );
}
