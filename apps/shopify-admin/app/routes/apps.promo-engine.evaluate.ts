import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { EvaluationInputSchema, EvaluationResultSchema, type EvaluationInput } from "@promo/shared-types";
import { evaluate } from "@promo/rule-engine";
import { analyticsEvents, type Db } from "@promo/db";
import { and, eq, inArray, count } from "drizzle-orm";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";
import { checkRateLimit, getClientIp } from "../lib/rate-limit.server.js";
import { getOfferDefinitions } from "../lib/offer-definitions.server.js";
import * as Sentry from "@sentry/node";

export function loader(_args: LoaderFunctionArgs) {
  throw new Response("Method not allowed", { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  const signedShop = await getSignedShop(request);
  const signedShopDomain = signedShop.shopDomain;
  const sessionKey = request.headers.get("x-promo-session") ?? getClientIp(request);
  const rateLimit = await checkRateLimit(`evaluate:${signedShop.id}:${sessionKey}`, { limit: 120, windowMs: 60_000 });
  if (!rateLimit.ok) {
    return Response.json(
      { error: "Too many evaluation requests" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = EvaluationInputSchema.safeParse({
    ...(body ?? {}),
    shopDomain: signedShopDomain,
  });

  if (!parsed.success) {
    return Response.json({ error: "Invalid evaluation payload" }, { status: 400 });
  }

  const offerDefinitions = await getOfferDefinitions(signedShop.id, signedShop.db);

  const input: EvaluationInput = {
    ...parsed.data,
    shopDomain: signedShopDomain,
  };

  const result = await evaluate(input, {
    offers: offerDefinitions,
    oneUseStates: await getOneUseStates(signedShop.id, signedShop.db, input.customer?.id ?? null, offerDefinitions.map((offer) => offer.id)),
    now: new Date(),
    shopCurrencyCode: signedShop.currencyCode ?? undefined,
  });

  const parsedResult = EvaluationResultSchema.safeParse(result);
  if (!parsedResult.success) {
    const err = new Error("Generated invalid evaluation result");
    console.error("[evaluate]", err.message, { shopId: signedShop.id, issues: parsedResult.error.issues });
    Sentry.captureException(err, { extra: { shopId: signedShop.id, issues: parsedResult.error.issues } });
    return Response.json({ error: "Invalid evaluation result" }, { status: 500 });
  }

  return Response.json(parsedResult.data);
}

async function getOneUseStates(
  shopId: string,
  db: Db,
  customerId: string | null,
  offerIds: string[],
) {
  if (!customerId || offerIds.length === 0) return [];
  const rows: { offerId: string | null; usedCount: number }[] = await db
    .select({ offerId: analyticsEvents.offerId, usedCount: count() })
    .from(analyticsEvents)
    .where(and(
      eq(analyticsEvents.shopId, shopId),
      eq(analyticsEvents.customerId, customerId),
      inArray(analyticsEvents.offerId, offerIds),
      inArray(analyticsEvents.eventName, ["promo_engine:gift_auto_added", "promo_engine:offer_redeemed", "promo_engine:checkout_completed"]),
    ))
    .groupBy(analyticsEvents.offerId);

  return rows.flatMap((row) => row.offerId ? [{ offerId: row.offerId, usedCount: row.usedCount }] : []);
}
