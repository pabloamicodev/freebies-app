import type { LoaderFunctionArgs } from "react-router";
import { cleanupOldAnalyticsEvents } from "../lib/sync/analytics-reconcile.server.js";
import { cleanupOperationalState } from "../lib/operational-retention.server.js";
import { runNightlyCatalogReconcile } from "../lib/sync/product-sync.server.js";
import { runCron } from "../lib/cron-run.server.js";

// Must be a literal (the Vercel preset parses it statically); cron-config.test.ts checks it equals CRON_JOBS.
export const config = { maxDuration: 60 };

export async function loader({ request }: LoaderFunctionArgs) {
  return runCron(request, "analytics-cleanup", async () => {
    const retentionDays = Number(process.env["ANALYTICS_RETENTION_DAYS"] ?? 90);
    // Queues every shop's import and drains within budget; the per-minute catalog-sync cron resumes the rest.
    const reconcile = runNightlyCatalogReconcile({ maxRuntimeMs: 40_000 }).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    const [analyticsDeleted, operational, catalogReconcile] = await Promise.all([
      cleanupOldAnalyticsEvents(Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 90, undefined, 45_000),
      cleanupOperationalState(),
      reconcile,
    ]);
    return { body: { ok: !("error" in catalogReconcile), analyticsDeleted, operational, catalogReconcile } };
  });
}
