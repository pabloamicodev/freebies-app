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
import { apiError, apiJson, handleApiError, readJsonBody } from "../lib/api-response.server.js";

const MAX_EVALUATION_BODY_BYTES = 256 * 1024;

export function loader({ request }: LoaderFunctionArgs) {
  return apiError(request, {
    status: 405,
    code: "METHOD_NOT_ALLOWED",
    message: "Method not allowed.",
    headers: { Allow: "POST" },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return apiError(request, { status: 405, code: "METHOD_NOT_ALLOWED", message: "Method not allowed.", headers: { Allow: "POST" } });
  }
  try {
    const signedShop = await getSignedShop(request);
    const signedShopDomain = signedShop.shopDomain;
    // Keyed by IP, not the client-supplied X-Promo-Session header — a header the
    // caller sets can't be trusted to actually distinguish callers.
    const rateLimit = await checkRateLimit(`evaluate:${signedShop.id}:${getClientIp(request)}`, { limit: 120, windowMs: 60_000 });
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
      shopDomain: signedShopDomain,
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
      const error = new Error("Generated invalid evaluation result");
      Sentry.captureException(error, { extra: { shopId: signedShop.id, issues: parsedResult.error.issues } });
      return apiError(request, {
        status: 500,
        code: "INVALID_EVALUATION_RESULT",
        message: "The promotion evaluation produced an invalid result.",
        retryable: true,
      });
    }

    return apiJson(request, parsedResult.data);
  } catch (error) {
    return handleApiError(request, error, "apps.promo-engine.evaluate");
  }
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
