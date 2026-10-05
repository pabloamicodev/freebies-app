import { and, eq, inArray, or } from "drizzle-orm";
import {
  discountCodes,
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  type Db,
} from "@promo/db";
import { compileOfferConfig, compileShippingOfferConfigs, serializeFunctionConfig } from "./sync/compile-config.js";
import { isCheckoutCodeGated } from "./code-redemption.js";
import { MAX_METAFIELD_BYTES } from "./sync/offer-publisher.server.js";

/**
 * Bytes of the shared automatic config as the publisher would build it if `includeOfferIds`
 * (e.g. an offer about to switch to automatic) ran through it alongside every active
 * non-code offer. Approximation: skips market-to-country resolution and query variables.
 */
export async function estimateSharedConfigBytes(
  db: Db,
  shopId: string,
  shopCurrencyCode: string,
  includeOfferIds: string[],
): Promise<number> {
  const rows = await db
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.shopId, shopId),
        includeOfferIds.length > 0
          ? or(eq(offers.status, "active"), inArray(offers.id, includeOfferIds))
          : eq(offers.status, "active"),
      ),
    );
  if (rows.length === 0) return 0;
  const ids = rows.map((offer) => offer.id);
  const [codeRows, conditions, rewards, policies] = await Promise.all([
    db.select({ offerId: discountCodes.offerId }).from(discountCodes).where(and(eq(discountCodes.shopId, shopId), inArray(discountCodes.offerId, ids))),
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, ids))),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, ids))),
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), inArray(offerCombinationPolicies.offerId, ids))),
  ]);
  const withCodes = new Set(codeRows.map((row) => row.offerId));
  const extra = new Set(includeOfferIds);
  const shared = rows
    .filter((offer) => extra.has(offer.id) || !isCheckoutCodeGated(offer, withCodes.has(offer.id)))
    .sort((a, b) => a.priority - b.priority);
  const compiled = shared.map((offer) => {
    const offerConditionsRows = conditions.filter((c) => c.offerId === offer.id);
    const offerRewardsRows = rewards.filter((r) => r.offerId === offer.id);
    const policy = policies.find((p) => p.offerId === offer.id) ?? null;
    return {
      offer: compileOfferConfig(offer, offerConditionsRows, offerRewardsRows, policy, 1, { shopCurrencyCode }),
      shipping: compileShippingOfferConfigs(offer, offerConditionsRows, offerRewardsRows, { shopCurrencyCode }),
    };
  });
  return new TextEncoder().encode(
    serializeFunctionConfig({
      offers: compiled.map((entry) => entry.offer),
      shippingOffers: compiled.flatMap((entry) => entry.shipping),
      version: "1",
      compiledAt: "2026-01-01T00:00:00.000Z",
    }),
  ).byteLength;
}

export function sharedConfigTooLargeMessage(bytes: number): string {
  return `The shared automatic config would be ${bytes}B, over the ${MAX_METAFIELD_BYTES}B limit. Pause or simplify other automatic offers first.`;
}
