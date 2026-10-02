import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { runCron } from "../lib/cron-run.server.js";
import { runAllSkioShippingSyncs } from "../lib/skio-shipping-cron.server.js";

// Must be a literal (the Vercel preset parses it statically); cron-config.test.ts checks it equals CRON_JOBS.
export const config = { maxDuration: 300 };

export async function loader({ request }: LoaderFunctionArgs) {
  return runCron(request, "skio-shipping", async () => {
    // Per-shop failures are captured inside (not thrown) so the loop keeps going.
    const result = await runAllSkioShippingSyncs(getDb());
    return { body: { ok: result.shopsFailed === 0, ...result }, status: result.shopsFailed > 0 ? 207 : 200 };
  });
}
