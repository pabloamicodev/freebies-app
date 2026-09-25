/**
 * Builds the `upsells` payload for qualified upsell offers. Kept out of the
 * pure rule-engine evaluator (packages/rule-engine has no DB access) — this
 * runs at the route layer, which already has variantCache loaded.
 */
import { getDb, variantCache, productCache } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import type { EvaluatedOffer, UpsellPayload } from "@promo/shared-types";
import type { OfferDefinition } from "@promo/rule-engine";

export async function buildUpsells(
  shopId: string,
  qualifiedOffers: EvaluatedOffer[],
  offerDefinitions: OfferDefinition[],
): Promise<UpsellPayload[]> {
  const upsellOffers = qualifiedOffers.filter((offer) => offer.type === "upsell");
  if (upsellOffers.length === 0) return [];

  const offerById = new Map(offerDefinitions.map((offer) => [offer.id, offer]));

  const variantIds = [
    ...new Set(
      upsellOffers.flatMap((offer) => {
        const def = offerById.get(offer.offerId);
        const reward = def?.rewards.find((r) => r.rewardType === "upsell_discount");
        const target = reward?.target as { variantIds?: string[]; variantId?: string } | undefined;
        return target?.variantIds ?? (target?.variantId ? [target.variantId] : []);
      }),
    ),
  ];
  if (variantIds.length === 0) return [];

  const db = getDb();
  const variants = await db
    .select({
      variantGid: variantCache.variantGid,
      productGid: variantCache.productGid,
      variantTitle: variantCache.title,
      price: variantCache.price,
      availableForSale: variantCache.availableForSale,
      inventoryQuantity: variantCache.inventoryQuantity,
      inventoryPolicy: variantCache.inventoryPolicy,
      productTitle: productCache.title,
      imageUrl: productCache.imageUrl,
    })
    .from(variantCache)
    .leftJoin(productCache, and(eq(productCache.shopId, variantCache.shopId), eq(productCache.productGid, variantCache.productGid)))
    .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, variantIds)));
  const variantByGid = new Map(variants.map((v) => [v.variantGid, v]));

  const payloads: UpsellPayload[] = [];
  for (const offer of upsellOffers) {
    const def = offerById.get(offer.offerId);
    const reward = def?.rewards.find((r) => r.rewardType === "upsell_discount");
    if (!reward) continue;

    const target = reward.target as { variantIds?: string[]; variantId?: string };
    const firstVariantId = target.variantIds?.[0] ?? target.variantId;
    const variant = firstVariantId ? variantByGid.get(firstVariantId) : undefined;

    const value = reward.value as { amount?: number };
    const discountPercent = reward.discountType === "percentage" ? Number(value.amount ?? 0) : 0;
    const originalPriceCents = variant ? Math.round(Number(variant.price) * 100) : 0;
    const discountedPriceCents = reward.discountType === "percentage"
      ? Math.round(originalPriceCents * (1 - discountPercent / 100))
      : reward.discountType === "fixed_amount"
        ? Math.max(0, originalPriceCents - Math.round(Number(value.amount ?? 0) * 100))
        : originalPriceCents;

    const isInStock = variant
      ? variant.availableForSale // already covers untracked inventory and oversell policy
      : false;

    payloads.push({
      offerId: offer.offerId,
      product: variant
        ? {
            variantId: variant.variantGid,
            productId: variant.productGid,
            title: variant.productTitle ?? variant.variantTitle,
            variantTitle: variant.variantTitle === "Default Title" ? null : variant.variantTitle,
            imageUrl: variant.imageUrl,
            originalPriceCents,
            discountedPriceCents,
            isAvailable: isInStock,
          }
        : null,
      message: "You might also like",
      buttonText: "Add",
      discountPercent,
    });
  }

  return payloads;
}
