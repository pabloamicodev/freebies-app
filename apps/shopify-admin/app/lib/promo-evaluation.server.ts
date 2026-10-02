import { EvaluationInputSchema, EvaluationResultSchema, type EvaluationInput, type EvaluationResult } from "@promo/shared-types";
import { evaluate, type OfferDefinition } from "@promo/rule-engine";
import { analyticsEvents, type Db } from "@promo/db";
import { and, eq, inArray, count } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { checkRateLimit, getClientIp } from "./rate-limit.server.js";
import { getOfferDefinitions } from "./offer-definitions.server.js";
import { applyCodeGatesDetailed, MISSED_CODE_WINDOW_MS } from "./code-gate.server.js";
import { resolveCustomer } from "./resolve-customer.server.js";
import { buildUpsells } from "./upsell-enrichment.server.js";
import {
  collectGiftCatalogVariantIds,
  enrichGiftSlider,
  loadGiftCatalogData,
  loadGiftSliderTranslations,
  resolveSoldOutGiftAdds,
} from "./gift-enrichment.server.js";
import { withVolumeDiscountTiers } from "./volume-discount-tiers.server.js";
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

const DEFAULT_SPECIFIC_LINK_PARAM = "freegifts_code";
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Query params the storefront runtime may keep in stored line metadata (D4): every active specific_link paramName. */
export function collectSpecificLinkParams(offerDefinitions: OfferDefinition[]): string[] {
  const names = new Set<string>([DEFAULT_SPECIFIC_LINK_PARAM]);
  for (const offer of offerDefinitions) {
    for (const condition of offer.conditions) {
      if (!condition.isEnabled || condition.conditionType !== "specific_link") continue;
      const value = condition.value as { paramName?: unknown; param?: unknown; key?: unknown } | null;
      const name = value?.paramName ?? value?.param ?? value?.key;
      if (typeof name === "string" && PARAM_NAME.test(name)) names.add(name);
    }
  }
  return [...names];
}

/**
 * Prime Day kill switch (docs/RUNBOOK.md): ENABLE_STOREFRONT_RUNTIME=false answers every evaluation with an
 * inert result (no cart actions, no sliders, no DB or Redis work) so the storefront widgets go quiet instantly
 * after a redeploy. Checkout discounts are unaffected: they run in the Shopify Functions. Unset = enabled.
 */
export function storefrontRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env["ENABLE_STOREFRONT_RUNTIME"]?.trim() ?? "");
}

function inertResult(): EvaluationResult {
  return {
    requestId: crypto.randomUUID(),
    cartHash: "disabled",
    qualifiedOffers: [],
    disqualifiedOffers: [],
    cartActions: [],
    discountCodes: { add: [], remove: [] },
    giftSlider: null,
    additionalGiftSliders: [],
    cartMessages: [],
    progressBars: [],
    upsells: [],
    warnings: [{ code: "STOREFRONT_RUNTIME_DISABLED", message: "Storefront evaluation is switched off." }],
    evaluatedAt: new Date().toISOString(),
  };
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
/** Server-Timing phases (ms) so slow evaluations can be attributed from the browser or logs. */
export function createPhaseTimer(initial: [string, number][] = []) {
  const phases = [...initial];
  let last = performance.now();
  return {
    mark(name: string) {
      const now = performance.now();
      phases.push([name, now - last]);
      last = now;
    },
    header() {
      return phases.map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`).join(", ");
    },
    total() {
      return phases.reduce((sum, [, ms]) => sum + ms, 0);
    },
  };
}

const SLOW_EVALUATION_MS = 1_500;

type RateLimitResult = Awaited<ReturnType<typeof checkRateLimit>>;

/**
 * Shop-wide evaluate ceiling per minute. Capacity estimate (confirm with scripts/load/evaluate.k6.js):
 * a Prime Day peak of ~1,500 concurrent shoppers x ~6 evaluations/min is ~9,000/min (150 rps). With the
 * Redis-cached definitions each evaluation costs about 3 indexed queries, ~450 qps against Neon's pooler,
 * and ~25 concurrent function instances at ~150 ms. 12,000 leaves ~30% headroom above that peak and
 * stops a runaway client loop. Override per project with EVALUATE_SHOP_LIMIT_PER_MINUTE.
 */
export const EVALUATE_SHOP_LIMIT_PER_MINUTE = Number(process.env["EVALUATE_SHOP_LIMIT_PER_MINUTE"]) || 12_000;
export const EVALUATE_CALLER_LIMIT_PER_MINUTE = 120;
export const EVALUATE_IP_LIMIT_PER_MINUTE = 600;

export async function handleEvaluationRequest(
  request: Request,
  shop: EvaluationShop,
  loggedInCustomerId: string | null,
  timer = createPhaseTimer(),
  options: { viaAppProxy?: boolean } = {},
): Promise<Response> {
  if (!storefrontRuntimeEnabled()) return apiJson(request, { ...inertResult(), specificLinkParams: [] });
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

  // D10: limits are keyed by shop + the verified customer and by shop + cart token. The client IP is
  // only a secondary key for direct callers (checkout extension): behind the app proxy it is
  // Shopify's egress address, which would merge every visitor into one bucket. The shop-wide
  // ceiling uses a fixed-window counter (O(1)) because its cap is high.
  timer.mark("body");
  const cartToken = parsed.data.cart.token;
  const clientIp = options.viaAppProxy ? null : getClientIp(request);
  const checks: Array<{ message: string; result: Promise<RateLimitResult> }> = [
    {
      message: "Too many evaluation requests for this shop.",
      result: checkRateLimit(`evaluate:shop:${shop.id}`, {
        limit: EVALUATE_SHOP_LIMIT_PER_MINUTE,
        windowMs: 60_000,
        fixedWindow: true,
      }),
    },
  ];
  const caller = { limit: EVALUATE_CALLER_LIMIT_PER_MINUTE, windowMs: 60_000 };
  if (loggedInCustomerId) checks.push({ message: "Too many evaluation requests.", result: checkRateLimit(`evaluate:${shop.id}:c:${loggedInCustomerId}`, caller) });
  if (cartToken) checks.push({ message: "Too many evaluation requests.", result: checkRateLimit(`evaluate:${shop.id}:t:${cartToken}`, caller) });
  if (clientIp && clientIp !== "unknown") {
    checks.push({ message: "Too many evaluation requests.", result: checkRateLimit(`evaluate:${shop.id}:ip:${clientIp}`, { limit: EVALUATE_IP_LIMIT_PER_MINUTE, windowMs: 60_000 }) });
  }
  const results = await Promise.all(checks.map((check) => check.result));
  timer.mark("ratelimit");
  const blocked = results.findIndex((result) => !result.ok);
  if (blocked >= 0) {
    const result = results[blocked] as { ok: false; retryAfterSeconds: number };
    return apiError(request, {
      status: 429,
      code: "RATE_LIMITED",
      message: checks[blocked]!.message,
      retryable: true,
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }

  const [rawOfferDefinitions, shadowModeEnabled] = await Promise.all([
    getOfferDefinitions(shop.id, shop.db),
    isShadowModeEnabled(shop.id),
  ]);
  // Offers that own discount codes only qualify while one of their codes is applied.
  const gate = await applyCodeGatesDetailed(shop.id, shop.db, rawOfferDefinitions, parsed.data.cart.discountCodes, new Date(), {
    rateLimitKey: parsed.data.cart.token ?? loggedInCustomerId ?? undefined,
  });
  if (gate.blocked) {
    return apiError(request, {
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many invalid discount codes. Try again later.",
      retryable: true,
      retryAfterSeconds: Math.ceil(MISSED_CODE_WINDOW_MS / 1000),
    });
  }
  const offerDefinitions = gate.definitions;
  timer.mark("offers");

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
  timer.mark("customer");

  const needsVolumeTiers = offerDefinitions.some((offer) =>
    offer.conditions.some((condition) => condition.isEnabled && condition.conditionType === "cart_value"),
  );
  const input: EvaluationInput = {
    ...parsed.data,
    cart: await withVolumeDiscountTiers(shop.db, shop.id, parsed.data.cart, needsVolumeTiers),
    shopDomain: shop.shopDomain,
    customer,
  };

  const result = await evaluate(input, {
    offers: offerDefinitions,
    oneUseStates,
    now: new Date(),
    shopCurrencyCode: shop.currencyCode ?? undefined,
  });
  timer.mark("evaluate");

  // enrichGiftSlider and resolveSoldOutGiftAdds both need pricing/stock for
  // largely the same gift + fallback variants — one shared query instead of
  // each hitting the database on its own.
  const rawLocale = (body as { locale?: unknown } | null)?.locale;
  const locale = typeof rawLocale === "string" && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(rawLocale) ? rawLocale : "en";
  const [giftCatalog, upsells, giftLabels] = await Promise.all([
    loadGiftCatalogData(shop.id, [
      ...collectGiftCatalogVariantIds(result.giftSlider, result.cartActions, offerDefinitions),
      ...(result.additionalGiftSliders ?? []).flatMap((slider) => collectGiftCatalogVariantIds(slider, [], offerDefinitions)),
    ]),
    buildUpsells(shop.id, result.qualifiedOffers, offerDefinitions),
    result.giftSlider || result.additionalGiftSliders?.length ? loadGiftSliderTranslations(shop.id, locale).catch(() => null) : Promise.resolve(null),
  ]);
  timer.mark("enrich");
  result.upsells = upsells;
  result.giftSlider = enrichGiftSlider(giftCatalog, result.giftSlider, offerDefinitions, input.cart.lines, giftLabels);
  result.additionalGiftSliders = (result.additionalGiftSliders ?? []).flatMap((slider) => {
    const enriched = enrichGiftSlider(giftCatalog, slider, offerDefinitions, input.cart.lines, giftLabels);
    return enriched ? [enriched] : [];
  });
  result.cartActions = resolveSoldOutGiftAdds(giftCatalog, result.cartActions, offerDefinitions);

  // Shadow mode: log what WOULD have happened during the BOGOS migration
  // window, but never actually mutate the customer's cart.
  if (shadowModeEnabled) {
    result.cartActions = [];
    result.discountCodes = { add: [], remove: [] };
    result.giftSlider = null;
    result.additionalGiftSliders = [];
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

  timer.mark("serialize");
  if (timer.total() > SLOW_EVALUATION_MS) {
    console.warn(`[evaluate] slow ${timer.total().toFixed(0)}ms shop=${shop.id} ${timer.header()}`);
  }
  return apiJson(request, { ...parsedResult.data, specificLinkParams: collectSpecificLinkParams(offerDefinitions) }, { headers: { "Server-Timing": timer.header() } });
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
