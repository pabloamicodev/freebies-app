import { and, eq, inArray } from "drizzle-orm";
import {
  offers,
  offerConditions,
  offerRewards,
  discountCodes,
  type Db,
  type OfferCondition,
  type OfferReward,
} from "@promo/db";
import {
  ConditionTypeSchema,
  FUNCTION_ENFORCED_CONDITION_TYPES,
  validateConditionValue,
  validateRewardPayload,
} from "@promo/shared-types";
import { publishOffersForShop } from "./sync/offer-publisher.server.js";
import { PAGE_CONDITION_TYPES } from "./sync/compile-config.js";
import { isCheckoutCodeGated, type CodeRedemptionMode } from "./code-redemption.js";
import { isCodeRedeemable } from "./discount-code-generation.js";
import { invalidateOfferDefinitions } from "./offer-definitions.server.js";
import { normalizeConditionValue } from "./offer-config-normalization.server.js";

export interface PublishValidationResult {
  ok: boolean;
  error?: string;
}

export const MIXED_ONCE_PER_CUSTOMER_MESSAGE = (offerName: string) =>
  `Cannot publish "${offerName}": some of its active codes are once-per-customer and others are not. Shopify applies that rule to a whole code discount, so make every active code once-per-customer, or none.`;

const FUNCTION_NUMERIC_OPERATORS = new Set(["eq", "gt", "gte", "lt", "lte"]);

function firstIssueMessage(result: {
  success: boolean;
  error?: { issues?: Array<{ message: string }> };
}): string {
  return result.error?.issues?.[0]?.message ?? "Invalid offer configuration.";
}

export function isConditionEnforcedByFunction(conditionType: string): boolean {
  return (FUNCTION_ENFORCED_CONDITION_TYPES as ReadonlySet<string>).has(conditionType);
}

const PRODUCT_DISCOUNT_REWARD_TYPES = new Set([
  "product_discount",
  "bundle_discount",
  "upsell_discount",
]);

/**
 * "tagged_offer" and "quiz_bundle" rewards apply to whatever line carries a
 * client-set attribute (a required offer id / quiz bundle id) — there's no
 * server-verified anchor like `specific_product` gives other scope modes. If
 * such a reward has no product/variant allowlist, a shopper could set that
 * attribute on an arbitrary line and unlock the discount on it. (Landing
 * rewards are intentionally excluded — those anchors are enforced elsewhere.)
 */
export function isUnscopedTaggedReward(rewardType: string, target: unknown): boolean {
  if (!PRODUCT_DISCOUNT_REWARD_TYPES.has(rewardType)) return false;
  const t = (target && typeof target === "object" ? target : {}) as Record<string, unknown>;
  if (t.scopeMode !== "tagged_offer" && t.scopeMode !== "quiz_bundle") return false;
  const hasAllowlist =
    Boolean(t.productId) ||
    Boolean((t.productIds as unknown[] | undefined)?.length) ||
    Boolean(t.variantId) ||
    Boolean((t.variantIds as unknown[] | undefined)?.length);
  return !hasAllowlist;
}

/** The Function computes cart value/quantity over every non-excluded line;
 * only `excludeProductIds` of a scopeFilter compiles through. */
export function hasUnenforcedScopeFilter(value: unknown): boolean {
  const filter = (value as { scopeFilter?: Record<string, unknown> } | null)?.scopeFilter;
  if (!filter || typeof filter !== "object") return false;
  return Object.entries(filter).some(
    ([key, list]) => key !== "excludeProductIds" && Array.isArray(list) && list.length > 0,
  );
}

export async function validateOffersPublishable(
  db: Db,
  shopId: string,
  offerIds: string[],
): Promise<PublishValidationResult> {
  if (offerIds.length === 0) return { ok: true };

  const [offerRows, conditionRows, rewardRows, codeRows]: [
    { id: string; internalName: string; requiredDiscountCode: string | null; requiresCode: boolean; codeRedemption: CodeRedemptionMode }[],
    OfferCondition[],
    OfferReward[],
    Array<{
      offerId: string;
      status: string;
      startsAt: Date | null;
      endsAt: Date | null;
      usageLimit: number | null;
      usageCount: number;
      oncePerCustomer: boolean;
    }>,
  ] = await Promise.all([
    db
      .select({
        id: offers.id,
        internalName: offers.internalName,
        requiredDiscountCode: offers.requiredDiscountCode,
        requiresCode: offers.requiresCode,
        codeRedemption: offers.codeRedemption,
      })
      .from(offers)
      .where(and(eq(offers.shopId, shopId), inArray(offers.id, offerIds))),
    db
      .select()
      .from(offerConditions)
      .where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, offerIds))),
    db
      .select()
      .from(offerRewards)
      .where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, offerIds))),
    db
      .select({
        offerId: discountCodes.offerId,
        status: discountCodes.status,
        startsAt: discountCodes.startsAt,
        endsAt: discountCodes.endsAt,
        usageLimit: discountCodes.usageLimit,
        usageCount: discountCodes.usageCount,
        oncePerCustomer: discountCodes.oncePerCustomer,
      })
      .from(discountCodes)
      .where(and(eq(discountCodes.shopId, shopId), inArray(discountCodes.offerId, offerIds))),
  ]);
  const offersWithCodes = new Set(codeRows.map((row) => row.offerId));
  const now = new Date();

  const foundIds = new Set(offerRows.map((offer) => offer.id));
  for (const offerId of offerIds) {
    if (!foundIds.has(offerId)) return { ok: false, error: "Offer not found." };
  }

  for (const offer of offerRows) {
    // Gated by its own codes (or a legacy required checkout code).
    const isCodeOffer = isCheckoutCodeGated(offer, offersWithCodes.has(offer.id));
    const conditions = conditionRows.filter((condition) => condition.offerId === offer.id);
    const eligibilityConditions = conditions.filter(
      (condition) => condition.scope === "main" || condition.scope === "sub",
    );
    const rewards = rewardRows.filter((reward) => reward.offerId === offer.id);
    const mainConditions = eligibilityConditions.filter(
      (condition) => condition.scope === "main" && condition.isEnabled,
    );

    // A code-gated offer is already gated by its Shopify checkout
    // codes — Shopify only invokes the Function when that code is present on
    // the cart — so it doesn't need an additional enabled main condition to
    // be safely publishable, unlike every other offer.
    if (mainConditions.length === 0 && !isCodeOffer) {
      return {
        ok: false,
        error: `Cannot publish "${offer.internalName}": add at least one enabled main condition.`,
      };
    }
    if (rewards.length === 0) {
      return {
        ok: false,
        error: `Cannot publish "${offer.internalName}": add at least one reward.`,
      };
    }

    // Shopify applies once-per-customer to the whole code discount, so a node can't carry both
    // kinds of code: the rule would silently be dropped for the once-per-customer ones.
    // Automatic offers have no code node (their codes are paused), so the rule can't conflict.
    const liveCodes = isCodeOffer ? codeRows.filter((row) => row.offerId === offer.id && isCodeRedeemable(row, now)) : [];
    if (liveCodes.some((row) => row.oncePerCustomer) && liveCodes.some((row) => !row.oncePerCustomer)) {
      return {
        ok: false,
        error: MIXED_ONCE_PER_CUSTOMER_MESSAGE(offer.internalName),
      };
    }

    if (rewards.some((reward) => reward.rewardType === "shipping_discount")) {
      const unsupportedShippingCondition = eligibilityConditions.find(
        (condition) =>
          condition.isEnabled &&
          condition.conditionType !== "cart_value" &&
          !(PAGE_CONDITION_TYPES as readonly string[]).includes(condition.conditionType),
      );
      if (unsupportedShippingCondition) {
        return {
          ok: false,
          error: `Cannot publish "${offer.internalName}": shipping discounts do not yet support the ${unsupportedShippingCondition.conditionType} condition in Shopify Functions.`,
        };
      }
    }

    if (
      eligibilityConditions.some(
        (condition) => condition.isEnabled && condition.conditionType === "discount_code",
      )
    ) {
      return {
        ok: false,
        error: `Cannot publish "${offer.internalName}": it still has a "Requires a discount code" condition, which is now managed on the offer's Codes tab. Run the discount-code migration (scripts/migrate-discount-codes.ts) or recreate the code there.`,
      };
    }

    const unsupportedFunctionCondition = eligibilityConditions.find(
      (condition) => condition.isEnabled && !isConditionEnforcedByFunction(condition.conditionType),
    );
    if (unsupportedFunctionCondition) {
      return {
        ok: false,
        error: `Cannot publish "${offer.internalName}": ${unsupportedFunctionCondition.conditionType} is not enforced by Shopify Functions. Keeping the offer in draft prevents browser-controlled metadata from unlocking a discount or free gift.`,
      };
    }

    const unsupportedCustomerOperator = eligibilityConditions.find(
      (condition) =>
        condition.isEnabled &&
        (condition.conditionType === "order_history_total_orders" ||
          condition.conditionType === "order_history_total_spent") &&
        !FUNCTION_NUMERIC_OPERATORS.has(condition.operator),
    );
    if (unsupportedCustomerOperator) {
      return {
        ok: false,
        error: `Cannot publish "${offer.internalName}": ${unsupportedCustomerOperator.operator} is not a supported customer-history operator in Shopify Functions.`,
      };
    }

    for (const condition of eligibilityConditions.filter((item) => item.isEnabled)) {
      const typeResult = ConditionTypeSchema.safeParse(condition.conditionType);
      if (!typeResult.success) {
        return {
          ok: false,
          error: `Cannot publish "${offer.internalName}": unsupported condition "${condition.conditionType}".`,
        };
      }
      const valueResult = validateConditionValue(
        condition.conditionType,
        normalizeConditionValue(condition.conditionType, condition.value),
      );
      if (!valueResult.success) {
        return {
          ok: false,
          error: `Cannot publish "${offer.internalName}": ${condition.conditionType} is invalid. ${firstIssueMessage(valueResult)}`,
        };
      }
      if (hasUnenforcedScopeFilter(condition.value)) {
        return {
          ok: false,
          error: `Cannot publish "${offer.internalName}": ${condition.conditionType} counts only some products, but checkout can only exclude specific products. Remove the product/collection/vendor/type scope or use product exclusions.`,
        };
      }
    }

    for (const reward of rewards) {
      const rewardResult = validateRewardPayload(
        reward.rewardType,
        reward.discountType,
        reward.value,
        reward.target,
      );
      if (!rewardResult.success) {
        return {
          ok: false,
          error: `Cannot publish "${offer.internalName}": reward ${reward.rewardType} is invalid. ${firstIssueMessage(rewardResult)}`,
        };
      }
      if (reward.quantity !== null && reward.quantity < 1) {
        return {
          ok: false,
          error: `Cannot publish "${offer.internalName}": reward quantity must be at least 1.`,
        };
      }
      if (isUnscopedTaggedReward(reward.rewardType, reward.target)) {
        const scopeMode = (reward.target as { scopeMode?: string })?.scopeMode;
        return {
          ok: false,
          error: `Cannot publish "${offer.internalName}": a ${scopeMode} reward needs a product or variant allowlist — without one, any line tagged with the matching attribute could unlock this discount.`,
        };
      }
    }
  }

  return { ok: true };
}

export async function publishShopConfig(
  shopId: string,
  shopDomain: string,
): Promise<string | null> {
  try {
    // "pending" means another publish held the shop's lock: the shop is flagged and retried in the
    // background (and by the cron). That is not an error and must never pause or draft an offer.
    await publishOffersForShop(shopId, shopDomain);
    await invalidateOfferDefinitions(shopId);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Failed to publish offer configuration to Shopify.";
  }
}

export async function republishIfActive(
  db: Db,
  shopId: string,
  shopDomain: string,
  offerId: string,
  wasActive: boolean,
): Promise<string | null> {
  if (!wasActive) {
    await invalidateOfferDefinitions(shopId);
    return null;
  }
  // The edit is already saved; an active offer whose new state can't be validated or pushed
  // would otherwise ride along with the next unrelated publish. Pause it instead.
  const validation = await validateOffersPublishable(db, shopId, [offerId]);
  const publishError = validation.ok
    ? await publishShopConfig(shopId, shopDomain)
    : (validation.error ?? "Offer is not publishable.");
  if (!publishError) return null;

  await db
    .update(offers)
    .set({ status: "paused", updatedAt: new Date() })
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
  const rollbackError = await publishShopConfig(shopId, shopDomain);
  return rollbackError
    ? `${publishError} The offer was paused, but re-publishing the Shopify configuration also failed: ${rollbackError}`
    : `${publishError} The offer was paused so the change can't go live; fix it and activate it again.`;
}

/**
 * Completes wizard-created active offers with the same validation, Shopify
 * synchronization, and rollback guarantees as the detail-page publish flow.
 */
export async function finalizeCreatedOffer(
  db: Db,
  shopId: string,
  shopDomain: string,
  offerId: string,
  intendedStatus: string,
): Promise<string | null> {
  if (intendedStatus !== "active") {
    await invalidateOfferDefinitions(shopId);
    return null;
  }
  const validation = await validateOffersPublishable(db, shopId, [offerId]);
  if (!validation.ok) {
    await db
      .update(offers)
      .set({ status: "draft", updatedAt: new Date() })
      .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
    return validation.error ?? "The offer could not be published.";
  }
  const publishError = await publishShopConfig(shopId, shopDomain);
  if (!publishError) return null;

  await db
    .update(offers)
    .set({ status: "draft", updatedAt: new Date() })
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
  const rollbackError = await publishShopConfig(shopId, shopDomain);
  return rollbackError
    ? `${publishError} The offer was restored to draft, but Shopify configuration rollback also failed: ${rollbackError}`
    : `${publishError} The offer was restored to draft and the previous Shopify configuration was re-published.`;
}
