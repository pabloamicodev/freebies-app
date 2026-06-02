import { describe, it, expect } from "vitest";
import { evaluateBogo } from "./bogo.js";
import type { NormalizedCart } from "@promo/shared-types";

function makeCart(lines: Array<{ variantId: string; productId: string; quantity: number }>): NormalizedCart {
  return {
    token: "t", id: null,
    lines: lines.map((l, i) => ({
      key: `k${i}`, variantId: l.variantId, productId: l.productId,
      quantity: l.quantity, priceCents: 2000, compareAtPriceCents: null,
      properties: {}, requiresSellingPlan: false, sellingPlanId: null,
      productHandle: "p", productTitle: "P", variantTitle: null,
      vendor: "V", productType: "T", tags: [], collections: [],
      availableForSale: true, inventoryPolicy: "DENY", inventoryQuantity: 10,
    })),
    subtotalCents: lines.reduce((a) => a + 2000, 0),
    discountCodes: [], currencyCode: "USD",
    totalQuantity: lines.reduce((a, l) => a + l.quantity, 0),
  };
}

describe("evaluateBogo — BOGO self-gift", () => {
  it("qualifies when trigger product meets min qty", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", quantity: 2 }]);
    const result = evaluateBogo(cart, {
      mode: "bogo_self",
      triggerProductId: "p1",
      triggerTrackMode: "product",
      triggerMinQuantity: 2,
      giftProductId: "p1",
      giftQuantity: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.qualifiedGroups).toBe(1);
  });

  it("fails when trigger product qty is insufficient", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", quantity: 1 }]);
    const result = evaluateBogo(cart, {
      mode: "bogo_self",
      triggerProductId: "p1",
      triggerTrackMode: "product",
      triggerMinQuantity: 2,
      giftProductId: "p1",
      giftQuantity: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("returns multiple groups when buying 4 of trigger (min 2 per group)", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", quantity: 4 }]);
    const result = evaluateBogo(cart, {
      mode: "bogo_self",
      triggerProductId: "p1",
      triggerTrackMode: "product",
      triggerMinQuantity: 2,
      giftProductId: "p1",
      giftQuantity: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.qualifiedGroups).toBe(2);
  });
});

describe("evaluateBogo — Buy X Get Y", () => {
  it("qualifies BXGY when trigger product present", () => {
    const cart = makeCart([
      { variantId: "v1", productId: "hat", quantity: 2 },
      { variantId: "v2", productId: "scarf", quantity: 0 }, // scarf not yet in cart
    ]);
    const result = evaluateBogo(cart, {
      mode: "bxgy",
      triggerProductId: "hat",
      triggerTrackMode: "product",
      triggerMinQuantity: 2,
      giftProductId: "scarf",
      giftQuantity: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.qualifiedGroups).toBe(1);
      expect(result.value.triggerQuantityInCart).toBe(2);
    }
  });
});
