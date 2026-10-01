import type { LoaderFunctionArgs } from "react-router";
import { isCronRequestAuthorized } from "../lib/cron-auth.server.js";
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";
import { reconcileAllShopsGiftVariants } from "../lib/sync/gift-stock-reconcile.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isCronRequestAuthorized(request)) {
    return apiError(request, { status: 401, code: "UNAUTHORIZED", message: "Unauthorized." });
  }
  try {
    return apiJson(request, { ok: true, ...(await reconcileAllShopsGiftVariants()) });
  } catch (error) {
    return handleApiError(request, error, "cron.gift-stock");
  }
}
