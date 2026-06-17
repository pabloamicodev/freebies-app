import type { LoaderFunctionArgs } from "react-router";
import { cleanupOldAnalyticsEvents } from "../lib/sync/analytics-reconcile.server.js";

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env["CRON_SECRET"];
  if (!cronSecret) {
    console.error("[cron] CRON_SECRET env var is not set. All cron requests will be rejected until it is configured.");
    return false;
  }

  const url = new URL(request.url);
  return (
    request.headers.get("authorization") === `Bearer ${cronSecret}` ||
    request.headers.get("x-vercel-cron-secret") === cronSecret ||
    url.searchParams.get("secret") === cronSecret
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deleted = await cleanupOldAnalyticsEvents();
  return Response.json({ ok: true, deleted });
}
