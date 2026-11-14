// Runs before `next build`. On a Vercel production build, fail the build when
// a required environment variable is missing, so the deploy is blocked rather
// than shipping crons that refuse every run (see src/lib/required-env.ts).
// Preview and local builds are not checked.
import {
  missingProductionEnv,
  REQUIRED_PRODUCTION_ENV,
} from "../src/lib/required-env";

if (process.env.VERCEL_ENV !== "production") {
  console.log("check-production-env: not a Vercel production build, skipping");
} else {
  const missing = missingProductionEnv(process.env);
  if (missing.length > 0) {
    console.error(
      "check-production-env: missing required production environment variables:",
    );
    for (const name of missing) {
      console.error(`  ${name}: ${REQUIRED_PRODUCTION_ENV[name]}`);
    }
    console.error(
      "Set them in Vercel → Settings → Environment Variables (Production), then redeploy.",
    );
    process.exit(1);
  }
  console.log(
    `check-production-env: all ${Object.keys(REQUIRED_PRODUCTION_ENV).length} required variables are set`,
  );
}
