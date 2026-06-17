import { and, eq, inArray } from "drizzle-orm";
import {
  offers,
  offerConditions,
  offerRewards,
  offerCombinationPolicies,
  type Db,
} from "@promo/db";
import type { OfferDefinition } from "@promo/rule-engine";

const OFFER_DEFINITION_CACHE_MS = 5_000;
const offerDefinitionCache = new Map<string, { expiresAt: number; offers: OfferDefinition[] }>();

export function invalidateOfferDefinitions(shopId: string): void {
  offerDefinitionCache.delete(shopId);
}

export async function getOfferDefinitions(shopId: string, db: Db): Promise<OfferDefinition[]> {
  const cached = offerDefinitionCache.get(shopId);
  if (cached && cached.expiresAt > Date.now()) return cached.offers;

  const activeOffers = await db
    .select()
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.status, "active")))
    .orderBy(offers.priority);

  const offerIds = activeOffers.map((offer) => offer.id);
  const [conditions, rewards, policies] = offerIds.length > 0
    ? await Promise.all([
        db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, offerIds))),
        db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, offerIds))),
        db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), inArray(offerCombinationPolicies.offerId, offerIds))),
      ])
    : [[], [], []];

  const policyByOffer = new Map(policies.map((policy) => [policy.offerId, policy]));
  const offerDefinitions: OfferDefinition[] = activeOffers.map((offer) => {
    const policy = policyByOffer.get(offer.id);
    return {
      id: offer.id,
      version: 1,
      type: offer.type,
      priority: offer.priority,
      stopLowerPriority: policy?.stopLowerPriority ?? false,
      startsAt: offer.startsAt,
      endsAt: offer.endsAt,
      conditions: conditions
        .filter((condition) => condition.offerId === offer.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((condition) => ({
          id: condition.id,
          scope: condition.scope,
          conditionType: condition.conditionType,
          operator: condition.operator,
          value: condition.value,
          isEnabled: condition.isEnabled,
          sortOrder: condition.sortOrder,
        })),
      rewards: rewards
        .filter((reward) => reward.offerId === offer.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((reward) => ({
          id: reward.id,
          rewardType: reward.rewardType,
          discountType: reward.discountType,
          value: reward.value,
          target: reward.target,
          quantity: reward.quantity,
          isAutoAdd: reward.isAutoAdd,
          isCustomerSelectable: reward.isCustomerSelectable,
          trackMode: reward.trackMode as "product" | "variant",
          sortOrder: reward.sortOrder,
          label: reward.label,
        })),
      combinationPolicy: {
        combinesWithOrderDiscounts: policy?.combinesWithOrderDiscounts ?? true,
        combinesWithProductDiscounts: policy?.combinesWithProductDiscounts ?? true,
        combinesWithShippingDiscounts: policy?.combinesWithShippingDiscounts ?? true,
        stopLowerPriority: policy?.stopLowerPriority ?? false,
        maxApplicationsPerCart: policy?.maxApplicationsPerCart ?? null,
        maxApplicationsPerCustomer: policy?.maxApplicationsPerCustomer ?? null,
      },
      giftValueCountsForOtherOffers: policy?.giftValueCountsForOtherOffers ?? false,
    };
  });

  offerDefinitionCache.set(shopId, { expiresAt: Date.now() + OFFER_DEFINITION_CACHE_MS, offers: offerDefinitions });
  return offerDefinitions;
}
