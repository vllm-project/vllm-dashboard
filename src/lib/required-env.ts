// Environment variables a production deployment cannot run without. The cron
// routes refuse every request while CRON_SECRET is unset (fail closed), so a
// deploy that lacks it silently stops queue polling, alerts and retention, as
// happened on 2026-10-27. `npm run build` checks this list on Vercel
// production builds (scripts/check-production-env.ts) and fails the deploy
// instead. Add a variable here when a route stops working without it.

export const REQUIRED_PRODUCTION_ENV: Record<string, string> = {
  CRON_SECRET: "authenticates Vercel cron: queue polling, queue alerts, retention, force-merge ingest, cache warming",
  DATABASE_URL: "Postgres: queue, GPU, alert and force-merge data",
  DATABRICKS_HOST: "the Buildkite warehouse behind builds, jobs and cost",
  DATABRICKS_TOKEN: "the Buildkite warehouse behind builds, jobs and cost",
  DATABRICKS_WAREHOUSE_ID: "the Buildkite warehouse behind builds, jobs and cost",
  BUILDKITE_API_TOKEN: "queue polling and live queue/agent views",
  GITHUB_TOKEN: "force-merge ingest and commit lookups",
  SLACK_BOT_TOKEN: "the queue-wait Slack alert",
  GPU_REPORT_SECRET: "GPU reporters and quarantine actuators",
  OTEL_INGEST_TOKEN: "CI trace ingestion",
  ALERT_OPERATOR_TOKEN: "resolving alerts and quarantines",
  ALERT_AGENT_TOKEN: "responder updates on Main CI alerts",
};

/**
 * Variables the routes read but that have a working default, so they are
 * not required. Listed so the guard test can tell them from forgotten ones.
 */
export const OPTIONAL_ENV = new Set([
  "BUILDKITE_ORGANIZATION",
  "GH_TOKEN",
  "SLACK_CI_ALERT_CHANNEL",
  "WARM_DEFAULTS_BASE_URL",
]);

/** Required variables that are unset or empty in `env`. */
export function missingProductionEnv(
  env: Record<string, string | undefined>,
): string[] {
  return Object.keys(REQUIRED_PRODUCTION_ENV).filter((name) => !env[name]?.trim());
}
