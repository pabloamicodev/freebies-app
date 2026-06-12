import type {
  EvaluationInput,
  EvaluationResult,
  EvaluatedOffer,
  CartAction,
  EligibilityReason,
} from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";
import { buildCartHash, extractGiftLines } from "./cart-parser.js";
import { evaluateCartValue } from "./conditions/cart-value.js";
import { evaluateCartQuantity } from "./conditions/cart-quantity.js";
import { evaluateSpecificProduct } from "./conditions/specific-product.js";
import {
  evaluateCustomerTags,
  evaluateOrderHistory,
  evaluateOneUsePerCustomer,
  evaluateSalesChannel,
  evaluateMarket,
} from "./conditions/customer.js";
import { evaluateCartValueMultiplier } from "./conditions/cart-value-multiplier.js";
import { evaluatePack } from "./conditions/pack.js";
import { evaluateProductQuantityLimits } from "./conditions/product-quantity-limits.js";
import { evaluateSubscriptionCondition } from "./conditions/subscription.js";
import { evaluateUrlParam } from "./conditions/url-param.js";
import { evaluateCountry } from "./conditions/country.js";
import { applyPriority } from "./priority-resolver.js";

/**
 * Offer definition passed into the evaluator — loaded from DB + compiled config.
 * This is a minimal in-memory representation for evaluation.
 */
export interface OfferDefinition {
  id: string;
  version: number;
  type: string;
  priority: number;
  stopLowerPriority: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  conditions: ConditionDefinition[];
  rewards: RewardDefinition[];
  combinationPolicy: CombinationPolicyDefinition;
  giftValueCountsForOtherOffers: boolean;
}

export interface ConditionDefinition {
  id: string;
  scope: "main" | "sub" | "quantity_limit" | "visibility";
  conditionType: string;
  operator: string;
  value: unknown;
  isEnabled: boolean;
  sortOrder: number;
}

export interface RewardDefinition {
  id: string;
  rewardType: string;
  discountType: string;
  value: unknown;
  target: unknown;
  quantity: number | null;
  isAutoAdd: boolean;
  isCustomerSelectable: boolean;
  trackMode: "product" | "variant";
  sortOrder: number;
  label: string | null;
}

export interface CombinationPolicyDefinition {
  combinesWithOrderDiscounts: boolean;
  combinesWithProductDiscounts: boolean;
  combinesWithShippingDiscounts: boolean;
  stopLowerPriority: boolean;
  maxApplicationsPerCart: number | null;
  maxApplicationsPerCustomer: number | null;
}

export interface OneUseState {
  offerId: string;
  usedCount: number;
}

export interface EvaluatorContext {
  offers: OfferDefinition[];
  oneUseStates: OneUseState[];
  now: Date;
  /** Shop's base currency code — used to determine if a currency conversion is needed. */
  shopCurrencyCode?: string;
}

/**
 * Main evaluation function.
 * Pure — no side effects, no network calls.
 * Same input → same output always.
 */
export async function evaluate(
  input: EvaluationInput,
  ctx: EvaluatorContext,
): Promise<EvaluationResult> {
  const requestId = crypto.randomUUID();
  const cartHash = await buildCartHash(input.cart);
  const now = ctx.now;

  const qualifiedOffers: EvaluatedOffer[] = [];
  const disqualifiedOffers: EvaluatedOffer[] = [];

  // ── Step 1: Evaluate each offer ───────────────────────────────────────────

  for (const offer of ctx.offers) {
    const reasons: EligibilityReason[] = [];
    let passed = true;

    // Schedule check
    if (offer.startsAt && now < offer.startsAt) {
      reasons.push({ conditionType: "schedule", passed: false, message: "Offer not yet started" });
      passed = false;
    }
    if (offer.endsAt && now > offer.endsAt) {
      reasons.push({ conditionType: "schedule", passed: false, message: "Offer has expired" });
      passed = false;
    }

    if (!passed) {
      disqualifiedOffers.push({
        offerId: offer.id,
        offerVersion: offer.version,
        type: offer.type,
        qualified: false,
        reasons,
        cartActions: [],
        discountCodesToAdd: [],
        discountCodesToRemove: [],
      });
      continue;
    }

    // Evaluate enabled conditions in order
    const mainConditions = offer.conditions
      .filter((c) => c.scope === "main" && c.isEnabled)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    const subConditions = offer.conditions
      .filter((c) => c.scope === "sub" && c.isEnabled)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    const currency = {
      activeCurrencyCode: input.market?.currencyCode ?? input.cart.currencyCode,
      shopCurrencyCode: ctx.shopCurrencyCode ?? input.cart.currencyCode,
      exchangeRate: input.market?.exchangeRate ?? undefined,
    };

    // Evaluate main conditions
    for (const cond of mainConditions) {
      const result = evaluateCondition(cond, input, currency);
      reasons.push(result.ok ? result.value : result.error);
      if (!result.ok) passed = false;
    }

    // Only evaluate sub-conditions if main passed
    if (passed) {
      for (const cond of subConditions) {
        // One-use-per-customer
        if (cond.conditionType === "one_use_per_customer") {
          const state = ctx.oneUseStates.find((s) => s.offerId === offer.id);
          const result = evaluateOneUsePerCustomer(input.customer, {
            usedCount: state?.usedCount ?? 0,
          });
          reasons.push(result.ok ? result.value : result.error);
          if (!result.ok) passed = false;
          continue;
        }
        const result = evaluateCondition(cond, input, currency);
        reasons.push(result.ok ? result.value : result.error);
        if (!result.ok) passed = false;
      }
    }

    const cartActions: CartAction[] = [];
    const discountCodesToAdd: string[] = [];
    const discountCodesToRemove: string[] = [];

    if (passed) {
      // Generate cart actions for rewards
      for (const reward of offer.rewards.sort((a, b) => a.sortOrder - b.sortOrder)) {
        if (reward.rewardType === "product_gift" && reward.isAutoAdd) {
          const target = reward.target as { variantId?: string; variantIds?: string[] };
          const variantIds = target.variantIds ?? (target.variantId ? [target.variantId] : []);
          const qty = reward.quantity ?? 1;

          for (const variantId of variantIds) {
            const existingGifts = extractGiftLines(input.cart).filter(
              (g) => g.offerId === offer.id && g.variantId === variantId,
            );
            const existingQty = existingGifts.reduce((acc, g) => acc + g.quantity, 0);

            if (existingQty < qty) {
              cartActions.push({
                action: "add_line",
                variantId,
                quantity: qty - existingQty,
                properties: {
                  _promo_engine_line_type: "gift",
                  _promo_engine_offer_id: offer.id,
                  _promo_engine_offer_version: String(offer.version),
                  _promo_engine_reward_id: reward.id,
                  _promo_engine_hash: "", // populated by server before sending to client
                },
              });
            } else if (existingQty > qty) {
              const toUpdate = existingGifts[0];
              if (toUpdate) {
                cartActions.push({
                  action: "update_line",
                  lineKey: toUpdate.lineKey,
                  quantity: qty,
                });
              }
            }
          }
        }
      }
    } else {
      // Remove existing gift lines from this offer since offer no longer qualifies
      const existingGifts = extractGiftLines(input.cart).filter((g) => g.offerId === offer.id);
      for (const gift of existingGifts) {
        cartActions.push({
          action: "remove_line",
          lineKey: gift.lineKey,
          reason: "offer_disqualified",
        });
      }
    }

    const evaluated: EvaluatedOffer = {
      offerId: offer.id,
      offerVersion: offer.version,
      type: offer.type,
      qualified: passed,
      reasons,
      cartActions,
      discountCodesToAdd,
      discountCodesToRemove,
    };

    if (passed) {
      qualifiedOffers.push(evaluated);
    } else {
      disqualifiedOffers.push(evaluated);
    }
  }

  // ── Step 2: Apply priority + stop-lower-priority ──────────────────────────

  const prioritized = applyPriority(
    qualifiedOffers.map((o) => ({
      offerId: o.offerId,
      priority: ctx.offers.find((def) => def.id === o.offerId)?.priority ?? 100,
      stopLowerPriority:
        ctx.offers.find((def) => def.id === o.offerId)?.stopLowerPriority ?? false,
      qualified: true,
    })),
  );

  const prioritizedIds = new Set(prioritized.map((p) => p.offerId));
  const finalQualified = qualifiedOffers.filter((o) => prioritizedIds.has(o.offerId));
  const blockedByPriority = qualifiedOffers.filter((o) => !prioritizedIds.has(o.offerId));

  for (const blocked of blockedByPriority) {
    // Move to disqualified with reason
    disqualifiedOffers.push({
      ...blocked,
      qualified: false,
      reasons: [
        ...blocked.reasons,
        {
          conditionType: "priority_stop",
          passed: false,
          message: "Blocked by higher-priority stop-lower-priority offer",
        },
      ],
    });
  }

  // ── Step 3: Aggregate all cart actions ────────────────────────────────────

  const allCartActions: CartAction[] = [
    ...finalQualified.flatMap((o) => o.cartActions),
    // Include remove_line from disqualified offers to clean up stale gift lines
    ...disqualifiedOffers.flatMap((o) =>
      o.cartActions.filter((a) => a.action === "remove_line"),
    ),
    ...blockedByPriority.flatMap((o) => {
      // Remove gifts from blocked offers
      return extractGiftLines(input.cart)
        .filter((g) => g.offerId === o.offerId)
        .map((g) => ({
          action: "remove_line" as const,
          lineKey: g.lineKey,
          reason: "blocked_by_priority",
        }));
    }),
  ];

  const codesToAdd = [...new Set(finalQualified.flatMap((o) => o.discountCodesToAdd))];
  const codesToRemove = [
    ...new Set([
      ...disqualifiedOffers.flatMap((o) => o.discountCodesToRemove),
      ...blockedByPriority.flatMap((o) => o.discountCodesToRemove),
    ]),
  ];

  return {
    requestId,
    cartHash,
    qualifiedOffers: finalQualified,
    disqualifiedOffers,
    cartActions: allCartActions,
    discountCodes: { add: codesToAdd, remove: codesToRemove },
    giftSlider: null, // populated by storefront layer for non-auto-add gifts
    cartMessages: [],
    progressBars: [],
    warnings: [],
    evaluatedAt: now.toISOString(),
  };
}

// ── Internal condition dispatcher ─────────────────────────────────────────────

function evaluateCondition(
  cond: ConditionDefinition,
  input: EvaluationInput,
  currency: { activeCurrencyCode: string; shopCurrencyCode: string; exchangeRate?: number },
): Result<EligibilityReason, EligibilityReason> {
  switch (cond.conditionType) {
    case "cart_value":
      return evaluateCartValue(input.cart, cond.value as any, currency);

    case "cart_quantity":
      return evaluateCartQuantity(input.cart, cond.value as any);

    case "specific_product":
      return evaluateSpecificProduct(input.cart, cond.value as any);

    case "customer_tags":
      return evaluateCustomerTags(input.customer, cond.value as any);

    case "order_history_total_spent":
    case "order_history_last_order_spent":
    case "order_history_total_orders":
      return evaluateOrderHistory(input.customer, cond.value as any);

    case "markets":
      return evaluateMarket(input.market?.id ?? null, cond.value as any);

    case "sales_channels":
      return evaluateSalesChannel(input.salesChannel, (cond.value as { channels: string[] }).channels);

    case "cart_value_multiplier":
      return evaluateCartValueMultiplier(input.cart, cond.value as any, currency);

    case "pack_of_products":
      return evaluatePack(input.cart, cond.value as any);

    case "product_quantity_limits":
    case "collection_quantity_limits":
    case "vendor_quantity_limits":
    case "product_type_quantity_limits":
      return evaluateProductQuantityLimits(input.cart, cond.value as any);

    case "subscription_product_type":
      return evaluateSubscriptionCondition(input.cart, cond.value as any);

    case "specific_link":
      return evaluateUrlParam(input.requestedUrl, cond.value as any);

    case "customer_location":
      return evaluateCountry(
        input.customer?.countryCode ?? input.market?.countryCode ?? null,
        cond.value as any,
      );

    default:
      return ok({
        conditionType: cond.conditionType,
        passed: true,
        message: `Condition type '${cond.conditionType}' not yet implemented — passing by default`,
      });
  }
}
