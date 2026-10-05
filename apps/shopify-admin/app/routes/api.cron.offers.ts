import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { runOfferScheduler } from "../lib/offer-scheduling.server.js";
import * as Sentry from "@sentry/node";
import { runCron } from "../lib/cron-run.server.js";
import { runDiscountCodeSchedule } from "../lib/discount-code-schedule.server.js";
import { refreshStaleShopTimezones } from "../lib/shop-timezone-refresh.server.js";
import { reconcileActiveShopDiscountNodes, runDiscountDriftRepair } from "../lib/discount-reconciliation.server.js";

// Must be a literal (the Vercel preset parses it statically); cron-config.test.ts checks it equals CRON_JOBS.
export const config = { maxDuration: 300 };

export async function loader({ request }: LoaderFunctionArgs) {
  return runCron(request, "offers", async () => {
    // Before the scheduler so offers pinned to a corrected zone are evaluated with it. Never fails the cron.
    const timezones = await refreshStaleShopTimezones().catch((error) => {
      Sentry.captureException(error, { tags: { cron: "offers", stage: "timezone-refresh" } });
      return { checked: 0, updated: 0 };
    });
    const reconciliation = await reconcileActiveShopDiscountNodes();
    for (const failure of reconciliation.failures) {
      Sentry.captureMessage("Discount node reconciliation failed", {
        level: "error",
        tags: { cron: "offers", stage: "discount-node-reconciliation", shopId: failure.shopId },
        extra: failure,
      });
    }
    const result = await runOfferScheduler(getDb());
    for (const failure of result.failures) {
      Sentry.captureMessage("Offer scheduler transition failed", {
        level: "error",
        tags: { cron: "offers", stage: failure.stage, shop: failure.shopDomain },
        extra: failure,
      });
    }
    const codeSchedule = await runDiscountCodeSchedule(getDb());
    for (const failure of codeSchedule.failures) {
      Sentry.captureMessage("Discount code schedule publish failed", {
        level: "error",
        tags: { cron: "offers", stage: "discount-codes", shopId: failure.shopId },
        extra: failure,
      });
    }
    // Last: after the publishes above, so a shop they just fixed is not reported as drifted.
    // runDiscountDriftRepair raises its own Sentry alerts (repaired / unresolved / failed).
    const drift = await runDiscountDriftRepair();
    const hasFailures =
      reconciliation.failures.length > 0 ||
      result.failures.length > 0 ||
      codeSchedule.failures.length > 0 ||
      drift.unresolved.length > 0 ||
      drift.failures.length > 0;
    // These are captureMessage, not thrown exceptions, so runCron's check-in flush is
    // what gets them out before Vercel freezes the function.
    return { body: { ok: !hasFailures, timezones, reconciliation, codeSchedule, drift, ...result }, status: hasFailures ? 207 : 200 };
  });
}
