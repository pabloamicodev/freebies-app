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

function firstIssueMessage(result: { success: boolean; error?: { issues?: Array<{ message: string }> } }): string {
  return result.error?.issues?.[0]?.message ?? "Invalid offer configuration.";
}

export async function validateOffersPublishable(db: Db, shopId: string, offerIds: string[]): Promise<PublishValidationResult> {
  if (offerIds.length === 0) return { ok: true };

  const [offerRows, conditionRows, rewardRows]: [
    { id: string; internalName: string }[],
    OfferCondition[],
    OfferReward[],
  ] = await Promise.all([
    db.select({ id: offers.id, internalName: offers.internalName }).from(offers)
      .where(and(eq(offers.shopId, shopId), inArray(offers.id, offerIds))),
    db.select().from(offerConditions)
      .where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, offerIds))),
    db.select().from(offerRewards)
      .where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, offerIds))),
  ]);

  const foundIds = new Set(offerRows.map((offer) => offer.id));
  for (const offerId of offerIds) {
    if (!foundIds.has(offerId)) return { ok: false, error: "Offer not found." };
  }

  for (const offer of offerRows) {
    const conditions = conditionRows.filter((condition) => condition.offerId === offer.id);
    const rewards = rewardRows.filter((reward) => reward.offerId === offer.id);
    const mainConditions = conditions.filter((condition) => condition.scope === "main" && condition.isEnabled);

    if (mainConditions.length === 0) {
      return { ok: false, error: `Cannot publish "${offer.internalName}": add at least one enabled main condition.` };
    }
    if (rewards.length === 0) {
      return { ok: false, error: `Cannot publish "${offer.internalName}": add at least one reward.` };
    }

    for (const condition of conditions.filter((item) => item.isEnabled)) {
      const typeResult = ConditionTypeSchema.safeParse(condition.conditionType);
      if (!typeResult.success) {
        return { ok: false, error: `Cannot publish "${offer.internalName}": unsupported condition "${condition.conditionType}".` };
      }
      const valueResult = validateConditionValue(
        condition.conditionType,
        normalizeConditionValue(condition.conditionType, condition.value as Record<string, unknown>),
      );
      if (!valueResult.success) {
        return { ok: false, error: `Cannot publish "${offer.internalName}": ${condition.conditionType} is invalid. ${firstIssueMessage(valueResult)}` };
      }
    }

    for (const reward of rewards) {
      const rewardResult = validateRewardPayload(reward.rewardType, reward.discountType, reward.value, reward.target);
      if (!rewardResult.success) {
        return { ok: false, error: `Cannot publish "${offer.internalName}": reward ${reward.rewardType} is invalid. ${firstIssueMessage(rewardResult)}` };
      }
      if (reward.quantity !== null && reward.quantity < 1) {
        return { ok: false, error: `Cannot publish "${offer.internalName}": reward quantity must be at least 1.` };
      }
    }
  }

  return { ok: true };
}

export async function publishShopConfig(shopId: string, shopDomain: string): Promise<string | null> {
  try {
    await publishOffersForShop(shopId, shopDomain);
    invalidateOfferDefinitions(shopId);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Failed to publish offer configuration to Shopify.";
  }
}

export async function republishIfActive(db: Db, shopId: string, shopDomain: string, offerId: string, wasActive: boolean): Promise<string | null> {
  if (!wasActive) {
    invalidateOfferDefinitions(shopId);
    return null;
  }
  const validation = await validateOffersPublishable(db, shopId, [offerId]);
  if (!validation.ok) return validation.error ?? "Offer is not publishable.";
  return publishShopConfig(shopId, shopDomain);
}
