import type { LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { runOfferScheduler } from "../lib/offer-scheduling.server.js";

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;
  return request.headers.get("x-vercel-cron") === "1";
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runOfferScheduler(getDb());
  return Response.json({ ok: true, ...result });
}
