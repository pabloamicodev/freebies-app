import { describe, expect, it } from "vitest";
import { buildCartValidationConfig } from "./cart-validation.server.js";
import type { CompiledOffer } from "./sync/compile-config.js";

function compiledOffer(overrides: Partial<CompiledOffer> = {}): CompiledOffer {
  return {
    id: "offer-1",
    version: 4,
    offerType: "gift",
    priority: 1,
    stopLowerPriority: false,
    requiredProductIds: [],
    requiredVariantIds: [],
    excludedProductIds: [],
    giftVariantIds: [],
    giftProductIds: [],
    discountType: "free",
    discountValue: 100,
    currencyCode: "USD",
    combinesWithOrderDiscounts: true,
    combinesWithShippingDiscounts: true,
    combinesWithProductDiscounts: true,
    requirements: [],
    giftRewards: [],
    productRewards: [],
    orderRewards: [],
    ...overrides,
  };
}

describe("buildCartValidationConfig", () => {
  it("binds every gift variant to its exact offer, reward, version, and quantity", () => {
    const config = buildCartValidationConfig([
      compiledOffer({
        giftRewards: [
          {
            id: "reward-1",
            targetProductIds: ["gid://shopify/Product/1"],
            targetVariantIds: ["gid://shopify/ProductVariant/2", "gid://shopify/ProductVariant/1"],
            discountType: "free",
            discountValue: 100,
            maxQuantity: 2,
          },
          {
            id: "reward-2",
            targetProductIds: [],
            targetVariantIds: ["gid://shopify/ProductVariant/2"],
            discountType: "percentage",
            discountValue: 50,
            maxQuantity: 1,
          },
        ],
      }),
    ]);

    expect(config.offerRules["offer-1"]).toEqual({
      version: 4,
      maxQuantity: 3,
      rewards: {
        "reward-1": {
          maxQuantity: 2,
          variantIds: ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"],
        },
        "reward-2": {
          maxQuantity: 1,
          variantIds: ["gid://shopify/ProductVariant/2"],
        },
      },
    });
    expect(config.offerMaxQuantities).toEqual({ "offer-1": 3 });
    expect(config.allowedGiftVariantIds).toEqual([
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);
    expect(config.cloneProductIds).toEqual(["gid://shopify/Product/1"]);
  });

  it("does not create validation allowances for promotions without gifts", () => {
    const config = buildCartValidationConfig([
      compiledOffer({
        offerType: "discount",
        productRewards: [
          {
            id: "product-reward",
            targetProductIds: [],
            targetVariantIds: ["gid://shopify/ProductVariant/99"],
            discountType: "percentage",
            discountValue: 10,
            subscriptionMode: "any",
            scopeMode: "sitewide",
            requiredAnchorVariantIds: [],
            requiredAnchorMinQuantity: 1,
            requiresAnchorSubscription: false,
            priceTiers: [],
            quantityTiers: [],
            selectionMode: "all",
            countRule: "all",
            discountPercentageOnGifts: 100,
          },
        ],
      }),
    ]);

    expect(config.offerRules).toEqual({});
    expect(config.allowedGiftVariantIds).toEqual([]);
  });
});
