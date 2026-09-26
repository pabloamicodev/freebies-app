import { and, eq, inArray } from "drizzle-orm";
import {
  offers,
  offerConditions,
  offerRewards,
  type Db,
  type OfferCondition,
  type OfferReward,
} from "@promo/db";
import {
  ConditionTypeSchema,
  validateConditionValue,
  validateRewardPayload,
} from "@promo/shared-types";
import { publishOffersForShop } from "./sync/offer-publisher.server.js";
import { invalidateOfferDefinitions } from "./offer-definitions.server.js";
import { normalizeConditionValue } from "./offer-config-normalization.server.js";

export interface PublishValidationResult {
  ok: boolean;
  error?: string;
}

const FUNCTION_CONDITION_TYPES = new Set([
  "cart_value",
  "cart_quantity",
  "specific_product",
  "pack_of_products",
  "subscription_product_type",
  "order_history_total_orders",
  "order_history_total_spent",
  "line_attribute",
  "cart_attribute",
  "exclude_products",
  "customer_tags",
  "customer_location",
  "markets",
  "specific_link",
  "page_url",
]);

const FUNCTION_NUMERIC_OPERATORS = new Set(["eq", "gt", "gte", "lt", "lte"]);

function firstIssueMessage(result: {
  success: boolean;
  error?: { issues?: Array<{ message: string }> };
}): string {
  return result.error?.issues?.[0]?.message ?? "Invalid offer configuration.";
}

export function isConditionEnforcedByFunction(conditionType: string): boolean {
  return FUNCTION_CONDITION_TYPES.has(conditionType);
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

export async function validateOffersPublishable(
  db: Db,
  shopId: string,
  offerIds: string[],
): Promise<PublishValidationResult> {
  if (offerIds.length === 0) return { ok: true };

  const [offerRows, conditionRows, rewardRows]: [
    { id: string; internalName: string }[],
    OfferCondition[],
    OfferReward[],
  ] = await Promise.all([
    db
      .select({ id: offers.id, internalName: offers.internalName })
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
  ]);

  const foundIds = new Set(offerRows.map((offer) => offer.id));
  for (const offerId of offerIds) {
    if (!foundIds.has(offerId)) return { ok: false, error: "Offer not found." };
  }

  for (const offer of offerRows) {
    const conditions = conditionRows.filter((condition) => condition.offerId === offer.id);
    const eligibilityConditions = conditions.filter(
      (condition) => condition.scope === "main" || condition.scope === "sub",
    );
    const rewards = rewardRows.filter((reward) => reward.offerId === offer.id);
    const mainConditions = eligibilityConditions.filter(
      (condition) => condition.scope === "main" && condition.isEnabled,
    );

    if (mainConditions.length === 0) {
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

    if (rewards.some((reward) => reward.rewardType === "shipping_discount")) {
      const unsupportedShippingCondition = eligibilityConditions.find(
        (condition) => condition.isEnabled && condition.conditionType !== "cart_value",
      );
      if (unsupportedShippingCondition) {
        return {
          ok: false,
          error: `Cannot publish "${offer.internalName}": shipping discounts do not yet support the ${unsupportedShippingCondition.conditionType} condition in Shopify Functions.`,
        };
      }
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
    await publishOffersForShop(shopId, shopDomain);
    invalidateOfferDefinitions(shopId);
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
    invalidateOfferDefinitions(shopId);
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
    invalidateOfferDefinitions(shopId);
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
