import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { runOfferScheduler } from "../lib/offer-scheduling.server.js";
import * as Sentry from "@sentry/node";

function getCronSecret(): string | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // Misconfigured — reject rather than fall through to a forgeable header.
    console.error("[cron] CRON_SECRET env var is not set. All cron requests will be rejected until it is configured.");
    return null;
  }
  return cronSecret;
}

function isAuthorized(request: Request): boolean {
  const cronSecret = getCronSecret();
  if (!cronSecret) return false;

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
    const result = await runOfferScheduler(getDb());
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Sentry.captureException(err, { tags: { cron: "offers" } });
    console.error("[cron:offers]", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
