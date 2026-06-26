import type { LoaderFunctionArgs } from "react-router";
import { cleanupOldAnalyticsEvents } from "../lib/sync/analytics-reconcile.server.js";
import * as Sentry from "@sentry/node";

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env["CRON_SECRET"];
  if (!cronSecret) {
    console.error("[cron] CRON_SECRET env var is not set. All cron requests will be rejected until it is configured.");
    return false;
  }

  return (
    request.headers.get("authorization") === `Bearer ${cronSecret}` ||
    request.headers.get("x-vercel-cron-secret") === cronSecret
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const retentionDays = Number(process.env["ANALYTICS_RETENTION_DAYS"] ?? 90);
    const deleted = await cleanupOldAnalyticsEvents(Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 90);
    return Response.json({ ok: true, deleted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Sentry.captureException(err, { tags: { cron: "analytics-cleanup" } });
    console.error("[cron:analytics-cleanup]", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
