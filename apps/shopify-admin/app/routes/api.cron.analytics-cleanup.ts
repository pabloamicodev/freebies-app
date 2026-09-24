import type { LoaderFunctionArgs } from "react-router";
import { cleanupOldAnalyticsEvents } from "../lib/sync/analytics-reconcile.server.js";
import { cleanupOperationalState } from "../lib/operational-retention.server.js";
import { isCronRequestAuthorized } from "../lib/cron-auth.server.js";
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isCronRequestAuthorized(request)) {
    return apiError(request, { status: 401, code: "UNAUTHORIZED", message: "Unauthorized." });
  }

  try {
    const retentionDays = Number(process.env["ANALYTICS_RETENTION_DAYS"] ?? 90);
    const [analyticsDeleted, operational] = await Promise.all([
      cleanupOldAnalyticsEvents(Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 90),
      cleanupOperationalState(),
    ]);
    return apiJson(request, { ok: true, analyticsDeleted, operational });
  } catch (err) {
    return handleApiError(request, err, "cron.analytics-cleanup");
  }
}
