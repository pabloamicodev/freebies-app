import { describe, it, expect } from "vitest";
import { evaluateCartQuantity } from "./cart-quantity.js";
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

describe("evaluateCartQuantity", () => {
  it("passes when quantity is exactly at the min bound", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 1000, quantity: 3 }]);
    const result = evaluateCartQuantity(cart, { minQuantity: 3, includeGiftValues: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.actual).toBe(3);
  });

  it("fails when quantity is one below the min bound", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 1000, quantity: 2 }]);
    const result = evaluateCartQuantity(cart, { minQuantity: 3, includeGiftValues: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.actual).toBe(2);
  });

  it("passes when quantity is exactly at the max bound (inclusive)", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 1000, quantity: 5 }]);
    const result = evaluateCartQuantity(cart, { minQuantity: 1, maxQuantity: 5, includeGiftValues: false });
    expect(result.ok).toBe(true);
  });

  it("fails when quantity is one above the max bound", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 1000, quantity: 6 }]);
    const result = evaluateCartQuantity(cart, { minQuantity: 1, maxQuantity: 5, includeGiftValues: false });
    expect(result.ok).toBe(false);
  });

  it("treats minQuantity 0 as always satisfying the lower bound", () => {
    const cart = makeCart([]);
    const result = evaluateCartQuantity(cart, { minQuantity: 0, includeGiftValues: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.actual).toBe(0);
  });

  it("only the exact quantity qualifies when min equals max", () => {
    const condition = { minQuantity: 4, maxQuantity: 4, includeGiftValues: false };

    const below = makeCart([{ variantId: "v1", productId: "p1", priceCents: 1000, quantity: 3 }]);
    const exact = makeCart([{ variantId: "v1", productId: "p1", priceCents: 1000, quantity: 4 }]);
    const above = makeCart([{ variantId: "v1", productId: "p1", priceCents: 1000, quantity: 5 }]);

    expect(evaluateCartQuantity(below, condition).ok).toBe(false);
    expect(evaluateCartQuantity(exact, condition).ok).toBe(true);
    expect(evaluateCartQuantity(above, condition).ok).toBe(false);
  });

  it("only counts quantity from products in the include scope filter", () => {
    const cart = makeCart([
      { variantId: "v1", productId: "p1", priceCents: 1000, quantity: 2 },
      { variantId: "v2", productId: "p2", priceCents: 1000, quantity: 5 },
    ]);
    const result = evaluateCartQuantity(cart, {
      minQuantity: 3,
      includeGiftValues: false,
      scopeFilter: { productIds: ["p1"] },
    });
    // Only p1's quantity (2) counts, p2's 5 is out of scope — should fail the min of 3.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.actual).toBe(2);
  });

  it("excludes quantity from products in the exclude scope filter", () => {
    const cart = makeCart([
      { variantId: "v1", productId: "p1", priceCents: 1000, quantity: 2 },
      { variantId: "v2", productId: "p2", priceCents: 1000, quantity: 5 },
    ]);
    const result = evaluateCartQuantity(cart, {
      minQuantity: 3,
      includeGiftValues: false,
      scopeFilter: { excludeProductIds: ["p2"] },
    });
    // p2 (qty 5) is excluded, only p1's 2 counts — should fail the min of 3.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.actual).toBe(2);
  });

  it("excludeProductIds wins when a product is both excluded and included", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 1000, quantity: 5 }]);
    const result = evaluateCartQuantity(cart, {
      minQuantity: 1,
      includeGiftValues: false,
      scopeFilter: { productIds: ["p1"], excludeProductIds: ["p1"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.actual).toBe(0);
  });
});
