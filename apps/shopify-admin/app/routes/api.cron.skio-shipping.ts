import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import * as Sentry from "@sentry/node";
import { waitUntil } from "@vercel/functions";
import { runAllSkioShippingSyncs } from "../lib/skio-shipping-cron.server.js";
import { isCronRequestAuthorized } from "../lib/cron-auth.server.js";
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isCronRequestAuthorized(request)) {
    return apiError(request, { status: 401, code: "UNAUTHORIZED", message: "Unauthorized." });
  }

  try {
    const result = await runAllSkioShippingSyncs(getDb());
    // Per-shop failures are captured inline (not thrown) so the loop can keep
    // going — flush here or Vercel can freeze the function before they send.
    if (result.shopsFailed > 0) waitUntil(Sentry.flush(2000));
    return apiJson(request, { ok: result.shopsFailed === 0, ...result }, { status: result.shopsFailed > 0 ? 207 : 200 });
  } catch (error) {
    return handleApiError(request, error, "cron.skio-shipping");
  }
}
