/**
 * Enriches the pure evaluator's gift-slider payload with catalog data. The
 * evaluator intentionally has no database access, so it can only identify the
 * configured variants and rewards; this layer supplies current title, image,
 * price and availability before the payload reaches the storefront.
 */
import { appSettings, getDb, productCache, variantCache } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import type { GiftSliderPayload, WidgetTranslations } from "@promo/shared-types";
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
  productHandle?: string | null;
  inventoryTracked?: boolean | null;
}

// Shopify's availableForSale already accounts for untracked inventory and the
// "continue selling when out of stock" policy; a raw quantity of 0 is normal for untracked items.
// availableForSale in the cache has been seen stale-true for sold-out variants, so a tracked variant
// at or below zero that can't oversell is sold out regardless. Untracked stock legitimately reads 0.
function isGiftVariantAvailable(variant: GiftCatalogRow | undefined): boolean {
  if (!variant) return false;
  const soldOutTracked =
    variant.inventoryTracked === true &&
    variant.inventoryQuantity !== null &&
    variant.inventoryQuantity <= 0 &&
    variant.inventoryPolicy !== "CONTINUE";
  return (
    variant.productStatus === "ACTIVE" && variant.availableForSale && !variant.requiresSellingPlan && !soldOutTracked
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
      inventoryTracked: variantCache.inventoryTracked,
      productTitle: productCache.title,
      imageUrl: productCache.imageUrl,
      productStatus: productCache.status,
      productHandle: productCache.handle,
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

const GIFT_SLIDER_LABEL_DEFAULTS = {
  free: "Free",
  outOfStock: "Out of stock",
  selectPrompt: "Select a gift",
  remove: "Remove Gifts from Cart",
  replaces: "Replaces {{title}} (out of stock)",
} as const;

/** Builds the gift slider's `labels`, layering merchant overrides (from the
 * same "translations.strings" store as app.translation.tsx) onto the English
 * defaults. selectPrompt/remove/replaces have no merchant-editable key yet, so
 * they always use the default; `confirm` is left out unless overridden — the
 * client keeps its own pluralized default for the add-gift button. */
export function resolveGiftSliderLabels(
  overrides?: Partial<WidgetTranslations> | null,
): NonNullable<GiftSliderPayload["labels"]> {
  const free = overrides?.["gift_slider.free_label"]?.trim();
  const outOfStock = overrides?.["gift_slider.out_of_stock"]?.trim();
  const confirm = overrides?.["gift_slider.confirm_button"]?.trim();
  return {
    free: free || GIFT_SLIDER_LABEL_DEFAULTS.free,
    outOfStock: outOfStock || GIFT_SLIDER_LABEL_DEFAULTS.outOfStock,
    ...(confirm ? { confirm } : {}),
    selectPrompt: GIFT_SLIDER_LABEL_DEFAULTS.selectPrompt,
    remove: GIFT_SLIDER_LABEL_DEFAULTS.remove,
    replaces: GIFT_SLIDER_LABEL_DEFAULTS.replaces,
  };
}

/** Loads this shop's merchant-configured widget strings for a locale (same
 * appSettings row app.translation.tsx writes to), with language-prefix and
 * English fallback. */
export async function loadGiftSliderTranslations(
  shopId: string,
  locale = "en",
): Promise<Partial<WidgetTranslations> | null> {
  const rows = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "translations.strings")))
    .limit(1);
  if (!rows[0]) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rows[0].value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const byLocale = parsed as Record<string, Partial<WidgetTranslations> | undefined>;
  const prefix = locale.split("-")[0];
  return byLocale[locale] ?? (prefix ? byLocale[prefix] : undefined) ?? byLocale["en"] ?? null;
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
  _cartLines: Array<{ variantId: string; properties: Record<string, string> }> = [],
  labelOverrides?: Partial<WidgetTranslations> | null,
): GiftSliderPayload | null {
  if (!payload || payload.selectableGifts.length === 0) return payload;

  const offer = offerDefinitions.find((definition) => definition.id === payload.offerId);
  const rewardById = new Map(offer?.rewards.map((reward) => [reward.id, reward]) ?? []);

  const enriched = payload.selectableGifts.map((gift) => {
    const variant = catalog.get(gift.variantId);
    const originalPriceCents = variant ? Math.max(0, Math.round(Number(variant.price) * 100)) : 0;
    return {
      ...gift,
      productId: variant?.productGid ?? gift.productId,
      title: variant?.productTitle ?? gift.title,
      variantTitle:
        variant?.variantTitle === "Default Title" ? null : (variant?.variantTitle ?? gift.variantTitle),
      imageUrl: variant?.imageUrl ?? gift.imageUrl,
      // Lets the storefront re-check live stock via /products/{handle}.js �
      // the variant cache is webhook-fed and can lag a sale by minutes.
      productHandle: variant?.productHandle ?? null,
      originalPriceCents,
      discountedPriceCents: priceAfterReward(rewardById.get(gift.rewardId), originalPriceCents),
      isAvailable: isGiftVariantAvailable(variant),
    };
  });

  // Per reward (tier): fallbacks are dormant while any primary can be chosen. A sold-out primary
  // next to in-stock ones is replaced by the next in-stock fallback; when every primary is sold
  // out the reward is offered as its in-stock fallbacks instead of dead cards. With no in-stock
  // fallback the dead cards stay, flagged unavailable, and the storefront declines to open.
  const selectableGifts = [...new Set(enriched.map((gift) => gift.rewardId))].flatMap((rewardId) => {
    const own = enriched.filter((gift) => gift.rewardId === rewardId);
    const primaries = own.filter((gift) => !gift.isFallback);
    const fallbacks = own.filter((gift) => gift.isFallback);
    const usableFallbacks = fallbacks.filter((gift) => gift.isAvailable);
    const replaces = primaries[0]?.title;
    if (primaries.some((gift) => gift.isAvailable || gift.isSelected)) {
      const spare = [...usableFallbacks];
      const shown = primaries.map((gift) => {
        const fallback = gift.isAvailable || gift.isSelected ? undefined : spare.shift();
        if (!fallback) return gift;
        const { isFallback: _dormant, ...promoted } = fallback;
        return { ...promoted, replacesTitle: gift.title };
      });
      return [...shown, ...fallbacks.filter((gift) => !shown.some((s) => s.variantId === gift.variantId))];
    }
    if (usableFallbacks.length === 0) return own;
    return usableFallbacks.map((gift) => ({ ...gift, ...(replaces ? { replacesTitle: replaces } : {}) }));
  });

  return { ...payload, labels: resolveGiftSliderLabels(labelOverrides), selectableGifts };
}
