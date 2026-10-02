import type { LoaderFunctionArgs } from "react-router";
import { runCron } from "../lib/cron-run.server.js";
import { drainProductSyncQueue } from "../lib/sync/product-sync.server.js";
import { drainCatalogRefreshQueue } from "../lib/sync/inventory-sync-queue.server.js";

// Must be a literal (the Vercel preset parses it statically); cron-config.test.ts checks it equals CRON_JOBS.
export const config = { maxDuration: 60 };

export async function loader({ request }: LoaderFunctionArgs) {
  return runCron(request, "catalog-sync", async () => {
    const result = await drainProductSyncQueue({ maxSteps: 6, maxRuntimeMs: 45_000 });
    // Backstop for webhook-driven refreshes whose waitUntil drain didn't run.
    const refresh = await drainCatalogRefreshQueue({ maxRuntimeMs: 40_000 });
    return { body: { ok: true, processedSteps: result.steps, refresh } };
  });
}
