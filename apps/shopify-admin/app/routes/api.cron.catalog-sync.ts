import type { LoaderFunctionArgs } from "react-router";
import { runCron } from "../lib/cron-run.server.js";
import { drainProductSyncQueue } from "../lib/sync/product-sync.server.js";
import { drainCatalogRefreshQueue } from "../lib/sync/inventory-sync-queue.server.js";

// Must be a literal (the Vercel preset parses it statically); cron-config.test.ts checks it equals CRON_JOBS.
export const config = { maxDuration: 60 };

/** Both drains share this budget; a step started just before it ends still finishes, so keep headroom under maxDuration (60 s). */
const CATALOG_SYNC_BUDGET_MS = 50_000;
const PRODUCT_SYNC_SHARE_MS = 30_000;

export async function loader({ request }: LoaderFunctionArgs) {
  return runCron(request, "catalog-sync", async () => {
    const startedAt = Date.now();
    const result = await drainProductSyncQueue({ maxSteps: 6, maxRuntimeMs: PRODUCT_SYNC_SHARE_MS });
    // Backstop for webhook-driven refreshes whose waitUntil drain didn't run: whatever is left of the budget.
    const remaining = CATALOG_SYNC_BUDGET_MS - (Date.now() - startedAt);
    const refresh = remaining > 1_000 ? await drainCatalogRefreshQueue({ maxRuntimeMs: remaining }) : { skipped: "budget_spent" };
    return { body: { ok: true, processedSteps: result.steps, refresh } };
  });
}
