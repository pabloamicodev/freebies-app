import type { LoaderFunctionArgs } from "react-router";
import { runCron } from "../lib/cron-run.server.js";
import { reconcileAllShopsGiftVariants } from "../lib/sync/gift-stock-reconcile.server.js";

// Must be a literal (the Vercel preset parses it statically); cron-config.test.ts checks it equals CRON_JOBS.
export const config = { maxDuration: 300 };

export async function loader({ request }: LoaderFunctionArgs) {
  return runCron(request, "gift-stock", async () => {
    const result = await reconcileAllShopsGiftVariants();
    return { body: { ok: result.failed === 0, ...result } };
  });
}
