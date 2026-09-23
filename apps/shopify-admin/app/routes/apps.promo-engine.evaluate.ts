import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { EvaluationInputSchema, EvaluationResultSchema, type EvaluationInput } from "@promo/shared-types";
import { evaluate } from "@promo/rule-engine";
import { analyticsEvents, type Db } from "@promo/db";
import { and, eq, inArray, count } from "drizzle-orm";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";
import { checkRateLimit, getClientIp } from "../lib/rate-limit.server.js";
import { getOfferDefinitions } from "../lib/offer-definitions.server.js";
import { resolveCustomer } from "../lib/resolve-customer.server.js";
import { buildUpsells } from "../lib/upsell-enrichment.server.js";
import { enrichGiftSlider } from "../lib/gift-enrichment.server.js";
import { isShadowModeEnabled } from "../lib/shadow-mode.server.js";
import * as Sentry from "@sentry/node";

const MAX_EVALUATION_BODY_BYTES = 256 * 1024;

export function loader(_args: LoaderFunctionArgs) {
  throw new Response("Method not allowed", { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  const signedShop = await getSignedShop(request);
  const signedShopDomain = signedShop.shopDomain;
  // Keyed by IP, not the client-supplied X-Promo-Session header — a header the
  // caller sets can't be trusted to actually distinguish callers.
  const rateLimit = await checkRateLimit(`evaluate:${signedShop.id}:${getClientIp(request)}`, { limit: 120, windowMs: 60_000 });
  if (!rateLimit.ok) {
    return Response.json(
      { error: "Too many evaluation requests" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EVALUATION_BODY_BYTES) {
    return Response.json({ error: "Evaluation payload is too large" }, { status: 413 });
  }

  const rawBody = await request.text().catch(() => "");
  if (new TextEncoder().encode(rawBody).byteLength > MAX_EVALUATION_BODY_BYTES) {
    return Response.json({ error: "Evaluation payload is too large" }, { status: 413 });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return Response.json({ error: "Invalid evaluation payload" }, { status: 400 });
  }
  const parsed = EvaluationInputSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    shopDomain: signedShopDomain,
  });

  if (!parsed.success) {
    console.error("[evaluate] schema validation failed", JSON.stringify(parsed.error.issues));
    return Response.json({ error: "Invalid evaluation payload", issues: parsed.error.issues }, { status: 400 });
  }

  const [offerDefinitions, customer] = await Promise.all([
    getOfferDefinitions(signedShop.id, signedShop.db),
    resolveCustomer(signedShopDomain, signedShop.accessTokenEncrypted, signedShop.loggedInCustomerId),
  ]);

  const input: EvaluationInput = {
    ...parsed.data,
    shopDomain: signedShopDomain,
    customer,
  };

  const result = await evaluate(input, {
    offers: offerDefinitions,
    oneUseStates: await getOneUseStates(signedShop.id, signedShop.db, customer?.id ?? null, offerDefinitions.map((offer) => offer.id)),
    now: new Date(),
    shopCurrencyCode: signedShop.currencyCode ?? undefined,
  });

  [result.upsells, result.giftSlider] = await Promise.all([
    buildUpsells(signedShop.id, result.qualifiedOffers, offerDefinitions),
    enrichGiftSlider(signedShop.id, result.giftSlider, offerDefinitions),
  ]);

  // Shadow mode: log what WOULD have happened during the BOGOS migration
  // window, but never actually mutate the customer's cart.
  if (await isShadowModeEnabled(signedShop.id)) {
    result.cartActions = [];
    result.discountCodes = { add: [], remove: [] };
    result.giftSlider = null;
  }

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
  // Only count offers redeemed in a PAID order (written server-side by the
  // orders/paid webhook) — never a cart-side event, which a buyer can trigger
  // by adding the gift and abandoning, or spoof outright.
  const rows: { offerId: string | null; usedCount: number }[] = await db
    .select({ offerId: analyticsEvents.offerId, usedCount: count() })
    .from(analyticsEvents)
    .where(and(
      eq(analyticsEvents.shopId, shopId),
      eq(analyticsEvents.customerId, customerId),
      inArray(analyticsEvents.offerId, offerIds),
      eq(analyticsEvents.eventName, "order_placed_attributed"),
    ))
    .groupBy(analyticsEvents.offerId);

  return rows.flatMap((row) => row.offerId ? [{ offerId: row.offerId, usedCount: row.usedCount }] : []);
}
