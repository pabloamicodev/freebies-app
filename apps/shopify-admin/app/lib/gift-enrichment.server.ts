/**
 * Enriches the pure evaluator's gift-slider payload with catalog data. The
 * evaluator intentionally has no database access, so it can only identify the
 * configured variants and rewards; this layer supplies current title, image,
 * price and availability before the payload reaches the storefront.
 */
import { getDb, productCache, variantCache } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import type { GiftSliderPayload } from "@promo/shared-types";
import type { OfferDefinition } from "@promo/rule-engine";

export async function enrichGiftSlider(
  shopId: string,
  payload: GiftSliderPayload | null,
  offerDefinitions: OfferDefinition[],
): Promise<GiftSliderPayload | null> {
  if (!payload || payload.selectableGifts.length === 0) return payload;

  const variantIds = [...new Set(payload.selectableGifts.map((gift) => gift.variantId))];
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
      requiresSellingPlan: variantCache.requiresSellingPlan,
      productTitle: productCache.title,
      imageUrl: productCache.imageUrl,
      productStatus: productCache.status,
    })
    .from(variantCache)
    .leftJoin(
      productCache,
      and(
        eq(productCache.shopId, variantCache.shopId),
        eq(productCache.productGid, variantCache.productGid),
      ),
    )
    .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, variantIds)));
  const variantById = new Map(variants.map((variant) => [variant.variantGid, variant]));

  const offer = offerDefinitions.find((definition) => definition.id === payload.offerId);
  const rewardById = new Map(offer?.rewards.map((reward) => [reward.id, reward]) ?? []);

  return {
    ...payload,
    selectableGifts: payload.selectableGifts.map((gift) => {
      const variant = variantById.get(gift.variantId);
      const reward = rewardById.get(gift.rewardId);
      const originalPriceCents = variant ? Math.max(0, Math.round(Number(variant.price) * 100)) : 0;
      const value = reward?.value as { amount?: number } | undefined;
      const amount = Number(value?.amount ?? 0);
      const discountedPriceCents =
        reward?.discountType === "free"
          ? 0
          : reward?.discountType === "percentage"
            ? Math.max(0, Math.round(originalPriceCents * (1 - Math.min(100, amount) / 100)))
            : reward?.discountType === "fixed_amount"
              ? Math.max(0, originalPriceCents - Math.round(amount))
              : reward?.discountType === "fixed_price"
                ? Math.max(0, Math.round(amount))
                : originalPriceCents;
      const isAvailable = Boolean(
        variant &&
        variant.productStatus === "ACTIVE" &&
        variant.availableForSale &&
        !variant.requiresSellingPlan &&
        (variant.inventoryPolicy === "CONTINUE" || (variant.inventoryQuantity ?? 0) > 0),
      );

      return {
        ...gift,
        productId: variant?.productGid ?? gift.productId,
        title: variant?.productTitle ?? gift.title,
        variantTitle:
          variant?.variantTitle === "Default Title"
            ? null
            : (variant?.variantTitle ?? gift.variantTitle),
        imageUrl: variant?.imageUrl ?? gift.imageUrl,
        originalPriceCents,
        discountedPriceCents,
        isAvailable,
      };
    }),
  };
}
