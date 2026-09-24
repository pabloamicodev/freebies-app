import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { runAllSkioShippingSyncs } from "../lib/skio-shipping-cron.server.js";
import { isCronRequestAuthorized } from "../lib/cron-auth.server.js";
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isCronRequestAuthorized(request)) {
    return apiError(request, { status: 401, code: "UNAUTHORIZED", message: "Unauthorized." });
  }

  try {
    const result = await runAllSkioShippingSyncs(getDb());
    return apiJson(request, { ok: result.shopsFailed === 0, ...result }, { status: result.shopsFailed > 0 ? 207 : 200 });
  } catch (error) {
    return handleApiError(request, error, "cron.skio-shipping");
  }
}
