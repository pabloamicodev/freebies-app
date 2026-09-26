import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { runOfferScheduler } from "../lib/offer-scheduling.server.js";
import * as Sentry from "@sentry/node";
import { waitUntil } from "@vercel/functions";
import { isCronRequestAuthorized } from "../lib/cron-auth.server.js";
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";
import { reconcileActiveShopDiscountNodes } from "../lib/discount-reconciliation.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isCronRequestAuthorized(request)) {
    return apiError(request, { status: 401, code: "UNAUTHORIZED", message: "Unauthorized." });
  }

  try {
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
    const hasFailures = reconciliation.failures.length > 0 || result.failures.length > 0;
    if (hasFailures) {
      // These are captureMessage, not thrown exceptions, so nothing else on
      // this request path flushes them — without this Vercel can freeze the
      // function before the batch reaches Sentry.
      waitUntil(Sentry.flush(2000));
    }
    return apiJson(request, { ok: !hasFailures, reconciliation, ...result }, {
      status: hasFailures ? 207 : 200,
    });
  } catch (err) {
    return handleApiError(request, err, "cron.offers");
  }
}
