import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { runOfferScheduler } from "../lib/offer-scheduling.server.js";

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

  const result = await runOfferScheduler(getDb());
  return Response.json({ ok: true, ...result });
}
