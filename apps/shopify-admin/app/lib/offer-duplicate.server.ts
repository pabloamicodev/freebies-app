import {
  bundleDefinitions,
  bundleSteps,
  bundleTiers,
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  type Db,
} from "@promo/db";
import { and, eq } from "drizzle-orm";
import { offerRequiresCode } from "./discount-codes.server.js";

/**
 * Copies an offer and everything it owns (conditions, rewards, combination policy,
 * bundle definition with steps and tiers) in ONE transaction. The copy starts as a draft.
 *
 * Deliberately NOT copied: discount codes, batches and redemptions (codes are unique per
 * shop, so a copy would collide), usage counters, versions, gift clone products (Shopify
 * products tied to the source reward ids) and widgets. The copy keeps `requiresCode` so a
 * code offer stays inert until it gets codes of its own.
 */
export async function duplicateOffer(db: Db, shopId: string, offerId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(offers)
      .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)))
      .limit(1);
    if (!source) return null;
    const requiresCode = await offerRequiresCode(tx as unknown as Db, shopId, source);

    const { id: _id, ...rest } = source;
    const [copy] = await tx
      .insert(offers)
      .values({
        ...rest,
        internalName: `${source.internalName}-copy`,
        status: "draft",
        compiledConfig: null,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        // 1:1 with the source and unique-index enforced; sharing a discount node is unsafe.
        requiredDiscountCode: null,
        codeDiscountId: null,
        requiresCode,
      })
      .returning({ id: offers.id });
    if (!copy) return null;
    const newId = copy.id;

    const strip = <T extends { id: string; createdAt: Date; updatedAt: Date }>(row: T) => {
      const { id: _i, createdAt: _c, updatedAt: _u, ...fields } = row;
      return fields;
    };

    const conditions = await tx.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId)));
    if (conditions.length) await tx.insert(offerConditions).values(conditions.map((r) => ({ ...strip(r), offerId: newId })));

    const rewards = await tx.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId)));
    if (rewards.length) await tx.insert(offerRewards).values(rewards.map((r) => ({ ...strip(r), offerId: newId })));

    const policies = await tx.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.offerId, offerId)));
    if (policies.length) await tx.insert(offerCombinationPolicies).values(policies.map((r) => ({ ...strip(r), offerId: newId })));

    const [bundle] = await tx.select().from(bundleDefinitions).where(and(eq(bundleDefinitions.shopId, shopId), eq(bundleDefinitions.offerId, offerId))).limit(1);
    if (bundle) {
      // The bundle product belongs to the source; the copy must create its own.
      const [newBundle] = await tx
        .insert(bundleDefinitions)
        .values({ ...strip(bundle), offerId: newId, bundleProductGid: null })
        .returning({ id: bundleDefinitions.id });
      if (newBundle) {
        const steps = await tx.select().from(bundleSteps).where(and(eq(bundleSteps.shopId, shopId), eq(bundleSteps.bundleId, bundle.id)));
        if (steps.length) await tx.insert(bundleSteps).values(steps.map((r) => ({ ...strip(r), bundleId: newBundle.id })));
        const tiers = await tx.select().from(bundleTiers).where(and(eq(bundleTiers.shopId, shopId), eq(bundleTiers.bundleId, bundle.id)));
        if (tiers.length) await tx.insert(bundleTiers).values(tiers.map((r) => ({ ...strip(r), bundleId: newBundle.id })));
      }
    }
    return newId;
  });
}
