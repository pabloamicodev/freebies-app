/**
 * Plans the conversion of an offer's percentage order_discount rewards into sitewide product_discount rewards.
 * Shopify shows a per-line strikethrough in checkout only for PRODUCT-class discounts; an order discount
 * is one "Order discount" line. Pure: the caller loads the rows and writes the result.
 */
import type { OfferReward } from "@promo/db";

export interface RewardConversion {
  rewardId: string;
  before: Pick<OfferReward, "rewardType" | "discountType" | "value" | "target">;
  after: Pick<OfferReward, "rewardType" | "discountType" | "value" | "target">;
}

export type ConversionPlan =
  | { ok: true; conversions: RewardConversion[] }
  | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function planOrderToProductConversion(rewards: readonly OfferReward[]): ConversionPlan {
  const orderRewards = rewards.filter((reward) => reward.rewardType === "order_discount");
  if (orderRewards.length === 0) return { ok: false, reason: "the offer has no order_discount reward" };

  const conversions: RewardConversion[] = [];
  for (const reward of orderRewards) {
    if (reward.discountType !== "percentage") {
      return {
        ok: false,
        reason: `reward ${reward.id} is ${reward.discountType}: only percentage converts (a fixed amount is not a per-line equivalent)`,
      };
    }
    const value = isRecord(reward.value) ? reward.value : {};
    const amount = Number(value["amount"]);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100) {
      return { ok: false, reason: `reward ${reward.id} has an invalid percentage (${String(value["amount"])})` };
    }
    if (Array.isArray(value["tiers"]) && value["tiers"].length > 0) {
      return { ok: false, reason: `reward ${reward.id} has subtotal/quantity tiers, which do not map to a sitewide product reward` };
    }
    const target = isRecord(reward.target) ? reward.target : {};
    const subscriptionMode =
      target["subscriptionMode"] === "subscription_only" || target["subscriptionMode"] === "one_time_only"
        ? target["subscriptionMode"]
        : "any";
    conversions.push({
      rewardId: reward.id,
      before: { rewardType: reward.rewardType, discountType: reward.discountType, value: reward.value, target: reward.target },
      after: {
        rewardType: "product_discount",
        discountType: "percentage",
        value: reward.value,
        target: { scope: "cart", scopeMode: "sitewide", subscriptionMode },
      },
    });
  }
  return { ok: true, conversions };
}
