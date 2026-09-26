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

export interface GiftCatalogRow {
  variantGid: string;
  productGid: string;
  variantTitle: string;
  price: string;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  inventoryPolicy: string | null;
  requiresSellingPlan: boolean;
  productTitle: string | null;
  imageUrl: string | null;
  productStatus: string | null;
}

// Shopify's availableForSale already accounts for untracked inventory and the
// "continue selling when out of stock" policy; a raw quantity of 0 is normal for untracked items.
function isGiftVariantAvailable(variant: GiftCatalogRow | undefined): boolean {
  return Boolean(
    variant && variant.productStatus === "ACTIVE" && variant.availableForSale && !variant.requiresSellingPlan,
  );
}

function fallbackVariantIdsFor(offerDefinitions: OfferDefinition[], offerId: string | undefined, rewardId: string | undefined): string[] {
  const reward = offerDefinitions
    .find((offer) => offer.id === offerId)
    ?.rewards.find((candidate) => candidate.id === rewardId);
  const fallbacks = (reward?.target as { fallbackVariantIds?: unknown } | undefined)?.fallbackVariantIds;
  return Array.isArray(fallbacks) ? fallbacks.filter((id): id is string => typeof id === "string") : [];
}

function giftAddActions<T extends { action: string; variantId?: string; properties?: Record<string, string> }>(
  cartActions: T[],
): T[] {
  return cartActions.filter(
    (action) => action.action === "add_line" && action.variantId && action.properties?.["_promo_engine_line_type"] === "gift",
  );
}

/** Every variant id enrichGiftSlider and resolveSoldOutGiftAdds need pricing/
 * stock data for — call once, load in a single shared query, then pass the
 * result to both instead of each hitting the database on its own. */
export function collectGiftCatalogVariantIds<T extends { action: string; variantId?: string; properties?: Record<string, string> }>(
  giftSlider: GiftSliderPayload | null,
  cartActions: T[],
  offerDefinitions: OfferDefinition[],
): string[] {
  const sliderIds = giftSlider
    ? giftSlider.selectableGifts.flatMap((gift) => [
        gift.variantId,
        ...fallbackVariantIdsFor(offerDefinitions, giftSlider.offerId, gift.rewardId),
      ])
    : [];
  const giftAdds = giftAddActions(cartActions);
  const cartActionIds = giftAdds.flatMap((action) => [
    action.variantId!,
    ...fallbackVariantIdsFor(offerDefinitions, action.properties?.["_promo_engine_offer_id"], action.properties?.["_promo_engine_reward_id"]),
  ]);
  return [...new Set([...sliderIds, ...cartActionIds])];
}

export async function loadGiftCatalogData(shopId: string, variantIds: string[]): Promise<Map<string, GiftCatalogRow>> {
  if (variantIds.length === 0) return new Map();
  const rows = await getDb()
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
      and(eq(productCache.shopId, variantCache.shopId), eq(productCache.productGid, variantCache.productGid)),
    )
    .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, [...new Set(variantIds)])));
  return new Map(rows.map((row) => [row.variantGid, row]));
}

/**
 * Auto-add gifts that are sold out are swapped for the reward's first in-stock fallback
 * (configured by the merchant) or dropped: Shopify rejects the add anyway, and the runtime
 * would retry it on every cart change. Without a configured fallback no other gift is given.
 * Variants missing from the catalog cache are kept, since a cache miss is not proof of stock-out.
 */
export function resolveSoldOutGiftAdds<T extends { action: string; variantId?: string; offerId?: string; properties?: Record<string, string> }>(
  catalog: Map<string, GiftCatalogRow>,
  cartActions: T[],
  offerDefinitions: OfferDefinition[],
): T[] {
  const giftAdds = giftAddActions(cartActions);
  if (giftAdds.length === 0) return cartActions;

  const fallbacksByAction = new Map(
    giftAdds.map((action) => [
      action,
      fallbackVariantIdsFor(offerDefinitions, action.properties?.["_promo_engine_offer_id"], action.properties?.["_promo_engine_reward_id"]),
    ]),
  );
  const inStock = (variantId: string) => {
    const row = catalog.get(variantId);
    return !row || isGiftVariantAvailable(row);
  };

  return cartActions.flatMap((action) => {
    if (!giftAdds.includes(action) || inStock(action.variantId!)) return [action];
    const fallback = fallbacksByAction.get(action)?.find((variantId) => catalog.has(variantId) && inStock(variantId));
    return fallback ? [{ ...action, variantId: fallback }] : [];
  });
}

function priceAfterReward(
  reward: { discountType?: string; value?: unknown } | undefined,
  originalPriceCents: number,
): number {
  const amount = Number((reward?.value as { amount?: number } | undefined)?.amount ?? 0);
  if (reward?.discountType === "free") return 0;
  if (reward?.discountType === "percentage") {
    return Math.max(0, Math.round(originalPriceCents * (1 - Math.min(100, amount) / 100)));
  }
  if (reward?.discountType === "fixed_amount") return Math.max(0, originalPriceCents - Math.round(amount));
  if (reward?.discountType === "fixed_price") return Math.max(0, Math.round(amount));
  return originalPriceCents;
}

export function enrichGiftSlider(
  catalog: Map<string, GiftCatalogRow>,
  payload: GiftSliderPayload | null,
  offerDefinitions: OfferDefinition[],
  cartLines: Array<{ variantId: string; properties: Record<string, string> }> = [],
): GiftSliderPayload | null {
  if (!payload || payload.selectableGifts.length === 0) return payload;

  const offer = offerDefinitions.find((definition) => definition.id === payload.offerId);
  const rewardById = new Map(offer?.rewards.map((reward) => [reward.id, reward]) ?? []);
  const listed = new Set(payload.selectableGifts.map((gift) => gift.variantId));

  const enriched = {
    ...payload,
    selectableGifts: payload.selectableGifts.map((gift) => {
      const variant = catalog.get(gift.variantId);
      const reward = rewardById.get(gift.rewardId);
      const originalPriceCents = variant ? Math.max(0, Math.round(Number(variant.price) * 100)) : 0;
      const discountedPriceCents = priceAfterReward(reward, originalPriceCents);
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

  // Sold-out gifts are replaced by the merchant's configured fallbacks; with none configured
  // the sold-out gift stays listed as unavailable and nothing else is offered.
  enriched.selectableGifts = enriched.selectableGifts.map((gift) => {
    if (gift.isAvailable) return gift;
    const fallbackId = fallbackVariantIdsFor(offerDefinitions, payload.offerId, gift.rewardId).find((variantId) => {
      const stock = catalog.get(variantId);
      return !listed.has(variantId) && stock && isGiftVariantAvailable(stock);
    });
    const fallback = fallbackId ? catalog.get(fallbackId) : undefined;
    if (!fallbackId || !fallback) return gift;
    listed.add(fallbackId);
    const originalPriceCents = Math.max(0, Math.round(Number(fallback.price) * 100));
    return {
      ...gift,
      variantId: fallbackId,
      productId: fallback.productGid,
      title: fallback.productTitle ?? gift.title,
      variantTitle: fallback.variantTitle === "Default Title" ? null : fallback.variantTitle,
      imageUrl: fallback.imageUrl ?? null,
      originalPriceCents,
      discountedPriceCents: priceAfterReward(rewardById.get(gift.rewardId), originalPriceCents),
      isAvailable: true,
      isSelected: cartLines.some(
        (line) =>
          line.variantId === fallbackId &&
          line.properties["_promo_engine_line_type"] === "gift" &&
          line.properties["_promo_engine_offer_id"] === payload.offerId &&
          line.properties["_promo_engine_reward_id"] === gift.rewardId &&
          line.properties["_promo_engine_offer_version"] === String(gift.offerVersion),
      ),
      replacesTitle: gift.title,
    };
  });
  return enriched;
}
