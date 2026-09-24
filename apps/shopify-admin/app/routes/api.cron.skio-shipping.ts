import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import * as Sentry from "@sentry/node";
import { runAllSkioShippingSyncs } from "../lib/skio-shipping-cron.server.js";

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron:skio-shipping] CRON_SECRET is not configured.");
    return false;
  }
  return request.headers.get("authorization") === `Bearer ${cronSecret}`
    || request.headers.get("x-vercel-cron-secret") === cronSecret;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await runAllSkioShippingSyncs(getDb());
    return Response.json({ ok: result.shopsFailed === 0, ...result }, { status: result.shopsFailed > 0 ? 207 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Sentry.captureException(error, { tags: { cron: "skio-shipping" } });
    console.error("[cron:skio-shipping]", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
