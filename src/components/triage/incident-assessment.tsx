import {
  INCIDENT_EVIDENCE_KEYS,
  p0Ineligibility,
  showIncidentCard,
  type TriageIncident,
} from "@/lib/triage-incidents";

export function IncidentAssessment({
  incident,
  type,
  security = false,
  alwaysShow = false,
}: {
  incident?: TriageIncident;
  type: string;
  security?: boolean;
  alwaysShow?: boolean;
}) {
  if (!incident) return null;
  if (!alwaysShow && !showIncidentCard(type, incident, security)) return null;
  const reason = p0Ineligibility(type, incident);
  const excerpts = INCIDENT_EVIDENCE_KEYS.filter((key) => typeof incident.evidence?.[key] === "string" && incident.evidence[key].trim());
  if (incident.impact === "unknown" && !incident.reason && !excerpts.length && !incident.release_blocker) return null;
  return (
    <section className="space-y-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        <span>{reason ? "Incident assessment" : "Why this qualifies as P0"}</span>
        <span className="text-xs font-normal text-zinc-500">{incident.status ?? "unknown"}</span>
        {incident.release_blocker && <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">Release blocker</span>}
      </div>
      {incident.reason && <p>{incident.reason}</p>}
      {reason && <p className="text-xs text-zinc-500">{reason}</p>}
      {excerpts.length > 0 && <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer">Evidence from the report</summary>
        <dl className="mt-2 space-y-2">
          {excerpts.map((key) => <div key={key}>
            <dt className="font-semibold capitalize">{key}</dt>
            <dd className="whitespace-pre-wrap">{incident.evidence?.[key]}</dd>
          </div>)}
        </dl>
      </details>}
      <p className="text-xs text-zinc-500">Based on the report, not independently reproduced by the bot. Acknowledging ownership does not mean the incident is mitigated.</p>
    </section>
  );
}
