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

type Gift = GiftSliderPayload["selectableGifts"][number];
const gift = (variantId: string, over: Partial<Gift> = {}): Gift => ({
  rewardId: "reward-1",
  offerVersion: 1,
  rewardMaxQuantity: 1,
  variantId,
  productId: "p1",
  title: "Tee",
  variantTitle: null,
  imageUrl: null,
  originalPriceCents: 0,
  discountedPriceCents: 0,
  isAvailable: true,
  isSelected: false,
  ...over,
});
const sliderPayload = (selectableGifts: Gift[], offerId = "offer-1"): GiftSliderPayload => ({
  offerId,
  title: "t",
  subtitle: null,
  currencyCode: "USD",
  selectableGifts,
  maxSelectableCount: 1,
  alreadySelectedCount: 0,
});
const fb = (variantId: string, over: Partial<Gift> = {}) => gift(variantId, { isFallback: true, ...over });
const catalogOf = (...rows: GiftCatalogRow[]) => new Map(rows.map((r) => [r.variantGid, r]));

describe("enrichGiftSlider", () => {
  it("marks a sold-out gift unavailable when no fallback is configured", () => {
    const catalog = catalogOf(row({ variantGid: "gift-1", availableForSale: false, productHandle: "tee" }));
    const result = enrichGiftSlider(catalog, sliderPayload([gift("gift-1", { isAvailable: false })]), []);
    expect(result?.selectableGifts[0]?.isAvailable).toBe(false);
    expect(result?.selectableGifts[0]?.variantId).toBe("gift-1");
    // The storefront re-checks live stock via /products/{handle}.js.
    expect(result?.selectableGifts[0]?.productHandle).toBe("tee");
  });

  it("T-shirt out of stock, fallback in stock: offers the fallback as a selectable gift", () => {
    const catalog = catalogOf(
      row({ variantGid: "gift-1", availableForSale: false }),
      row({ variantGid: "fallback-1", availableForSale: true, price: "5.00", productTitle: "Backup Tee" }),
    );
    const result = enrichGiftSlider(catalog, sliderPayload([gift("gift-1"), fb("fallback-1")]), []);
    expect(result?.selectableGifts).toHaveLength(1);
    const offered = result!.selectableGifts[0]!;
    expect(offered).toMatchObject({ variantId: "fallback-1", isAvailable: true, title: "Backup Tee", originalPriceCents: 500 });
    expect(offered.replacesTitle).toBe("Product");
  });

  describe("multi-variant gift, every variant sold out", () => {
    const primaries = () => ["a", "b", "c"].map((id) => gift(id));

    it("offers only the in-stock fallbacks, not dead primary cards", () => {
      const catalog = catalogOf(
        ...["a", "b", "c"].map((id) => row({ variantGid: id, availableForSale: false })),
        row({ variantGid: "f1" }),
        row({ variantGid: "f2" }),
        row({ variantGid: "f3", availableForSale: false }),
      );
      const result = enrichGiftSlider(catalog, sliderPayload([...primaries(), fb("f1"), fb("f2"), fb("f3")]), []);
      expect(result?.selectableGifts.map((g) => [g.variantId, g.isAvailable])).toEqual([
        ["f1", true],
        ["f2", true],
      ]);
    });

    it("keeps primaries and dormant fallbacks when the cache wrongly says in stock", () => {
      const catalog = catalogOf(
        ...["a", "b", "c"].map((id) => row({ variantGid: id })),
        row({ variantGid: "f1", productHandle: "other" }),
        row({ variantGid: "f2", availableForSale: false }),
      );
      const result = enrichGiftSlider(catalog, sliderPayload([...primaries(), fb("f1"), fb("f2")]), []);
      expect(result?.selectableGifts.map((g) => [g.variantId, g.isAvailable, !!g.isFallback])).toEqual([
        ["a", true, false],
        ["b", true, false],
        ["c", true, false],
        ["f1", true, true],
        ["f2", false, true],
      ]);
      expect(result?.selectableGifts[3]?.productHandle).toBe("other");
    });

    it("keeps everything flagged unavailable (storefront hides it) when no fallback is in stock", () => {
      const catalog = catalogOf(
        ...["a", "b", "c"].map((id) => row({ variantGid: id, availableForSale: false })),
        row({ variantGid: "f1", availableForSale: false }),
      );
      const result = enrichGiftSlider(catalog, sliderPayload([...primaries(), fb("f1")]), []);
      expect(result?.selectableGifts).toHaveLength(4);
      expect(result?.selectableGifts.every((g) => !g.isAvailable)).toBe(true);
    });
  });

  it("swaps a single sold-out size for a fallback while other sizes stay in stock", () => {
    const catalog = catalogOf(
      row({ variantGid: "a", availableForSale: false }),
      row({ variantGid: "b" }),
      row({ variantGid: "f1" }),
    );
    const result = enrichGiftSlider(catalog, sliderPayload([gift("a"), gift("b"), fb("f1")]), []);
    expect(result?.selectableGifts.map((g) => [g.variantId, !!g.isFallback])).toEqual([
      ["f1", false],
      ["b", false],
    ]);
  });

  it("resolves each reward (tier) of an offer independently", () => {
    const catalog = catalogOf(
      row({ variantGid: "a", availableForSale: false }),
      row({ variantGid: "f1" }),
      row({ variantGid: "b" }),
      row({ variantGid: "g1" }),
    );
    const result = enrichGiftSlider(
      catalog,
      sliderPayload([
        gift("a"),
        fb("f1"),
        gift("b", { rewardId: "reward-2" }),
        fb("g1", { rewardId: "reward-2" }),
      ]),
      [],
    );
    expect(result?.selectableGifts.map((g) => [g.rewardId, g.variantId, !!g.isFallback])).toEqual([
      ["reward-1", "f1", true],
      ["reward-2", "b", false],
      ["reward-2", "g1", true],
    ]);
  });
});
