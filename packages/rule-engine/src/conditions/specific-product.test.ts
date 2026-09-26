import { describe, it, expect } from "vitest";
import { evaluateSpecificProduct } from "./specific-product.js";
import type { NormalizedCart } from "@promo/shared-types";

function makeCart(lines: Array<{ variantId: string; productId: string; quantity: number }>): NormalizedCart {
  return {
    token: "test-token",
    id: null,
    lines: lines.map((l, i) => ({
      key: `key-${i}`,
      variantId: l.variantId,
      productId: l.productId,
      quantity: l.quantity,
      priceCents: 1000,
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
    subtotalCents: lines.reduce((a, l) => a + l.quantity * 1000, 0),
    discountCodes: [],
    currencyCode: "USD",
    totalQuantity: lines.reduce((a, l) => a + l.quantity, 0),
  };
}

describe("evaluateSpecificProduct with operator 'all' (default)", () => {
  it("fails unless every requirement is met", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", quantity: 2 }]);
    const result = evaluateSpecificProduct(cart, {
      requirements: [
        { productId: "p1", variantId: "v1", trackMode: "variant", minQuantity: 1 },
        { productId: "p2", variantId: "v2", trackMode: "variant", minQuantity: 1 },
      ],
      multiplyByGroups: false,
    });
    expect(result.ok).toBe(false);
  });

  it("passes when every requirement is met", () => {
    const cart = makeCart([
      { variantId: "v1", productId: "p1", quantity: 1 },
      { variantId: "v2", productId: "p2", quantity: 1 },
    ]);
    const result = evaluateSpecificProduct(cart, {
      requirements: [
        { productId: "p1", variantId: "v1", trackMode: "variant", minQuantity: 1 },
        { productId: "p2", variantId: "v2", trackMode: "variant", minQuantity: 1 },
      ],
      multiplyByGroups: false,
    });
    expect(result.ok).toBe(true);
  });
});

describe("evaluateSpecificProduct with operator 'any'", () => {
  const condition = {
    requirements: [
      { productId: "p1", variantId: "v1", trackMode: "variant" as const, minQuantity: 1 },
      { productId: "p2", variantId: "v2", trackMode: "variant" as const, minQuantity: 1 },
    ],
    multiplyByGroups: false,
  };

  it("fails when none of the trigger products/variants are present", () => {
    const cart = makeCart([{ variantId: "v3", productId: "p3", quantity: 5 }]);
    expect(evaluateSpecificProduct(cart, condition, "any").ok).toBe(false);
  });

  it("passes when only one of the trigger products/variants is present", () => {
    const cart = makeCart([{ variantId: "v2", productId: "p2", quantity: 1 }]);
    const result = evaluateSpecificProduct(cart, condition, "any");
    expect(result.ok).toBe(true);
  });

  it("does not require every requirement to pass, unlike operator 'all'", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", quantity: 1 }]);
    expect(evaluateSpecificProduct(cart, condition, "all").ok).toBe(false);
    expect(evaluateSpecificProduct(cart, condition, "any").ok).toBe(true);
  });
});
