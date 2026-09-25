import { EvaluationInputSchema, EvaluationResultSchema, type EvaluationInput } from "@promo/shared-types";
import { evaluate } from "@promo/rule-engine";
import { analyticsEvents, type Db } from "@promo/db";
import { and, eq, inArray, count } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { checkRateLimit, getClientIp } from "./rate-limit.server.js";
import { getOfferDefinitions } from "./offer-definitions.server.js";
import { resolveCustomer } from "./resolve-customer.server.js";
import { buildUpsells } from "./upsell-enrichment.server.js";
import { enrichGiftSlider } from "./gift-enrichment.server.js";
import { isShadowModeEnabled } from "./shadow-mode.server.js";
import { apiError, apiJson, readJsonBody } from "./api-response.server.js";

const MAX_EVALUATION_BODY_BYTES = 256 * 1024;

export interface EvaluationShop {
  id: string;
  shopDomain: string;
  currencyCode: string | null;
  accessTokenEncrypted: string;
  db: Db;
}

/**
 * Shared by the App Proxy (storefront) and the session-token checkout route.
 * `loggedInCustomerId` must come from a Shopify-verified source, never the body.
 */
export async function handleEvaluationRequest(
  request: Request,
  shop: EvaluationShop,
  loggedInCustomerId: string | null,
): Promise<Response> {
  // Keyed by IP, not the client-supplied X-Promo-Session header — a header the
  // caller sets can't be trusted to actually distinguish callers.
  const rateLimit = await checkRateLimit(`evaluate:${shop.id}:${getClientIp(request)}`, { limit: 120, windowMs: 60_000 });
  if (!rateLimit.ok) {
    return apiError(request, {
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many evaluation requests.",
      retryable: true,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
  }

  const body = await readJsonBody<unknown>(request, {
    maxBytes: MAX_EVALUATION_BODY_BYTES,
    tooLargeMessage: "Evaluation payload is too large.",
    invalidMessage: "Evaluation payload must be valid JSON.",
  });
  const parsed = EvaluationInputSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    shopDomain: shop.shopDomain,
  });

  if (!parsed.success) {
    return apiError(request, {
      status: 400,
      code: "INVALID_EVALUATION_PAYLOAD",
      message: "Evaluation payload failed validation.",
      details: { issues: parsed.error.issues },
    });
  }

  const [offerDefinitions, customer] = await Promise.all([
    getOfferDefinitions(shop.id, shop.db),
    resolveCustomer(shop.shopDomain, shop.accessTokenEncrypted, loggedInCustomerId),
  ]);

  const input: EvaluationInput = {
    ...parsed.data,
    shopDomain: shop.shopDomain,
    customer,
  };

  const result = await evaluate(input, {
    offers: offerDefinitions,
    oneUseStates: await getOneUseStates(shop.id, shop.db, customer?.id ?? null, offerDefinitions.map((offer) => offer.id)),
    now: new Date(),
    shopCurrencyCode: shop.currencyCode ?? undefined,
  });

  [result.upsells, result.giftSlider] = await Promise.all([
    buildUpsells(shop.id, result.qualifiedOffers, offerDefinitions),
    enrichGiftSlider(shop.id, result.giftSlider, offerDefinitions),
  ]);

  // Shadow mode: log what WOULD have happened during the BOGOS migration
  // window, but never actually mutate the customer's cart.
  if (await isShadowModeEnabled(shop.id)) {
    result.cartActions = [];
    result.discountCodes = { add: [], remove: [] };
    result.giftSlider = null;
  }

  const parsedResult = EvaluationResultSchema.safeParse(result);
  if (!parsedResult.success) {
    const error = new Error("Generated invalid evaluation result");
    Sentry.captureException(error, { extra: { shopId: shop.id, issues: parsedResult.error.issues } });
    return apiError(request, {
      status: 500,
      code: "INVALID_EVALUATION_RESULT",
      message: "The promotion evaluation produced an invalid result.",
      retryable: true,
    });
  }

  return apiJson(request, parsedResult.data);
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
