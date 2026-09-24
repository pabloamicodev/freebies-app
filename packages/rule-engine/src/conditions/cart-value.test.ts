import { describe, it, expect } from "vitest";
import { evaluateCartValue } from "./cart-value.js";
import type { NormalizedCart } from "@promo/shared-types";

function makeCart(lines: Array<{ variantId: string; productId: string; priceCents: number; quantity: number }>): NormalizedCart {
  return {
    token: "test-token",
    id: null,
    lines: lines.map((l, i) => ({
      key: `key-${i}`,
      variantId: l.variantId,
      productId: l.productId,
      quantity: l.quantity,
      priceCents: l.priceCents,
      compareAtPriceCents: null,
      properties: {},
      requiresSellingPlan: false,
      sellingPlanId: null,
      productHandle: "test-product",
      productTitle: "Test Product",
      variantTitle: null,
      vendor: "Test Vendor",
      productType: "apparel",
      tags: [],
      collections: [],
      availableForSale: true,
      inventoryPolicy: "DENY",
      inventoryQuantity: 10,
    })),
    subtotalCents: lines.reduce((a, l) => a + l.priceCents * l.quantity, 0),
    discountCodes: [],
    currencyCode: "USD",
    totalQuantity: lines.reduce((a, l) => a + l.quantity, 0),
  };
}

const currency = { activeCurrencyCode: "USD", shopCurrencyCode: "USD" };

describe("evaluateCartValue", () => {
  it("passes when cart value meets threshold", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 5000, quantity: 2 }]);
    const result = evaluateCartValue(cart, {
      thresholdCents: 10000,
      currencyCode: "USD",
      includeGiftValues: false,
    }, currency);
    expect(result.ok).toBe(true);
  });

  it("fails when cart value is below threshold", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 2000, quantity: 1 }]);
    const result = evaluateCartValue(cart, {
      thresholdCents: 5000,
      currencyCode: "USD",
      includeGiftValues: false,
    }, currency);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.conditionType).toBe("cart_value");
      expect(result.error.actual).toBe(2000);
    }
  });

  it("uses final discounted line subtotals instead of original unit prices", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 5000, quantity: 2 }]);
    cart.lines[0]!.lineSubtotalCents = 8000;
    cart.subtotalCents = 8000;

    const result = evaluateCartValue(cart, {
      thresholdCents: 9000,
      currencyCode: "USD",
      includeGiftValues: false,
    }, currency);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.actual).toBe(8000);
  });

  it("excludes gift lines from qualifying value by default", () => {
    const cart: NormalizedCart = {
      ...makeCart([{ variantId: "v1", productId: "p1", priceCents: 5000, quantity: 2 }]),
      lines: [
        {
          key: "key-0",
          variantId: "v1",
          productId: "p1",
          quantity: 2,
          priceCents: 5000,
          compareAtPriceCents: null,
          properties: {},
          requiresSellingPlan: false,
          sellingPlanId: null,
          productHandle: "test",
          productTitle: "Test",
          variantTitle: null,
          vendor: "V",
          productType: "t",
          tags: [],
          collections: [],
          availableForSale: true,
          inventoryPolicy: "DENY",
          inventoryQuantity: 10,
        },
        {
          key: "gift-key",
          variantId: "gift-v1",
          productId: "gift-p1",
          quantity: 1,
          priceCents: 3000, // should NOT be counted
          compareAtPriceCents: null,
          properties: { _promo_engine_line_type: "gift", _promo_engine_offer_id: "offer-1", _promo_engine_reward_id: "r1", _promo_engine_offer_version: "1", _promo_engine_hash: "abc" },
          requiresSellingPlan: false,
          sellingPlanId: null,
          productHandle: "gift",
          productTitle: "Gift",
          variantTitle: null,
          vendor: "V",
          productType: "t",
          tags: [],
          collections: [],
          availableForSale: true,
          inventoryPolicy: "DENY",
          inventoryQuantity: 5,
        },
      ],
    };

    const result = evaluateCartValue(cart, {
      thresholdCents: 10000,
      currencyCode: "USD",
      includeGiftValues: false,
    }, currency);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.actual).toBe(10000); // 5000 × 2 only
  });

  it.each([
    ["legacy cart gift tier", { __cart_gift_tier: "tier-1" }],
    ["quiz free gift", { _quiz_free_gift: "true" }],
  ])("excludes %s lines from qualifying value", (_label, properties) => {
    const cart = makeCart([
      { variantId: "paid-v1", productId: "paid-p1", priceCents: 4000, quantity: 1 },
      { variantId: "gift-v1", productId: "gift-p1", priceCents: 2000, quantity: 1 },
    ]);
    cart.lines[1]!.properties = properties;

    const excluded = evaluateCartValue(cart, {
      thresholdCents: 5000,
      currencyCode: "USD",
      includeGiftValues: false,
    }, currency);
    const explicitlyIncluded = evaluateCartValue(cart, {
      thresholdCents: 5000,
      currencyCode: "USD",
      includeGiftValues: true,
    }, currency);

    expect(excluded.ok).toBe(false);
    expect(explicitlyIncluded.ok).toBe(true);
  });

  it("applies currency override when active currency differs from store currency", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 5000, quantity: 2 }]);
    // Override for EUR is 8000 cents — cart is 10000 → passes
    const result = evaluateCartValue(cart, {
      thresholdCents: 12000,
      currencyCode: "USD",
      currencyOverrides: { EUR: 8000 },
      includeGiftValues: false,
    }, { activeCurrencyCode: "EUR", shopCurrencyCode: "USD" });
    expect(result.ok).toBe(true);
  });

  it("treats maxCents as an inclusive upper bound", () => {
    const atMaximum = makeCart([{ variantId: "v1", productId: "p1", priceCents: 9999, quantity: 1 }]);
    const aboveMaximum = makeCart([{ variantId: "v1", productId: "p1", priceCents: 10000, quantity: 1 }]);
    const condition = {
      thresholdCents: 5000,
      maxCents: 9999,
      currencyCode: "USD",
      includeGiftValues: false,
    };

    expect(evaluateCartValue(atMaximum, condition, currency).ok).toBe(true);
    expect(evaluateCartValue(aboveMaximum, condition, currency).ok).toBe(false);
  });

  it("converts maxCents with the same exchange rate as the minimum", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 7500, quantity: 1 }]);
    const condition = {
      thresholdCents: 5000,
      maxCents: 6000,
      currencyCode: "USD",
      includeGiftValues: false,
    };

    expect(evaluateCartValue(cart, condition, {
      activeCurrencyCode: "EUR",
      shopCurrencyCode: "USD",
      exchangeRate: 1.2,
    }).ok).toBe(false);
  });

  it("prefers a configured max override for the active currency", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 8500, quantity: 1 }]);
    const condition = {
      thresholdCents: 5000,
      maxCents: 9999,
      currencyCode: "USD",
      currencyOverrides: { EUR: 7000 },
      maxCurrencyOverrides: { EUR: 8000 },
      includeGiftValues: false,
    };

    expect(evaluateCartValue(cart, condition, {
      activeCurrencyCode: "EUR",
      shopCurrencyCode: "USD",
    }).ok).toBe(false);
  });
});
