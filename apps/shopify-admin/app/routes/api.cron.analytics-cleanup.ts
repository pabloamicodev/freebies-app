import type { LoaderFunctionArgs } from "react-router";
import { cleanupOldAnalyticsEvents } from "../lib/sync/analytics-reconcile.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const secret = request.headers.get("x-vercel-cron-secret") ?? new URL(request.url).searchParams.get("secret");
  if (secret !== process.env["CRON_SECRET"]) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deleted = await cleanupOldAnalyticsEvents();
  return Response.json({ ok: true, deleted });
}
