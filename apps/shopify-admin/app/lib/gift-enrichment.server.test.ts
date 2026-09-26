import { describe, expect, it } from "vitest";
import {
  collectGiftCatalogVariantIds,
  enrichGiftSlider,
  resolveSoldOutGiftAdds,
  type GiftCatalogRow,
} from "./gift-enrichment.server.js";
import type { OfferDefinition } from "@promo/rule-engine";
import type { GiftSliderPayload } from "@promo/shared-types";

function row(overrides: Partial<GiftCatalogRow> & { variantGid: string }): GiftCatalogRow {
  return {
    productGid: "gid://shopify/Product/1",
    variantTitle: "Default Title",
    price: "10.00",
    availableForSale: true,
    inventoryQuantity: 5,
    inventoryPolicy: "DENY",
    requiresSellingPlan: false,
    productTitle: "Product",
    imageUrl: null,
    productStatus: "ACTIVE",
    ...overrides,
  };
}

function offerWithFallback(offerId: string, rewardId: string, fallbackVariantIds: string[]): OfferDefinition {
  return {
    id: offerId,
    version: 1,
    type: "gift",
    priority: 1,
    stopLowerPriority: false,
    startsAt: null,
    endsAt: null,
    conditions: [],
    rewards: [{
      id: rewardId,
      rewardType: "product_gift",
      discountType: "free",
      value: {},
      target: { fallbackVariantIds },
      quantity: 1,
      isAutoAdd: true,
      isCustomerSelectable: false,
      trackMode: "variant",
      sortOrder: 0,
      label: null,
    }],
    combinationPolicy: {
      combinesWithOrderDiscounts: true,
      combinesWithProductDiscounts: true,
      combinesWithShippingDiscounts: true,
      stopLowerPriority: false,
      maxApplicationsPerCart: null,
      maxApplicationsPerCustomer: null,
    },
    giftValueCountsForOtherOffers: false,
  } as unknown as OfferDefinition;
}

describe("collectGiftCatalogVariantIds", () => {
  it("collects slider gift ids, their fallbacks, cart-add gift ids, and their fallbacks", () => {
    const offers = [offerWithFallback("offer-1", "reward-1", ["fallback-1"])];
    const slider: GiftSliderPayload = {
      offerId: "offer-1",
      title: "t",
      subtitle: null,
      currencyCode: "USD",
      selectableGifts: [{
        rewardId: "reward-1",
        offerVersion: 1,
        rewardMaxQuantity: 1,
        variantId: "slider-gift-1",
        productId: "p1",
        title: "t",
        variantTitle: null,
        imageUrl: null,
        originalPriceCents: 0,
        discountedPriceCents: 0,
        isAvailable: false,
        isSelected: false,
      }],
      maxSelectableCount: 1,
      alreadySelectedCount: 0,
    };
    const cartActions = [{
      action: "add_line",
      variantId: "cart-gift-1",
      properties: { _promo_engine_line_type: "gift", _promo_engine_offer_id: "offer-1", _promo_engine_reward_id: "reward-1" },
    }];

    const ids = collectGiftCatalogVariantIds(slider, cartActions as never, offers);
    expect(new Set(ids)).toEqual(new Set(["slider-gift-1", "fallback-1", "cart-gift-1"]));
  });

  it("returns no ids when there's no gift slider and no gift cart actions", () => {
    expect(collectGiftCatalogVariantIds(null, [], [])).toEqual([]);
  });
});

describe("resolveSoldOutGiftAdds", () => {
  const offers = [offerWithFallback("offer-1", "reward-1", ["fallback-1"])];

  it("keeps a gift add when the catalog has no entry for it (cache miss = available)", () => {
    const actions = [{ action: "add_line", variantId: "unknown", properties: { _promo_engine_line_type: "gift" } }];
    expect(resolveSoldOutGiftAdds(new Map(), actions as never, [])).toEqual(actions);
  });

  it("swaps a sold-out gift add for its first in-stock configured fallback", () => {
    const catalog = new Map([
      ["main-gift", row({ variantGid: "main-gift", availableForSale: false })],
      ["fallback-1", row({ variantGid: "fallback-1", availableForSale: true })],
    ]);
    const actions = [{
      action: "add_line",
      variantId: "main-gift",
      properties: { _promo_engine_line_type: "gift", _promo_engine_offer_id: "offer-1", _promo_engine_reward_id: "reward-1" },
    }];
    const result = resolveSoldOutGiftAdds(catalog, actions as never, offers);
    expect(result).toHaveLength(1);
    expect((result[0] as { variantId: string }).variantId).toBe("fallback-1");
  });

  it("drops a sold-out gift add with no in-stock fallback configured", () => {
    const catalog = new Map([["main-gift", row({ variantGid: "main-gift", availableForSale: false })]]);
    const actions = [{
      action: "add_line",
      variantId: "main-gift",
      properties: { _promo_engine_line_type: "gift", _promo_engine_offer_id: "offer-1", _promo_engine_reward_id: "reward-1" },
    }];
    expect(resolveSoldOutGiftAdds(catalog, actions as never, offers)).toEqual([]);
  });
});

describe("enrichGiftSlider", () => {
  it("marks a sold-out gift unavailable when no fallback is configured", () => {
    const catalog = new Map([["gift-1", row({ variantGid: "gift-1", availableForSale: false })]]);
    const payload: GiftSliderPayload = {
      offerId: "offer-1",
      title: "t",
      subtitle: null,
      currencyCode: "USD",
      selectableGifts: [{
        rewardId: "reward-1",
        offerVersion: 1,
        rewardMaxQuantity: 1,
        variantId: "gift-1",
        productId: "p1",
        title: "t",
        variantTitle: null,
        imageUrl: null,
        originalPriceCents: 0,
        discountedPriceCents: 0,
        isAvailable: false,
        isSelected: false,
      }],
      maxSelectableCount: 1,
      alreadySelectedCount: 0,
    };
    const result = enrichGiftSlider(catalog, payload, []);
    expect(result?.selectableGifts[0]?.isAvailable).toBe(false);
    expect(result?.selectableGifts[0]?.variantId).toBe("gift-1");
  });

  it("replaces a sold-out gift with its configured in-stock fallback", () => {
    const offers = [offerWithFallback("offer-1", "reward-1", ["fallback-1"])];
    const catalog = new Map([
      ["gift-1", row({ variantGid: "gift-1", availableForSale: false })],
      ["fallback-1", row({ variantGid: "fallback-1", availableForSale: true, price: "5.00" })],
    ]);
    const payload: GiftSliderPayload = {
      offerId: "offer-1",
      title: "t",
      subtitle: null,
      currencyCode: "USD",
      selectableGifts: [{
        rewardId: "reward-1",
        offerVersion: 1,
        rewardMaxQuantity: 1,
        variantId: "gift-1",
        productId: "p1",
        title: "Original",
        variantTitle: null,
        imageUrl: null,
        originalPriceCents: 0,
        discountedPriceCents: 0,
        isAvailable: false,
        isSelected: false,
      }],
      maxSelectableCount: 1,
      alreadySelectedCount: 0,
    };
    const result = enrichGiftSlider(catalog, payload, offers);
    const gift = result?.selectableGifts[0];
    expect(gift?.isAvailable).toBe(true);
    expect(gift?.variantId).toBe("fallback-1");
    // replacesTitle captures the sold-out gift's *catalog* title (set by the
    // enrichment pass just before the fallback swap), not the raw payload's
    // pre-enrichment title — matches the pre-existing two-pass behavior.
    expect(gift?.replacesTitle).toBe("Product");
  });
});
