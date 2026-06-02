import { describe, it, expect } from "vitest";
import { evaluateCartValueMultiplier } from "./cart-value-multiplier.js";
import type { NormalizedCart } from "@promo/shared-types";

function makeCart(subtotalCents: number): NormalizedCart {
  return {
    token: "t", id: null,
    lines: [{
      key: "k0", variantId: "v1", productId: "p1",
      quantity: 1, priceCents: subtotalCents, compareAtPriceCents: null,
      properties: {}, requiresSellingPlan: false, sellingPlanId: null,
      productHandle: "p", productTitle: "P", variantTitle: null,
      vendor: "V", productType: "T", tags: [], collections: [],
      availableForSale: true, inventoryPolicy: "DENY", inventoryQuantity: 10,
    }],
    subtotalCents,
    discountCodes: [], currencyCode: "USD", totalQuantity: 1,
  };
}

const currency = { activeCurrencyCode: "USD", shopCurrencyCode: "USD" };

describe("evaluateCartValueMultiplier", () => {
  it("returns multiplier 1 when cart exactly meets threshold", () => {
    const cart = makeCart(5000); // $50
    const result = evaluateCartValueMultiplier(cart, {
      thresholdCents: 5000, currencyCode: "USD", includeGiftValues: false,
    }, currency);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.multiplier).toBe(1);
  });

  it("returns multiplier 3 for 3x threshold", () => {
    const cart = makeCart(15000); // $150
    const result = evaluateCartValueMultiplier(cart, {
      thresholdCents: 5000, currencyCode: "USD", includeGiftValues: false,
    }, currency);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.multiplier).toBe(3);
  });

  it("returns 0 (fail) when below threshold", () => {
    const cart = makeCart(3000); // $30 < $50
    const result = evaluateCartValueMultiplier(cart, {
      thresholdCents: 5000, currencyCode: "USD", includeGiftValues: false,
    }, currency);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.conditionType).toBe("cart_value_multiplier");
  });

  it("caps multiplier at maxMultiplier", () => {
    const cart = makeCart(20000); // $200 = 4x $50
    const result = evaluateCartValueMultiplier(cart, {
      thresholdCents: 5000, currencyCode: "USD", includeGiftValues: false, maxMultiplier: 2,
    }, currency);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.multiplier).toBe(2);
  });

  it("floors the division (partial threshold does not earn a gift)", () => {
    const cart = makeCart(7499); // $74.99 — just under 1.5x
    const result = evaluateCartValueMultiplier(cart, {
      thresholdCents: 5000, currencyCode: "USD", includeGiftValues: false,
    }, currency);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.multiplier).toBe(1); // floor(74.99/50) = 1
  });
});
