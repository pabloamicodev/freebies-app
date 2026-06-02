import { describe, it, expect } from "vitest";
import { evaluateProductQuantityLimits } from "./product-quantity-limits.js";
import type { NormalizedCart } from "@promo/shared-types";

function makeCart(lines: Array<{ variantId: string; productId: string; quantity: number; vendor?: string; productType?: string }>): NormalizedCart {
  return {
    token: "t", id: null,
    lines: lines.map((l, i) => ({
      key: `k${i}`, variantId: l.variantId, productId: l.productId,
      quantity: l.quantity, priceCents: 2000, compareAtPriceCents: null,
      properties: {}, requiresSellingPlan: false, sellingPlanId: null,
      productHandle: "p", productTitle: "P", variantTitle: null,
      vendor: l.vendor ?? "V", productType: l.productType ?? "T",
      tags: [], collections: [],
      availableForSale: true, inventoryPolicy: "DENY", inventoryQuantity: 10,
    })),
    subtotalCents: 0, discountCodes: [], currencyCode: "USD",
    totalQuantity: lines.reduce((a, l) => a + l.quantity, 0),
  };
}

describe("evaluateProductQuantityLimits — AND", () => {
  it("passes when all limits satisfied", () => {
    const cart = makeCart([
      { variantId: "v1", productId: "p1", quantity: 2 },
      { variantId: "v2", productId: "p2", quantity: 1 },
    ]);
    const result = evaluateProductQuantityLimits(cart, {
      limits: [
        { trackMode: "product", targetId: "p1", minQuantity: 2 },
        { trackMode: "product", targetId: "p2", minQuantity: 1 },
      ],
      operator: "AND",
      excludeGiftLines: true,
    });
    expect(result.ok).toBe(true);
  });

  it("fails AND when one limit fails", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", quantity: 1 }]);
    const result = evaluateProductQuantityLimits(cart, {
      limits: [
        { trackMode: "product", targetId: "p1", minQuantity: 2 }, // fails: only 1
      ],
      operator: "AND",
      excludeGiftLines: true,
    });
    expect(result.ok).toBe(false);
  });

  it("excludes product with isExclude: true", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", quantity: 1 }]);
    const result = evaluateProductQuantityLimits(cart, {
      limits: [{ trackMode: "product", targetId: "p1", isExclude: true }],
      operator: "AND",
      excludeGiftLines: true,
    });
    expect(result.ok).toBe(false); // p1 is in cart, should be excluded
  });
});

describe("evaluateProductQuantityLimits — OR", () => {
  it("passes OR when any limit satisfied", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", quantity: 3 }]);
    const result = evaluateProductQuantityLimits(cart, {
      limits: [
        { trackMode: "product", targetId: "p-missing", minQuantity: 1 }, // fails
        { trackMode: "product", targetId: "p1", minQuantity: 2 }, // passes
      ],
      operator: "OR",
      excludeGiftLines: true,
    });
    expect(result.ok).toBe(true);
  });

  it("fails OR when no limits satisfied", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", quantity: 1 }]);
    const result = evaluateProductQuantityLimits(cart, {
      limits: [
        { trackMode: "product", targetId: "p-missing-1", minQuantity: 1 },
        { trackMode: "product", targetId: "p-missing-2", minQuantity: 1 },
      ],
      operator: "OR",
      excludeGiftLines: true,
    });
    expect(result.ok).toBe(false);
  });
});
