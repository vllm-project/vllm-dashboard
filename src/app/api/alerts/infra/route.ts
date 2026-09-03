import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import type {
  InfraAlertEpisode,
  InfraAlertStatus,
  InfraAlertType,
  InfraRetiredHost,
} from "@/lib/alerts-infra";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";

export const dynamic = "force-dynamic";

// Infra episodes are an operational feed like the Fast CI view: every open
// episode plus a week of resolved history, capped so a flapping fleet cannot
// produce an unbounded response.
const WINDOW_DAYS = 7;
const MAX_EPISODES = 500;

interface InfraAlertEpisodeRow {
  alert_id: number | string;
  alert_type: InfraAlertType;
  subject_key: string;
  status: InfraAlertStatus;
  opened_at: Date;
  resolved_at: Date | null;
  details: Record<string, unknown>;
}

interface InfraRetiredHostRow {
  subject_key: string;
  last_reported_at: Date | null;
  retired_at: Date;
}

function toEpisode(row: InfraAlertEpisodeRow): InfraAlertEpisode {
  return {
    alertId: String(row.alert_id),
    alertType: row.alert_type,
    subjectKey: row.subject_key,
    status: row.status,
    openedAt: row.opened_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    details: row.details,
  };
}

function toRetiredHost(row: InfraRetiredHostRow): InfraRetiredHost {
  return {
    subjectKey: row.subject_key,
    lastReportedAt: row.last_reported_at?.toISOString() ?? null,
    retiredAt: row.retired_at.toISOString(),
  };
}

export async function GET() {
  try {
    const db = getDb();

    // Postgres alone answers this view: the breach episodes, and the hosts
    // the worker auto-retired after seven days absent from every expected
    // source (only unreporting hosts can retire).
    const episodes = await db<InfraAlertEpisodeRow[]>`
      SELECT alert_id, alert_type, subject_key, status, opened_at,
             resolved_at, details
      FROM alerting_infra_alerts
      WHERE status = 'open' OR resolved_at >= now() - ${`${WINDOW_DAYS} days`}::interval
      ORDER BY (status = 'open') DESC,
               COALESCE(resolved_at, opened_at) DESC
      LIMIT ${MAX_EPISODES}
    `;
    const retiredHosts = await db<InfraRetiredHostRow[]>`
      SELECT subject_key, last_reported_at, retired_at
      FROM alerting_infra_host_states
      WHERE retired_at IS NOT NULL
      ORDER BY retired_at DESC
    `;

    return NextResponse.json(
      {
        episodes: episodes.map(toEpisode),
        retiredHosts: retiredHosts.map(toRetiredHost),
        windowDays: WINDOW_DAYS,
        schemaStatus: "ready",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Preview deployments are created before migration 0019 is intentionally
    // applied to the shared database. Treat that ordered rollout state as a
    // neutral, explicit response instead of a broken dashboard.
    if (hasPostgresErrorCode(error, "42P01")) {
      return NextResponse.json(
        { episodes: [], retiredHosts: [], schemaStatus: "pending" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("Failed to load infra alerts:", error);
    return NextResponse.json(
      { error: "Infra alerts could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
