import { and, eq, inArray } from "drizzle-orm";
import {
  offers,
  offerConditions,
  offerRewards,
  offerCombinationPolicies,
  type Db,
} from "@promo/db";
import type { OfferDefinition } from "@promo/rule-engine";
import { waitUntil } from "@vercel/functions";
import { redisDelete, redisGetString, redisSetString } from "./redis.server.js";
import { computeOfferVersion } from "./offer-version.server.js";
import { normalizeConditionValue } from "./offer-config-normalization.server.js";

// D10: definitions are cached in Redis for OFFER_DEFINITIONS_TTL_SECONDS (shared across
// serverless instances) and dropped on publish via invalidateOfferDefinitions. A reader that
// raced a publish can re-cache the old value, so staleness is bounded by the TTL, not zero.
// Without Redis (or on any Redis error) every call reads the DB, as before.
export const OFFER_DEFINITIONS_TTL_SECONDS = 30;
const MAX_CACHED_BYTES = 512 * 1024;

const cacheKey = (shopId: string) => `od:v1:${shopId}`;

/**
 * Call after a successful publish/pause/archive (the publisher is WS-C's: it should `await` this).
 * Also registered with waitUntil so an un-awaited call still completes before the function freezes.
 */
export function invalidateOfferDefinitions(shopId: string): Promise<void> {
  const pending = redisDelete(cacheKey(shopId)).catch(() => undefined);
  try {
    waitUntil(pending);
  } catch {
    // Not inside a Vercel request context (scripts, tests).
  }
  return pending;
}

function reviveDates(definitions: OfferDefinition[]): OfferDefinition[] {
  return definitions.map((definition) => ({
    ...definition,
    startsAt: definition.startsAt ? new Date(definition.startsAt) : null,
    endsAt: definition.endsAt ? new Date(definition.endsAt) : null,
  }));
}

export async function getOfferDefinitions(shopId: string, db: Db): Promise<OfferDefinition[]> {
  const cached = await redisGetString(cacheKey(shopId));
  if (cached) {
    try {
      return reviveDates(JSON.parse(cached) as OfferDefinition[]);
    } catch {
      // Corrupt entry: fall through and overwrite it.
    }
  }
  const definitions = await loadOfferDefinitions(shopId, db);
  const serialized = JSON.stringify(definitions);
  if (serialized.length <= MAX_CACHED_BYTES) {
    await redisSetString(cacheKey(shopId), serialized, OFFER_DEFINITIONS_TTL_SECONDS);
  }
  return definitions;
}

export async function loadOfferDefinitions(shopId: string, db: Db): Promise<OfferDefinition[]> {
  type OfferRow = typeof offers.$inferSelect;
  type ConditionRow = typeof offerConditions.$inferSelect;
  type RewardRow = typeof offerRewards.$inferSelect;
  type PolicyRow = typeof offerCombinationPolicies.$inferSelect;

  // Skip compiledConfig (this query runs on every evaluate request, and
  // compiledConfig duplicates this whole function's output — easily the
  // heaviest column on the row) plus the other columns offer-version.server's
  // VOLATILE_KEYS already excludes from computeOfferVersion's hash, so
  // dropping them here can't desync the version from offer-publisher.server.ts
  // (which hashes the full row). `description` stays: it isn't in
  // VOLATILE_KEYS, so omitting it here would change the version computed on
  // this path without changing the one computed at publish time.
  // requiredDiscountCode/codeDiscountId only matter for publish-time discount
  // routing (offer-publisher.server.ts) — evaluate never reads them, so they're
  // excluded here for the same reason compiledConfig is.
  const activeOffers: Array<Omit<OfferRow, "shopId" | "compiledConfig" | "functionMetafieldGid" | "createdAt" | "updatedAt" | "updatedBy" | "requiredDiscountCode" | "codeDiscountId" | "requiresCode">> = await db
    .select({
      id: offers.id,
      type: offers.type,
      status: offers.status,
      internalName: offers.internalName,
      publicTitle: offers.publicTitle,
      description: offers.description,
      priority: offers.priority,
      startsAt: offers.startsAt,
      endsAt: offers.endsAt,
      timezone: offers.timezone,
      discountTags: offers.discountTags,
      createdBy: offers.createdBy,
      archivedAt: offers.archivedAt,
    })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.status, "active")))
    .orderBy(offers.priority);

  const offerIds = activeOffers.map((offer) => offer.id);
  const [conditions, rewards, policies]: [ConditionRow[], RewardRow[], PolicyRow[]] = offerIds.length > 0
    ? await Promise.all([
        db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, offerIds))),
        db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, offerIds))),
        db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), inArray(offerCombinationPolicies.offerId, offerIds))),
      ])
    : [[], [], []];

  const policyByOffer = new Map(policies.map((policy) => [policy.offerId, policy]));
  const offerDefinitions: OfferDefinition[] = activeOffers.map((offer) => {
    const policy = policyByOffer.get(offer.id);
    const offerConditionsForVersion = conditions.filter((condition) => condition.offerId === offer.id);
    const offerRewardsForVersion = rewards.filter((reward) => reward.offerId === offer.id);
    return {
      id: offer.id,
      version: computeOfferVersion(offer, offerConditionsForVersion, offerRewardsForVersion, policy ?? null),
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
          value: normalizeConditionValue(condition.conditionType, condition.value),
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

  return offerDefinitions;
}
