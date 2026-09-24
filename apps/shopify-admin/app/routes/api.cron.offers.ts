import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { runOfferScheduler } from "../lib/offer-scheduling.server.js";
import * as Sentry from "@sentry/node";
import { isCronRequestAuthorized } from "../lib/cron-auth.server.js";
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isCronRequestAuthorized(request)) {
    return apiError(request, { status: 401, code: "UNAUTHORIZED", message: "Unauthorized." });
  }

  try {
    const result = await runOfferScheduler(getDb());
    for (const failure of result.failures) {
      Sentry.captureMessage("Offer scheduler transition failed", {
        level: "error",
        tags: { cron: "offers", stage: failure.stage, shop: failure.shopDomain },
        extra: failure,
      });
    }
    return apiJson(request, { ok: true, ...result });
  } catch (err) {
    return handleApiError(request, err, "cron.offers");
  }
}
