import { EvaluationInputSchema, EvaluationResultSchema, type EvaluationInput } from "@promo/shared-types";
import { evaluate, type OfferDefinition } from "@promo/rule-engine";
import { analyticsEvents, type Db } from "@promo/db";
import { and, eq, inArray, count } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { checkRateLimit, getClientIp } from "./rate-limit.server.js";
import { getOfferDefinitions } from "./offer-definitions.server.js";
import { resolveCustomer } from "./resolve-customer.server.js";
import { buildUpsells } from "./upsell-enrichment.server.js";
import { collectGiftCatalogVariantIds, enrichGiftSlider, loadGiftCatalogData, resolveSoldOutGiftAdds } from "./gift-enrichment.server.js";
import { isShadowModeEnabled } from "./shadow-mode.server.js";
import { apiError, apiJson, readJsonBody } from "./api-response.server.js";

const MAX_EVALUATION_BODY_BYTES = 256 * 1024;

// Conditions that need resolveCustomer's enriched Admin API profile
// (tags/spend/location). Mirrors packages/shared-types ConditionTypeSchema.
const CUSTOMER_DEPENDENT_CONDITION_TYPES = new Set<string>([
  "customer_tags",
  "customer_location",
  "order_history_total_spent",
  "order_history_last_order_spent",
  "order_history_total_orders",
  "one_use_per_customer",
]);

function needsCustomerProfile(offerDefinitions: OfferDefinition[]): boolean {
  return offerDefinitions.some((offer) =>
    offer.conditions.some(
      (condition) => condition.isEnabled && CUSTOMER_DEPENDENT_CONDITION_TYPES.has(condition.conditionType),
    ),
  );
}

function customerGidFromLoggedIn(loggedInCustomerId: string | null): string | null {
  return loggedInCustomerId && /^\d+$/.test(loggedInCustomerId)
    ? `gid://shopify/Customer/${loggedInCustomerId}`
    : null;
}

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
  // Shop-wide ceiling first — cheap (keyed only by shop, no body parsing
  // needed) so a flood against one shop is throttled before it can cost a
  // body read for every request.
  const shopRateLimit = await checkRateLimit(`evaluate:shop:${shop.id}`, { limit: 3_000, windowMs: 60_000 });
  if (!shopRateLimit.ok) {
    return apiError(request, {
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many evaluation requests for this shop.",
      retryable: true,
      retryAfterSeconds: shopRateLimit.retryAfterSeconds,
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

  // Keyed by the caller's actual identity, not IP: behind the app proxy the IP
  // can be Shopify's own, which would otherwise merge every anonymous visitor
  // into one shared bucket. Falls back to the cart token, then IP as a last
  // resort (e.g. no cart yet).
  const identity = loggedInCustomerId ?? parsed.data.cart.token ?? getClientIp(request);
  const rateLimit = await checkRateLimit(`evaluate:${shop.id}:${identity}`, { limit: 120, windowMs: 60_000 });
  if (!rateLimit.ok) {
    return apiError(request, {
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many evaluation requests.",
      retryable: true,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
  }

  const [offerDefinitions, shadowModeEnabled] = await Promise.all([
    getOfferDefinitions(shop.id, shop.db),
    isShadowModeEnabled(shop.id),
  ]);

  // resolveCustomer's Admin API round trip is only needed when some active
  // offer inspects the profile it fetches (tags/spend/location) — skip it
  // entirely otherwise. getOneUseStates needs a customer id too, but only to
  // key its own attributed-orders lookup: that's just the verified logged-in
  // id reconstructed as a GID, so it runs in parallel with resolveCustomer
  // instead of waiting on its (slower, more failure-prone) enriched profile.
  const customerGid = customerGidFromLoggedIn(loggedInCustomerId);
  const [customer, oneUseStates] = await Promise.all([
    needsCustomerProfile(offerDefinitions)
      ? resolveCustomer(shop.shopDomain, shop.accessTokenEncrypted, loggedInCustomerId)
      : Promise.resolve(null),
    getOneUseStates(shop.id, shop.db, customerGid, offerDefinitions.map((offer) => offer.id)),
  ]);

  const input: EvaluationInput = {
    ...parsed.data,
    shopDomain: shop.shopDomain,
    customer,
  };

  const result = await evaluate(input, {
    offers: offerDefinitions,
    oneUseStates,
    now: new Date(),
    shopCurrencyCode: shop.currencyCode ?? undefined,
  });

  // enrichGiftSlider and resolveSoldOutGiftAdds both need pricing/stock for
  // largely the same gift + fallback variants — one shared query instead of
  // each hitting the database on its own.
  const [giftCatalog, upsells] = await Promise.all([
    loadGiftCatalogData(shop.id, collectGiftCatalogVariantIds(result.giftSlider, result.cartActions, offerDefinitions)),
    buildUpsells(shop.id, result.qualifiedOffers, offerDefinitions),
  ]);
  result.upsells = upsells;
  result.giftSlider = enrichGiftSlider(giftCatalog, result.giftSlider, offerDefinitions, input.cart.lines);
  result.cartActions = resolveSoldOutGiftAdds(giftCatalog, result.cartActions, offerDefinitions);

  // Shadow mode: log what WOULD have happened during the BOGOS migration
  // window, but never actually mutate the customer's cart.
  if (shadowModeEnabled) {
    result.cartActions = [];
    result.discountCodes = { add: [], remove: [] };
    result.giftSlider = null;
  }

  // Targeting details (why an offer did/didn't qualify) are useful for the
  // merchant-facing offer preview but leak segmentation logic to the
  // storefront — strip them from this response. app.offers.$id.preview.tsx
  // calls the rule engine directly and is unaffected.
  result.disqualifiedOffers = result.disqualifiedOffers.map((offer) => ({ ...offer, reasons: [] }));

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
