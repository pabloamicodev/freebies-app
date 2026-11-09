import { and, eq } from "drizzle-orm";
import { offerCombinationPolicies, offerConditions, offerRewards, offers, type Db } from "@promo/db";
import type { ShopContext } from "./shop-context.server.js";
import { buildTieredGiftOffer, giftTieredOfferSchema, type GiftTierCampaign } from "./gift-tier-campaigns.js";
import { parseJsonRecord } from "./offer-validation.server.js";
import { normalizeOfferSubconditions } from "./gift-subconditions.js";
import { isUniqueViolation, withUniqueOfferSuffix } from "./unique-offer-name.server.js";

export type TieredGiftOfferResult = { error: string } | { offerId: string; campaign: GiftTierCampaign };

/** One gift offer carrying every tier as its own reward; the form's campaign JSON and sub-conditions are validated here. */
export async function createTieredGiftOffer(
  { db, shopId, currencyCode, timezone }: Pick<ShopContext, "db" | "shopId" | "currencyCode" | "timezone">,
  formData: FormData,
  status: "draft" | "active",
): Promise<TieredGiftOfferResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("campaign") ?? "{}"));
  } catch {
    return { error: "Gift tiers must be valid JSON." };
  }
  const parsed = giftTieredOfferSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Gift tiers are invalid." };
  const campaign = parsed.data;
  const subconditionsResult = parseJsonRecord(formData, "subconditions");
  if (subconditionsResult.error) return { error: subconditionsResult.error };
  const subconditions = normalizeOfferSubconditions(subconditionsResult.data!);
  if (!subconditions.success) return { error: subconditions.error };
  const draft = buildTieredGiftOffer(campaign, currencyCode);

  const insert = (internalName: string) =>
    db.transaction(async (tx) => {
      const [offer] = await tx
        .insert(offers)
        .values({
          shopId,
          type: "gift",
          status,
          internalName,
          publicTitle: draft.name,
          tierMode: draft.tierMode,
          startsAt: new Date(),
          timezone,
          createdBy: "gift-tier-builder",
          updatedBy: "gift-tier-builder",
        })
        .returning({ id: offers.id });
      if (!offer) throw new Error("Failed to create offer");
      await tx.insert(offerConditions).values([
        { shopId, offerId: offer.id, scope: "main", conditionType: "cart_value", operator: "gte", value: draft.condition, sortOrder: 0, isEnabled: true },
        ...subconditions.data.map((subcondition, index) => ({
          shopId,
          offerId: offer.id,
          scope: "sub" as const,
          conditionType: subcondition.conditionType,
          operator: subcondition.operator,
          value: subcondition.value,
          sortOrder: index + 1,
          isEnabled: true,
        })),
      ]);
      await tx.insert(offerRewards).values(draft.rewards.map((reward) => ({ shopId, offerId: offer.id, ...reward })));
      await tx.insert(offerCombinationPolicies).values({ shopId, offerId: offer.id });
      return offer.id;
    });

  try {
    return { offerId: await insert(draft.name), campaign };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { offerId: await insert(withUniqueOfferSuffix(draft.name)), campaign };
  }
}

export async function lowestGiftTier(db: Pick<Db, "select">, shopId: string, offerId: string): Promise<number | null> {
  const rewards = await db
    .select({ min: offerRewards.minCartSubtotalCents })
    .from(offerRewards)
    .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId), eq(offerRewards.rewardType, "product_gift")));
  const tiers = rewards.flatMap((reward) => (reward.min ? [reward.min] : []));
  return tiers.length > 0 ? Math.min(...tiers) : null;
}

/**
 * A tiered offer qualifies at its lowest tier: a stricter main cart-value threshold would make the lower tiers unreachable.
 * Call it only after a save that changed a tier. Per-currency overrides were set against the old threshold, so they go too
 * (the threshold then converts with the exchange rate like the tiers do).
 */
export async function lowerMainThresholdToLowestTier(db: Pick<Db, "select" | "update">, shopId: string, offerId: string): Promise<void> {
  const lowest = await lowestGiftTier(db, shopId, offerId);
  if (lowest === null) return;
  const [main] = await db
    .select({ id: offerConditions.id, value: offerConditions.value })
    .from(offerConditions)
    .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.scope, "main"), eq(offerConditions.conditionType, "cart_value")))
    .limit(1);
  const value = main?.value as { thresholdCents?: number; currencyOverrides?: unknown } | null | undefined;
  if (!main || typeof value?.thresholdCents !== "number" || value.thresholdCents <= lowest) return;
  const { currencyOverrides: _dropped, ...rest } = value;
  await db
    .update(offerConditions)
    .set({ value: { ...rest, thresholdCents: lowest } })
    .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.id, main.id)));
}
