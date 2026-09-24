import type { LoaderFunctionArgs } from "react-router";
import * as Sentry from "@sentry/node";
import { isCronRequestAuthorized } from "../lib/cron-auth.server.js";
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";
import { drainProductSyncQueue } from "../lib/sync/product-sync.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isCronRequestAuthorized(request)) {
    return apiError(request, { status: 401, code: "UNAUTHORIZED", message: "Unauthorized." });
  }
  try {
    const result = await drainProductSyncQueue({ maxSteps: 6, maxRuntimeMs: 45_000 });
    return apiJson(request, { ok: true, processedSteps: result.steps });
  } catch (error) {
    Sentry.captureException(error, { tags: { cron: "catalog-sync" } });
    return handleApiError(request, error, "cron.catalog-sync");
  }
}
