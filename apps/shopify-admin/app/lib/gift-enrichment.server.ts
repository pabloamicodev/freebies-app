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

interface GiftVariantStock {
  productStatus: string | null;
  availableForSale: boolean;
  requiresSellingPlan: boolean;
  inventoryPolicy: string | null;
  inventoryQuantity: number | null;
}

function isGiftVariantAvailable(variant: GiftVariantStock | undefined): boolean {
  return Boolean(
    variant &&
      variant.productStatus === "ACTIVE" &&
      variant.availableForSale &&
      !variant.requiresSellingPlan &&
      (variant.inventoryPolicy === "CONTINUE" || (variant.inventoryQuantity ?? 0) > 0),
  );
}

/**
 * Drops auto-add gift actions for sold-out variants. Shopify rejects the add anyway, and
 * the runtime would retry it on every cart change. Variants missing from the catalog cache
 * are kept, because a cache miss is not evidence of being sold out.
 */
export async function dropSoldOutGiftAdds<T extends { action: string; variantId?: string; properties?: Record<string, string> }>(
  shopId: string,
  cartActions: T[],
): Promise<T[]> {
  const giftAdds = cartActions.filter(
    (action) => action.action === "add_line" && action.variantId && action.properties?.["_promo_engine_line_type"] === "gift",
  );
  if (giftAdds.length === 0) return cartActions;

  const rows = await getDb()
    .select({
      variantGid: variantCache.variantGid,
      availableForSale: variantCache.availableForSale,
      inventoryQuantity: variantCache.inventoryQuantity,
      inventoryPolicy: variantCache.inventoryPolicy,
      requiresSellingPlan: variantCache.requiresSellingPlan,
      productStatus: productCache.status,
    })
    .from(variantCache)
    .leftJoin(
      productCache,
      and(eq(productCache.shopId, variantCache.shopId), eq(productCache.productGid, variantCache.productGid)),
    )
    .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, giftAdds.map((action) => action.variantId!))));
  const stockById = new Map(rows.map((row) => [row.variantGid, row]));
  return cartActions.filter((action) => {
    if (!giftAdds.includes(action)) return true;
    const stock = stockById.get(action.variantId!);
    return !stock || isGiftVariantAvailable(stock);
  });
}

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
      const isAvailable = isGiftVariantAvailable(variant);

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
